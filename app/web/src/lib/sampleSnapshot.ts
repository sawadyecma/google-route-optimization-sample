// エディタの「サンプル」タブ用のサンプル群。
// 日本国内（東京）の座標を使った「入力のみ」のスナップショット。
// 結果は持たず、復元後にユーザーが「最適化を計算」を押して実 API で求める。

import type { CalcSnapshot } from './calcHistory';
import type { LatLng, Point, VehicleCost } from '../pages/EditorPage';

const DATE = '2024-02-13';
const COST_PER_HOUR = 30; // 車両の時間コスト

// 東京近郊の地点
const TOKYO_STATION: LatLng = { latitude: 35.681236, longitude: 139.767125 }; // 出発・帰着（デポ）
const SHIBUYA: LatLng = { latitude: 35.658034, longitude: 139.701636 };
const SHINJUKU: LatLng = { latitude: 35.690921, longitude: 139.700258 };
const UENO: LatLng = { latitude: 35.713768, longitude: 139.777254 };
const ASAKUSA: LatLng = { latitude: 35.71174, longitude: 139.796587 };
const IKEBUKURO: LatLng = { latitude: 35.7295, longitude: 139.7109 };
const AKIHABARA: LatLng = { latitude: 35.6984, longitude: 139.7731 };
const SHINAGAWA: LatLng = { latitude: 35.6285, longitude: 139.7387 };
const ROPPONGI: LatLng = { latitude: 35.6627, longitude: 139.7307 };
const TOKYO_TOWER: LatLng = { latitude: 35.6586, longitude: 139.7454 };
const GINZA: LatLng = { latitude: 35.6717, longitude: 139.765 };
// 中心部から離れた地点（スキップ検証用）
const HANEDA: LatLng = { latitude: 35.5494, longitude: 139.7798 }; // 羽田空港
const KAWASAKI: LatLng = { latitude: 35.5308, longitude: 139.7029 }; // 川崎

const VEHICLE_COST: VehicleCost = {
  costPerHour: COST_PER_HOUR,
  costPerTraveledHour: 0,
  costPerKilometer: 0,
  fixedCost: 0,
};

const makeSample = (
  id: string,
  label: string,
  pickups: Point[],
  deliveries: Point[],
  vehicleCost: VehicleCost = VEHICLE_COST
): CalcSnapshot => ({
  id,
  createdAt: Date.parse(`${DATE}T00:00:00Z`),
  favorite: false,
  label,
  input: { pickups, deliveries, start: TOKYO_STATION, end: TOKYO_STATION, vehicleCost },
});

// サンプル1: 時間制約なし（基本ケース）
const plainSample = makeSample(
  'sample-tokyo',
  '東京・2配送（制約なし）',
  [{ loc: SHIBUYA }, { loc: UENO }],
  [{ loc: SHINJUKU }, { loc: ASAKUSA }]
);

// サンプル2: ソフト制約・遅着ペナルティ
// ピックアップに「09:00 以降」のハード時間枠を付けて稼働開始を固定する。
// これが無いとソルバーが全体を早めて遅着を回避してしまい、ペナルティが発生しない。
// 配送のソフト終了を 09:00 にすると、ピックアップ（≥09:00）＋移動の分だけ必ず遅着し、
// 超過分に遅着ペナルティ（追加コスト）が乗る。
const PICKUP_EARLIEST = '09:00';
const SOFT_END = '09:00';
const softSample = makeSample(
  'sample-tokyo-soft',
  'ソフト制約・遅着ペナルティ（東京）',
  [
    { loc: SHIBUYA, startTime: PICKUP_EARLIEST },
    { loc: UENO, startTime: PICKUP_EARLIEST },
  ],
  [
    { loc: SHINJUKU, softEndTime: SOFT_END, costPerHourAfterSoftEndTime: COST_PER_HOUR },
    { loc: ASAKUSA, softEndTime: SOFT_END, costPerHourAfterSoftEndTime: COST_PER_HOUR },
  ]
);

// サンプル3: スキップ・ペナルティ
// 3件目の荷物を中心部から離れた羽田・川崎に置き、低い penaltyCost（=スキップ可）を設定する。
// 配送に要する移動コスト（往復の遠回り）がスキップ時のペナルティを大きく上回るため、
// ソルバーはこの荷物を「スキップして penaltyCost を支払う」方を選び、その分が上乗せされる。
const SKIP_PENALTY = 5;
const skipSample = makeSample(
  'sample-tokyo-skip',
  'スキップ・ペナルティ（東京）',
  [
    { loc: SHIBUYA },
    { loc: UENO },
    { loc: HANEDA, penaltyCost: SKIP_PENALTY }, // 遠方＋低ペナルティ → スキップされる
  ],
  [{ loc: SHINJUKU }, { loc: ASAKUSA }, { loc: KAWASAKI }]
);

// サンプル4: 早着ペナルティ
// ピックアップに「09:00 までに集荷」のハード上限を付けて早めに集荷を固定。
// 配送のソフト開始を 12:00 に置くと、集荷後すぐ着くと早着になる。早着の時間単価(5/h)を
// 車両の時間コスト(30/h)より十分安くしてあるため、「12:00 まで待つ」より「早く着いて
// 早着ペナルティを払う」方が安く、結果として早着ペナルティが発生する。
const EARLY_COST = 5;
const earlySample = makeSample(
  'sample-tokyo-early',
  '早着ペナルティ（東京）',
  [
    { loc: SHIBUYA, endTime: '09:00' },
    { loc: UENO, endTime: '09:00' },
  ],
  [
    { loc: SHINJUKU, softStartTime: '12:00', costPerHourBeforeSoftStartTime: EARLY_COST },
    { loc: ASAKUSA, softStartTime: '12:00', costPerHourBeforeSoftStartTime: EARLY_COST },
  ]
);

// サンプル5: ハード時間枠で訪問順が変わる
// 制約だけ見ると、浅草の配送は「08:00–08:40」、新宿の配送は「10:00–11:00」。
// 地理的な近さに関係なく、時間枠を満たすため必ず浅草→新宿の順で配送される。
const reorderSample = makeSample(
  'sample-tokyo-window-order',
  'ハード時間枠で訪問順が変わる（東京）',
  [{ loc: SHIBUYA }, { loc: UENO }],
  [
    { loc: SHINJUKU, startTime: '10:00', endTime: '11:00' },
    { loc: ASAKUSA, startTime: '08:00', endTime: '08:40' },
  ]
);

// サンプル6: 多荷物の経路最適化ショーケース（制約なし・5件）
const multiSample = makeSample(
  'sample-tokyo-multi',
  '多荷物・経路最適化（5件）',
  [{ loc: SHIBUYA }, { loc: UENO }, { loc: IKEBUKURO }, { loc: SHINAGAWA }, { loc: TOKYO_TOWER }],
  [{ loc: SHINJUKU }, { loc: ASAKUSA }, { loc: AKIHABARA }, { loc: ROPPONGI }, { loc: GINZA }]
);

// サンプル7/8: 距離コスト重視 vs 時間コスト重視（同一地点でルートの違いを比較）
const CMP_PICKUPS: Point[] = [{ loc: SHIBUYA }, { loc: UENO }, { loc: IKEBUKURO }, { loc: SHINAGAWA }];
const CMP_DELIVERIES: Point[] = [
  { loc: SHINJUKU },
  { loc: ASAKUSA },
  { loc: AKIHABARA },
  { loc: ROPPONGI },
];
const DISTANCE_COST: VehicleCost = {
  costPerHour: 0,
  costPerTraveledHour: 0,
  costPerKilometer: 1,
  fixedCost: 0,
};
const TIME_COST: VehicleCost = {
  costPerHour: 30,
  costPerTraveledHour: 0,
  costPerKilometer: 0,
  fixedCost: 0,
};
const distanceSample = makeSample(
  'sample-tokyo-distance',
  '距離コスト重視（東京）',
  CMP_PICKUPS,
  CMP_DELIVERIES,
  DISTANCE_COST
);
const timeSample = makeSample(
  'sample-tokyo-time',
  '時間コスト重視（東京）',
  CMP_PICKUPS,
  CMP_DELIVERIES,
  TIME_COST
);

export const SAMPLE_SNAPSHOTS: CalcSnapshot[] = [
  plainSample,
  softSample,
  skipSample,
  earlySample,
  reorderSample,
  multiSample,
  distanceSample,
  timeSample,
];
