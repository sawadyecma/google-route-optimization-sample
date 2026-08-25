/**
 * Route Optimization API を「ソルバーとしてだけ」使うサンプル。
 *
 * 移動時間・距離は Google に計算させず、自前で作った行列を注入する（durationDistanceMatrices）。
 * API に渡すのは「地点間の移動コスト表」と「制約」だけで、返るのは「訪問順と時刻」だけ。
 * 詳しい調査結果は docs/solver-only-mode.md を参照。
 */
import dotenv from 'dotenv';
import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

dotenv.config();

const PROJECT_ID = process.env.GOOGLE_PROJECT_ID;

// ---------------------------------------------------------------------------
// 東京都庁を拠点に、県庁所在地＋高輪・燕市を回る 10 地点。
// 座標は代表点（概数）。行列を自前計算するために持っているだけで、
// API には一切送らない（送ると geolocations are incompatible ... で 400 になる）。
// ---------------------------------------------------------------------------
type Place = { tag: string; name: string; lat: number; lng: number };

const PLACES: Place[] = [
  { tag: 'loc-tokyo', name: '東京都庁', lat: 35.6896, lng: 139.6917 },
  { tag: 'loc-takanawa', name: '高輪（港区）', lat: 35.6284, lng: 139.7387 },
  { tag: 'loc-kanagawa', name: '神奈川県庁', lat: 35.4437, lng: 139.638 },
  { tag: 'loc-shizuoka', name: '静岡県庁', lat: 34.9769, lng: 138.3831 },
  { tag: 'loc-aichi', name: '愛知県庁', lat: 35.1802, lng: 136.9066 },
  { tag: 'loc-kyoto', name: '京都府庁', lat: 35.0212, lng: 135.7556 },
  { tag: 'loc-ishikawa', name: '石川県庁', lat: 36.5947, lng: 136.6256 },
  { tag: 'loc-tsubame', name: '新潟県燕市', lat: 37.6717, lng: 138.8828 },
  { tag: 'loc-nagano', name: '長野県庁', lat: 36.6513, lng: 138.181 },
  { tag: 'loc-gunma', name: '群馬県庁', lat: 36.3895, lng: 139.0634 },
];


// 行列生成パラメータ（本番なら OSRM / Valhalla などの経路エンジンに置き換える）
const DETOUR_FACTOR = 1.35; // 直線距離 → 道路距離の補正
const SPEED_MPS = 60_000 / 3600; // 平均 60km/h（都市間移動なので高速道路込みを想定）

// 自前行列だからできること: 特定方向だけ割高にする（一方通行・上り坂・混雑方向など）
// [出発タグ, 到着タグ, 倍率]
// `--no-penalty` を付けて実行すると対称行列になり、ペナルティの効果を比較できる
const NO_PENALTY = process.argv.includes('--no-penalty');

const DIRECTIONAL_PENALTIES: [string, string, number][] = NO_PENALTY
  ? []
  : [
      // ペナルティなしの最適解が実際に通る向きを重くしてある。
      // 対称行列では周回の向きを反転してもコストが同じなので、片方向だけ重くすると
      // 解全体が逆回りに反転する = 非対称行列が効いていることが目で見える。
      ['loc-kanagawa', 'loc-shizuoka', 3.0], // 横浜 → 静岡（東名の下り方向が混む想定）
      ['loc-kyoto', 'loc-ishikawa', 3.0], // 京都 → 金沢
    ];


const VISIT_DURATION = '900s'; // 各訪問の作業時間 15 分
// 10 都県を 1 台で回ると 1 日では終わらないため、全体時間枠は 2 日ぶん取る
const GLOBAL_START = '2026-03-02T08:00:00+09:00';
const GLOBAL_END = '2026-03-04T08:00:00+09:00';

// ---------------------------------------------------------------------------
// 行列生成
// ---------------------------------------------------------------------------
function haversineMeters(a: Place, b: Place): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

type Matrix = { rows: { durations: string[]; meters: number[] }[]; asymmetricCells: number };

function buildMatrix(places: Place[]): Matrix {
  const penalty = new Map(DIRECTIONAL_PENALTIES.map(([s, d, f]) => [`${s}>${d}`, f]));
  const meters: number[][] = [];
  const seconds: number[][] = [];

  for (let i = 0; i < places.length; i++) {
    meters[i] = [];
    seconds[i] = [];
    for (let j = 0; j < places.length; j++) {
      if (i === j) {
        meters[i][j] = 0;
        seconds[i][j] = 0;
        continue;
      }
      const factor = penalty.get(`${places[i].tag}>${places[j].tag}`) ?? 1;
      const m = haversineMeters(places[i], places[j]) * DETOUR_FACTOR * factor;
      meters[i][j] = Math.round(m);
      seconds[i][j] = Math.round(m / SPEED_MPS);
    }
  }

  let asymmetricCells = 0;
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      if (seconds[i][j] !== seconds[j][i]) asymmetricCells++;
    }
  }

  return {
    rows: places.map((_, i) => ({
      durations: seconds[i].map((s) => `${s}s`),
      meters: meters[i],
    })),
    asymmetricCells,
  };
}

// ---------------------------------------------------------------------------
// リクエスト組み立て
// ---------------------------------------------------------------------------
function buildRequest(places: Place[], matrix: Matrix) {
  const tags = places.map((p) => p.tag);
  const depot = places[0];
  const stops = places.slice(1);

  return {
    timeout: '10s',
    // populatePolylines / considerRoadTraffic は行列モードでは 400 になるので付けない
    model: {
      globalStartTime: GLOBAL_START,
      globalEndTime: GLOBAL_END,
      // src/dst タグの並びが行列の行/列に対応する。
      // ここに「実際には誰も使わないタグ」を混ぜると 400（index #n is missing）になる
      durationDistanceMatrixSrcTags: tags,
      durationDistanceMatrixDstTags: tags,
      durationDistanceMatrices: [{ rows: matrix.rows }],
      shipments: stops.map((p) => ({
        label: p.name,
        // 座標ではなく tags で行列の行/列に紐づける
        deliveries: [{ tags: [p.tag], duration: VISIT_DURATION }],
      })),
      vehicles: [
        {
          label: '配送車1',
          startTags: [depot.tag],
          endTags: [depot.tag],
          costPerHour: 3000,
          costPerKilometer: 40,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// 結果表示
// ---------------------------------------------------------------------------
const fmtDur = (v?: string) => {
  const s = Number((v ?? '0s').replace('s', ''));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
};
const JST = 'Asia/Tokyo';
const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', timeZone: JST });
// 日をまたぐ行程では時刻だけだと読めないので、出発日と違う日は M/D を添える
const fmtTime = (iso?: string, base?: string) => {
  if (!iso) return '-';
  const t = new Date(iso).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: JST,
  });
  return base && dateOf(iso) !== dateOf(base) ? `${dateOf(iso)} ${t}` : `　　${t}`;
};

function printResult(places: Place[], response: any) {
  const route = response.routes?.[0];
  if (!route) {
    console.log('ルートが返りませんでした');
    return;
  }

  const depot = places[0];
  const stops = places.slice(1);

  console.log('\n=== 最適化された訪問順 ===');
  const base = route.vehicleStartTime;
  console.log(`  ${fmtTime(base, base)}  ${depot.name}（出発）`);

  const visits = route.visits ?? [];
  const transitions = route.transitions ?? [];
  visits.forEach((v: any, i: number) => {
    // shipmentIndex は 0 のとき省略されるので ?? 0 が必須
    const place = stops[v.shipmentIndex ?? 0];
    const leg = transitions[i];
    const legInfo = leg
      ? `移動 ${fmtDur(leg.travelDuration)} / ${((leg.travelDistanceMeters ?? 0) / 1000).toFixed(1)}km`
      : '';
    console.log(
      `  ${fmtTime(v.startTime, base)}  ${String(i + 1).padStart(2, ' ')}. ${place.name.padEnd(12, '　')} ${legInfo}`,
    );
  });

  const last = transitions[transitions.length - 1];
  const backInfo = last
    ? `移動 ${fmtDur(last.travelDuration)} / ${((last.travelDistanceMeters ?? 0) / 1000).toFixed(1)}km`
    : '';
  console.log(`  ${fmtTime(route.vehicleEndTime, base)}  ${depot.name}（帰着）${backInfo ? ' ' + backInfo : ''}`);

  const m = route.metrics ?? {};
  console.log('\n=== サマリ ===');
  console.log(`  訪問数        : ${m.performedShipmentCount ?? 0} / ${stops.length}`);
  console.log(`  移動時間      : ${fmtDur(m.travelDuration)}`);
  console.log(`  作業時間      : ${fmtDur(m.visitDuration)}`);
  console.log(`  待機時間      : ${fmtDur(m.waitDuration)}`);
  console.log(`  拘束時間合計  : ${fmtDur(m.totalDuration)}`);
  console.log(`  走行距離      : ${((m.travelDistanceMeters ?? 0) / 1000).toFixed(1)} km`);
  console.log(`  総コスト      : ${response.metrics?.totalCost?.toFixed(1) ?? '-'}`);
  const costs = response.metrics?.costs ?? {};
  Object.entries(costs).forEach(([k, v]) => {
    console.log(`    - ${k}: ${(v as number).toFixed(1)}`);
  });

  const skipped = response.skippedShipments ?? [];
  if (skipped.length) {
    console.log(`\n  スキップ: ${skipped.map((s: any) => stops[s.index ?? 0].name).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
async function getAuthToken(): Promise<string> {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken?.token) throw new Error('アクセストークンの取得に失敗しました');
  return accessToken.token;
}

async function main() {
  if (!PROJECT_ID) {
    console.error('環境変数 GOOGLE_PROJECT_ID が必要です');
    process.exit(1);
  }

  const matrix = buildMatrix(PLACES);
  const request = buildRequest(PLACES, matrix);
  const payloadKB = Buffer.byteLength(JSON.stringify(request)) / 1024;

  console.log('=== 自前で作った移動コスト行列 ===');
  console.log(`  地点数          : ${PLACES.length}（拠点1 + 配送先${PLACES.length - 1}）`);
  console.log(`  行列サイズ      : ${PLACES.length} x ${PLACES.length} = ${PLACES.length ** 2} セル`);
  console.log(
    `  非対称なペア    : ${matrix.asymmetricCells} 組（方向別ペナルティ ${DIRECTIONAL_PENALTIES.length} 件による）${NO_PENALTY ? ' ※--no-penalty 指定中' : ''}`,
  );
  console.log(`  リクエストサイズ: ${payloadKB.toFixed(1)} KB（同期の上限は 4096 KB）`);

  const token = await getAuthToken();
  const url = `https://routeoptimization.googleapis.com/v1/projects/${PROJECT_ID}/:optimizeTours`;

  try {
    const started = Date.now();
    const response = await axios.post(url, request, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    console.log(`\nAPI 応答: ${Date.now() - started} ms`);

    printResult(PLACES, response.data);

    const tmpDir = path.resolve(__dirname, '..', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(tmpDir, `solver-only-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ request, response: response.data }, null, 2));
    console.log(`\nリクエスト/レスポンスを保存しました: ${outPath}`);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('API エラー:', error.response?.status);
      console.error(JSON.stringify(error.response?.data, null, 2));
    } else {
      console.error('エラー:', error);
    }
    process.exit(1);
  }
}

main();
