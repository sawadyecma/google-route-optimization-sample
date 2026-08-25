// 「ソルバーだけ使う」モードの移動コスト行列を組み立てるロジック。
// app/cmd/src/solverOnly.ts と同じ計算を、UI から触れるようにブラウザ側へ移植したもの。
// 詳しい調査結果は docs/solver-only-mode.md を参照。
//
// 地点の座標系（実地図の緯度経度 / 仮想フィールドの XY）に依存しないよう、
// 「2 地点間の素の距離（m）」を返す関数を差し替えられる形にしてある。

// 行列・リクエスト組み立てに最低限必要な情報。座標は距離関数側が知っていればよい。
export type PlaceBase = { id: string; name: string };

// 実地図版の地点（緯度経度）
export type SolverPlace = PlaceBase & { lat: number; lng: number };

// 仮想フィールド版の地点（フレーム上の XY。単位は km として扱う）
export type FieldPlace = PlaceBase & { x: number; y: number };

// 特定の向きだけ移動コストを割り増す設定（一方通行・混雑方向・上り坂など）。
// 自前で行列を作るからこそ表現できる、非対称なコスト。
export type DirectionalPenalty = {
  id: string;
  from: string; // 地点 id
  to: string; // 地点 id
  factor: number;
};

export type MatrixParams = {
  detourFactor: number; // 素の距離 → 実際の移動距離の補正係数
  speedKmh: number; // 平均速度
};

export type BuiltMatrix = {
  seconds: number[][]; // [src][dst]
  meters: number[][];
  asymmetric: boolean[][]; // 逆向きが存在し、かつ値が食い違うセル
  asymmetricPairs: number; // 往復で値が食い違うペアの数
};

// 素の距離（m）を返す関数。実地図なら haversine、仮想フィールドならユークリッド距離。
export type RawDistanceFn<T> = (a: T, b: T) => number;

export const DEFAULT_MATRIX_PARAMS: MatrixParams = { detourFactor: 1.35, speedKmh: 60 };

// 仮想フィールドは「直線距離そのもの」を見るのが目的なので迂回係数は 1.0
export const FIELD_MATRIX_PARAMS: MatrixParams = { detourFactor: 1, speedKmh: 60 };

// 東京都庁を拠点に、県庁所在地＋高輪・燕市を回る 10 地点。CLI サンプルと同じ座標。
// 座標は代表点（概数）。API には送らず、行列を自前計算するためだけに持つ。
export const DEFAULT_PLACES: SolverPlace[] = [
  { id: 'loc-tokyo', name: '東京都庁', lat: 35.6896, lng: 139.6917 },
  { id: 'loc-takanawa', name: '高輪（港区）', lat: 35.6284, lng: 139.7387 },
  { id: 'loc-kanagawa', name: '神奈川県庁', lat: 35.4437, lng: 139.638 },
  { id: 'loc-shizuoka', name: '静岡県庁', lat: 34.9769, lng: 138.3831 },
  { id: 'loc-aichi', name: '愛知県庁', lat: 35.1802, lng: 136.9066 },
  { id: 'loc-kyoto', name: '京都府庁', lat: 35.0212, lng: 135.7556 },
  { id: 'loc-ishikawa', name: '石川県庁', lat: 36.5947, lng: 136.6256 },
  { id: 'loc-tsubame', name: '新潟県燕市', lat: 37.6717, lng: 138.8828 },
  { id: 'loc-nagano', name: '長野県庁', lat: 36.6513, lng: 138.181 },
  { id: 'loc-gunma', name: '群馬県庁', lat: 36.3895, lng: 139.0634 },
];

// 既定のペナルティは「ペナルティ無しの最適解が実際に通る向き」に置いてある。
// 対称行列では周回の向きを反転してもコストが同じなので、片方向だけ重くすると
// 解全体が逆回りに反転する ＝ 非対称行列が効いていることが目で見える。
export const DEFAULT_PENALTIES: DirectionalPenalty[] = [
  { id: 'pen-1', from: 'loc-kanagawa', to: 'loc-shizuoka', factor: 3 }, // 横浜 → 静岡（東名の下り方向が混む想定）
  { id: 'pen-2', from: 'loc-kyoto', to: 'loc-ishikawa', factor: 3 }, // 京都 → 金沢
];

// --- 仮想フィールド ---------------------------------------------------------
// フレームは 300 × 200（単位 km）。地図を使わず、純粋に幾何だけで最適化を試す用。
export const FIELD_WIDTH = 300;
export const FIELD_HEIGHT = 200;

export const DEFAULT_FIELD_PLACES: FieldPlace[] = [
  { id: 'fld-a', name: 'A', x: 40, y: 40 },
  { id: 'fld-b', name: 'B', x: 120, y: 28 },
  { id: 'fld-c', name: 'C', x: 215, y: 45 },
  { id: 'fld-d', name: 'D', x: 268, y: 105 },
  { id: 'fld-e', name: 'E', x: 205, y: 160 },
  { id: 'fld-f', name: 'F', x: 120, y: 168 },
  { id: 'fld-g', name: 'G', x: 45, y: 140 },
  { id: 'fld-h', name: 'H', x: 95, y: 92 },
  { id: 'fld-i', name: 'I', x: 172, y: 100 },
  { id: 'fld-j', name: 'J', x: 250, y: 22 },
];

// 既定では「A から時計回りに一周する解」が通る向きを重くしてある（= 逆回りに反転する）
export const DEFAULT_FIELD_PENALTIES: DirectionalPenalty[] = [
  { id: 'fpen-1', from: 'fld-b', to: 'fld-j', factor: 3 },
  { id: 'fpen-2', from: 'fld-e', to: 'fld-f', factor: 3 },
];

// --- 距離関数 ---------------------------------------------------------------
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// フレーム上のユークリッド距離。座標 1 = 1km として m に直す。
export function fieldMeters(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y) * 1000;
}

// --- 行列 -------------------------------------------------------------------
// 出発側（行）と到着側（列）の地点リストから行列を作る。
//
// src と dst を別リストにできるのが重要な点。API は
// 「出発側インデックスの集合」と「到着側インデックスの集合」を別々に検証しており、
// 到着側にしか登場しない地点（= 帰着地）を src タグに混ぜると
// `in the set of values spanned by all 'departure_index' and 'start_index' fields: index #n is missing`
// で 400 になる。出発地 ≠ 帰着地のときは正方行列にできない。
//
// 本番運用では rawMeters を OSRM / Valhalla など経路エンジンの応答に置き換える想定。
export function buildMatrix<T extends PlaceBase>(
  srcPlaces: T[],
  dstPlaces: T[],
  penalties: DirectionalPenalty[],
  params: MatrixParams,
  rawMeters: RawDistanceFn<T>,
): BuiltMatrix {
  const speedMps = (params.speedKmh * 1000) / 3600;
  const penaltyMap = new Map(penalties.map((p) => [`${p.from}>${p.to}`, p.factor]));

  const cost = (a: T, b: T) => {
    if (a.id === b.id) return { meters: 0, seconds: 0 };
    const factor = penaltyMap.get(`${a.id}>${b.id}`) ?? 1;
    const m = rawMeters(a, b) * params.detourFactor * factor;
    return { meters: Math.round(m), seconds: speedMps > 0 ? Math.round(m / speedMps) : 0 };
  };

  const seconds = srcPlaces.map((a) => dstPlaces.map((b) => cost(a, b).seconds));
  const meters = srcPlaces.map((a) => dstPlaces.map((b) => cost(a, b).meters));

  // 逆向き（dst→src）が行列に存在するセルだけ、値が食い違っていないかを見る
  const srcIndex = new Map(srcPlaces.map((p, i) => [p.id, i]));
  const dstIndex = new Map(dstPlaces.map((p, j) => [p.id, j]));
  let asymmetricPairs = 0;
  const asymmetric = srcPlaces.map((a, i) =>
    dstPlaces.map((b, j) => {
      if (a.id === b.id) return false;
      const ri = srcIndex.get(b.id);
      const rj = dstIndex.get(a.id);
      if (ri === undefined || rj === undefined) return false;
      const diff = seconds[i][j] !== seconds[ri][rj];
      if (diff && i < ri) asymmetricPairs++;
      return diff;
    }),
  );

  return { seconds, meters, asymmetric, asymmetricPairs };
}

// --- リクエスト -------------------------------------------------------------
// 時間枠（RFC3339）。どちらか片方だけの指定も可。
export type TimeWindow = { startTime?: string; endTime?: string };

export type SolverRequestOptions = {
  visitMinutes: number;
  costPerHour: number;
  costPerKilometer: number;
  // 全体時間枠（RFC3339）
  globalStartTime: string;
  globalEndTime: string;
};

export type SolverRequestInput<T extends PlaceBase> = {
  // 行列の行 = 出発側タグ、列 = 到着側タグ。
  // どちらも「実際にその役割で登場する地点だけ」を過不足なく渡す必要がある
  srcPlaces: T[];
  dstPlaces: T[];
  matrix: BuiltMatrix;
  start: T; // 車両の出発地
  end: T; // 車両の帰着地（start と同じでもよい）
  stops: T[]; // 訪問先（start / end は含めない）
  options: SolverRequestOptions;
  // 車両が出発地を出てよい時間帯 / 帰着地に着くべき時間帯
  startTimeWindow?: TimeWindow;
  endTimeWindow?: TimeWindow;
  // 訪問先ごとの到着（＝訪問開始）許容時間帯。地点 id をキーにする
  stopTimeWindows?: Record<string, TimeWindow>;
};

// 行列モードのリクエストを組み立てる。
// 座標は一切送らない（送ると geolocations are incompatible with index-based locations で 400）。
// populatePolylines / considerRoadTraffic も行列モードでは 400 になるため付けない。
export function buildSolverRequest<T extends PlaceBase>({
  srcPlaces,
  dstPlaces,
  matrix,
  start,
  end,
  stops,
  options,
  startTimeWindow,
  endTimeWindow,
  stopTimeWindows,
}: SolverRequestInput<T>) {
  // 中身が空の時間枠は送らない（空オブジェクトを送ると 400 になる）
  const tw = (w?: TimeWindow) =>
    w && (w.startTime || w.endTime) ? [{ ...(w.startTime && { startTime: w.startTime }), ...(w.endTime && { endTime: w.endTime }) }] : undefined;

  return {
    timeout: '10s',
    model: {
      globalStartTime: options.globalStartTime,
      globalEndTime: options.globalEndTime,
      // src/dst タグの並びが行列の行/列に対応する。
      // 出発側に登場しない地点を src タグに混ぜると 400（index #n is missing）になるため、
      // 出発側 = 出発地 + 訪問先、到着側 = 帰着地 + 訪問先 で別々に組む。
      durationDistanceMatrixSrcTags: srcPlaces.map((p) => p.id),
      durationDistanceMatrixDstTags: dstPlaces.map((p) => p.id),
      durationDistanceMatrices: [
        {
          rows: matrix.seconds.map((row, i) => ({
            durations: row.map((s) => `${s}s`),
            meters: matrix.meters[i],
          })),
        },
      ],
      shipments: stops.map((p) => {
        const windows = tw(stopTimeWindows?.[p.id]);
        return {
          label: p.name,
          deliveries: [
            {
              // 座標ではなく tags で行列の行/列に紐づける
              tags: [p.id],
              duration: `${Math.max(0, Math.round(options.visitMinutes * 60))}s`,
              // VisitRequest.timeWindows が縛るのは「訪問の開始（＝到着）時刻」
              ...(windows && { timeWindows: windows }),
            },
          ],
        };
      }),
      vehicles: [
        {
          label: '配送車1',
          startTags: [start.id],
          endTags: [end.id],
          costPerHour: options.costPerHour,
          costPerKilometer: options.costPerKilometer,
          ...(tw(startTimeWindow) && { startTimeWindows: tw(startTimeWindow) }),
          ...(tw(endTimeWindow) && { endTimeWindows: tw(endTimeWindow) }),
        },
      ],
    },
  };
}

// 同期 optimizeTours のリクエスト上限（実測で確認した 4MiB）
export const SYNC_PAYLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
