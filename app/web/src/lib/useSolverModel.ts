// ソルバー Playground（実地図版 / 仮想フィールド版）で共通の状態とロジック。
// 違うのは「地点の座標系」と「その距離の測り方」だけなので、そこだけ差し替えられるようにしてある。

import { useMemo, useState } from 'react';
import {
  type BuiltMatrix,
  type DirectionalPenalty,
  type MatrixParams,
  type PlaceBase,
  type RawDistanceFn,
  SYNC_PAYLOAD_LIMIT_BYTES,
  buildMatrix,
  buildSolverRequest,
} from './solverMatrix';

const apiBase =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

// 日付は「当日」固定にして、UI では時刻（hh:mm）だけを扱う。
// 日をまたぐ行程を組みたくなったら、ここを日付付きに戻す。
export const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD

// 全体時間枠の既定値（当日の 8:00〜23:00）
export const DEFAULT_GLOBAL_START = '08:00';
export const DEFAULT_GLOBAL_END = '23:00';

// 地点ごとの時間枠。hh:mm 文字列（空 = 未設定）で保持する。
// mode は「この範囲で縛りたいのが到着時刻か出発時刻か」。
// API の VisitRequest.timeWindows は到着（訪問開始）しか縛れないため、
// 出発で指定された場合は作業時間ぶん前倒しして到着の枠に変換する。
export type PlaceTimeWindow = { mode: 'arrival' | 'departure'; from: string; to: string };

export const EMPTY_TIME_WINDOW: PlaceTimeWindow = { mode: 'arrival', from: '', to: '' };

// 車両の出発 / 帰着の枠は地点ではなく「役割」に紐づける
// （S と E が同じ地点でも別々に設定できるようにするため）
export const START_WINDOW_KEY = '__vehicle_start';
export const END_WINDOW_KEY = '__vehicle_end';

// hh:mm（当日・JST）→ RFC3339。offsetMinutes ぶんずらせる。
const isoAt = (hhmm: string, offsetMinutes = 0): string | undefined => {
  if (!hhmm) return undefined;
  const d = new Date(`${TODAY}T${hhmm}:00+09:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Date(d.getTime() + offsetMinutes * 60_000).toISOString();
};

// --- API レスポンス（行列モードで実際に返るフィールドだけ） -------------------
// 行列モードでは routePolyline は返らない（座標を送っていないため道路形状を計算できない）
export type Visit = { shipmentIndex?: number; startTime?: string };
export type Transition = {
  travelDuration?: string;
  travelDistanceMeters?: number;
  waitDuration?: string;
};
export type RouteMetrics = {
  performedShipmentCount?: number;
  travelDuration?: string;
  visitDuration?: string;
  waitDuration?: string;
  totalDuration?: string;
  travelDistanceMeters?: number;
};
export type OptimizeResult = {
  routes?: {
    visits?: Visit[];
    transitions?: Transition[];
    metrics?: RouteMetrics;
    vehicleStartTime?: string;
    vehicleEndTime?: string;
  }[];
  skippedShipments?: { index?: number }[];
  metrics?: { totalCost?: number; costs?: Record<string, number> };
};

export type SolverModelConfig<T extends PlaceBase> = {
  initialPlaces: T[];
  initialPenalties: DirectionalPenalty[];
  initialParams: MatrixParams;
  // 2 地点間の素の距離（m）。実地図なら haversine、仮想フィールドならユークリッド距離。
  rawMeters: RawDistanceFn<T>;
  // 新規地点 id の接頭辞
  idPrefix: string;
};

export function useSolverModel<T extends PlaceBase>(config: SolverModelConfig<T>) {
  const { initialPlaces, initialPenalties, initialParams, rawMeters, idPrefix } = config;

  // 地点そのものは消さず、「訪問する / しない」の選択で出し入れする
  const [places, setPlaces] = useState<T[]>(initialPlaces);
  const [startId, setStartId] = useState(initialPlaces[0]?.id ?? '');
  const [endId, setEndId] = useState(initialPlaces[0]?.id ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(initialPlaces.map((p) => p.id));

  const [penalties, setPenalties] = useState<DirectionalPenalty[]>(initialPenalties);
  const [penaltyEnabled, setPenaltyEnabled] = useState(true);
  const [params, setParams] = useState<MatrixParams>(initialParams);
  const [visitMinutes, setVisitMinutes] = useState(15);
  const [costPerHour, setCostPerHour] = useState(3000);
  const [costPerKilometer, setCostPerKilometer] = useState(40);
  const [globalStart, setGlobalStart] = useState(DEFAULT_GLOBAL_START);
  const [globalEnd, setGlobalEnd] = useState(DEFAULT_GLOBAL_END);
  const [timeWindows, setTimeWindows] = useState<Record<string, PlaceTimeWindow>>({});

  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [resultSignature, setResultSignature] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A/B 比較用に取っておく 1 件
  const [baseline, setBaseline] = useState<{ label: string; order: string[]; cost?: number } | null>(
    null,
  );

  // 初期地点は削除させない（選択を外すだけ）
  const defaultIds = useMemo(() => new Set(initialPlaces.map((p) => p.id)), [initialPlaces]);

  // --- 出発地 / 帰着地 / 訪問先 ---------------------------------------------
  const startPlace = places.find((p) => p.id === startId) ?? places[0];
  const endPlace = places.find((p) => p.id === endId) ?? startPlace;

  const stops = useMemo(
    () =>
      places.filter(
        (p) => selectedIds.includes(p.id) && p.id !== startPlace?.id && p.id !== endPlace?.id,
      ),
    [places, selectedIds, startPlace?.id, endPlace?.id],
  );

  // 行列の行（出発側）= 出発地 + 訪問先、列（到着側）= 帰着地 + 訪問先。
  // API は出発側・到着側のインデックス集合を別々に検証するので、
  // 「到着側にしか登場しない帰着地」を src タグに混ぜると 400 になる（矩形行列にする）。
  const srcPlaces = useMemo(() => dedupe([startPlace, ...stops]), [startPlace, stops]);
  const dstPlaces = useMemo(() => dedupe([endPlace, ...stops]), [endPlace, stops]);

  const srcIds = useMemo(() => new Set(srcPlaces.map((p) => p.id)), [srcPlaces]);
  const dstIds = useMemo(() => new Set(dstPlaces.map((p) => p.id)), [dstPlaces]);

  // ペナルティが効くのは「出発側にある地点 → 到着側にある地点」だけ。
  // 例: 帰着地は列にしか存在しないので、そこを起点にしたペナルティは行列に載らない。
  const isPenaltyActive = (pen: DirectionalPenalty) =>
    pen.from !== pen.to && srcIds.has(pen.from) && dstIds.has(pen.to);

  const activePenalties = useMemo(
    () => (penaltyEnabled ? penalties.filter(isPenaltyActive) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [penaltyEnabled, penalties, srcIds, dstIds],
  );

  const matrix: BuiltMatrix = useMemo(
    () => buildMatrix(srcPlaces, dstPlaces, activePenalties, params, rawMeters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [srcPlaces, dstPlaces, activePenalties, params],
  );

  const request = useMemo(() => {
    if (!startPlace || !endPlace || stops.length === 0) return null;

    const windowOf = (id: string, offsetMinutes = 0) => {
      const w = timeWindows[id];
      if (!w || (!w.from && !w.to)) return undefined;
      return { startTime: isoAt(w.from, offsetMinutes), endTime: isoAt(w.to, offsetMinutes) };
    };

    // 訪問先は「出発で指定されたら作業時間ぶん前倒しして到着の枠にする」
    const stopTimeWindows: Record<string, { startTime?: string; endTime?: string }> = {};
    stops.forEach((p) => {
      const w = timeWindows[p.id];
      const converted = windowOf(p.id, w?.mode === 'departure' ? -visitMinutes : 0);
      if (converted) stopTimeWindows[p.id] = converted;
    });

    return buildSolverRequest({
      srcPlaces,
      dstPlaces,
      matrix,
      start: startPlace,
      end: endPlace,
      stops,
      options: {
        visitMinutes,
        costPerHour,
        costPerKilometer,
        globalStartTime: isoAt(globalStart) ?? isoAt(DEFAULT_GLOBAL_START)!,
        globalEndTime: isoAt(globalEnd) ?? isoAt(DEFAULT_GLOBAL_END)!,
      },
      startTimeWindow: windowOf(START_WINDOW_KEY),
      endTimeWindow: windowOf(END_WINDOW_KEY),
      stopTimeWindows,
    });
  }, [
    srcPlaces,
    dstPlaces,
    matrix,
    startPlace,
    endPlace,
    stops,
    visitMinutes,
    costPerHour,
    costPerKilometer,
    globalStart,
    globalEnd,
    timeWindows,
  ]);

  const requestJson = useMemo(() => (request ? JSON.stringify(request, null, 2) : ''), [request]);
  const payloadBytes = useMemo(
    () => (request ? new Blob([JSON.stringify(request)]).size : 0),
    [request],
  );

  // 入力が変わったら「結果が古い」ことを示すための署名
  const signature = useMemo(() => (request ? JSON.stringify(request) : ''), [request]);
  const stale = result !== null && resultSignature !== signature;

  const route = result?.routes?.[0];

  // 訪問順（stops の並び）。shipmentIndex は 0 のとき省略されるので ?? 0 が必須。
  const orderPlaces = useMemo(() => {
    if (!route?.visits) return [];
    return route.visits.map((v) => stops[v.shipmentIndex ?? 0]);
  }, [route, stops]);

  const orderById = useMemo(() => {
    const m = new Map<string, number>();
    orderPlaces.forEach((p, i) => {
      if (p) m.set(p.id, i + 1);
    });
    return m;
  }, [orderPlaces]);

  const orderNames = useMemo(() => orderPlaces.map((p, i) => p?.name ?? `#${i}`), [orderPlaces]);

  // 時間枠に収まらず訪問されなかった地点（地図・フレーム上で区別するために使う）
  const skippedIds = useMemo(() => {
    const ids = (result?.skippedShipments ?? [])
      .map((s) => stops[s.index ?? 0]?.id)
      .filter((id): id is string => Boolean(id));
    return new Set(ids);
  }, [result, stops]);

  // --- 地点の編集 -----------------------------------------------------------
  const nextPlaceId = () => {
    let n = places.length;
    let id = `${idPrefix}-${n}`;
    while (places.some((p) => p.id === id)) {
      n += 1;
      id = `${idPrefix}-${n}`;
    }
    return id;
  };

  // 座標は座標系ごとに違うので、生成そのものは呼び出し側に任せる
  const addPlace = (build: (id: string, index: number) => T) => {
    const id = nextPlaceId();
    setPlaces((prev) => [...prev, build(id, prev.length)]);
    setSelectedIds((prev) => [...prev, id]);
  };

  const movePlace = (id: string, patch: Partial<T>) =>
    setPlaces((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const renamePlace = (id: string, name: string) =>
    setPlaces((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const selectAll = () => setSelectedIds(places.map((p) => p.id));
  const selectNone = () => setSelectedIds([]);

  // 後から足した地点だけは削除できる（初期地点は選択解除で対応する）
  const removePlace = (id: string) => {
    const fallback = places.find((p) => p.id !== id)?.id ?? '';
    setPlaces((prev) => prev.filter((p) => p.id !== id));
    setSelectedIds((prev) => prev.filter((x) => x !== id));
    setPenalties((prev) => prev.filter((p) => p.from !== id && p.to !== id));
    if (startId === id) setStartId(fallback);
    if (endId === id) setEndId(fallback);
  };

  const setTimeWindow = (id: string, patch: Partial<PlaceTimeWindow>) =>
    setTimeWindows((prev) => ({ ...prev, [id]: { ...EMPTY_TIME_WINDOW, ...prev[id], ...patch } }));

  const clearTimeWindow = (id: string) =>
    setTimeWindows((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const resetAll = () => {
    setPlaces(initialPlaces);
    setStartId(initialPlaces[0]?.id ?? '');
    setEndId(initialPlaces[0]?.id ?? '');
    setSelectedIds(initialPlaces.map((p) => p.id));
    setPenalties(initialPenalties);
    setPenaltyEnabled(true);
    setParams(initialParams);
    setTimeWindows({});
    setGlobalStart(DEFAULT_GLOBAL_START);
    setGlobalEnd(DEFAULT_GLOBAL_END);
    setResult(null);
    setResultSignature(null);
    setBaseline(null);
    setError(null);
  };

  // --- ペナルティの編集 -----------------------------------------------------
  const addPenalty = (from: string, to: string, factor = 3) =>
    setPenalties((prev) => [...prev, { id: `pen-${Date.now()}-${prev.length}`, from, to, factor }]);

  const updatePenalty = (id: string, patch: Partial<DirectionalPenalty>) =>
    setPenalties((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const removePenalty = (id: string) => setPenalties((prev) => prev.filter((p) => p.id !== id));

  // --- 実行 -----------------------------------------------------------------
  const canRun = request !== null && payloadBytes <= SYNC_PAYLOAD_LIMIT_BYTES;

  const run = async () => {
    if (!canRun || !request) return;
    setLoading(true);
    setError(null);
    const started = Date.now();
    try {
      const res = await fetch(`${apiBase}/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 行列モードは制約が厳しく 400 が出やすいので、details まで見せる
        const detail =
          typeof body.details === 'object'
            ? JSON.stringify(body.details)
            : String(body.details ?? '');
        throw new Error(
          `${res.status}: ${body.error ?? res.statusText}${detail ? `\n${detail}` : ''}`,
        );
      }
      setResult(body as OptimizeResult);
      setResultSignature(signature);
      setElapsedMs(Date.now() - started);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
      setResultSignature(null);
    } finally {
      setLoading(false);
    }
  };

  const saveBaseline = () => {
    if (!route) return;
    setBaseline({
      label: `訪問 ${stops.length} 地点 / ${
        penaltyEnabled ? `ペナルティ ${activePenalties.length} 件` : 'ペナルティ無効'
      }`,
      order: orderNames,
      cost: result?.metrics?.totalCost,
    });
  };

  // 比較: 保存済みの順序と現在の順序が「完全な逆回り」かどうか
  const reversedFromBaseline =
    baseline !== null &&
    baseline.order.length === orderNames.length &&
    orderNames.length > 1 &&
    baseline.order.join('>') === [...orderNames].reverse().join('>');

  const sameAsBaseline = baseline !== null && baseline.order.join('>') === orderNames.join('>');

  return {
    // 地点
    places,
    startPlace,
    endPlace,
    stops,
    selectedIds,
    startId: startPlace?.id ?? '',
    endId: endPlace?.id ?? '',
    setStartId,
    setEndId,
    defaultIds,
    addPlace,
    movePlace,
    renamePlace,
    removePlace,
    toggleSelected,
    selectAll,
    selectNone,
    resetAll,
    // 行列
    srcPlaces,
    dstPlaces,
    matrix,
    params,
    setParams,
    visitMinutes,
    setVisitMinutes,
    costPerHour,
    setCostPerHour,
    costPerKilometer,
    setCostPerKilometer,
    // 時間枠
    globalStart,
    setGlobalStart,
    globalEnd,
    setGlobalEnd,
    timeWindows,
    setTimeWindow,
    clearTimeWindow,
    // ペナルティ
    penalties,
    penaltyEnabled,
    setPenaltyEnabled,
    activePenalties,
    isPenaltyActive,
    addPenalty,
    updatePenalty,
    removePenalty,
    // リクエスト・実行
    request,
    requestJson,
    payloadBytes,
    canRun,
    stale,
    run,
    loading,
    error,
    elapsedMs,
    result,
    route,
    orderPlaces,
    orderById,
    orderNames,
    skippedIds,
    // 比較
    baseline,
    saveBaseline,
    reversedFromBaseline,
    sameAsBaseline,
  };
}

export type SolverModel<T extends PlaceBase> = ReturnType<typeof useSolverModel<T>>;

function dedupe<T extends PlaceBase>(list: (T | undefined)[]): T[] {
  const out: T[] = [];
  list.forEach((p) => {
    if (p && !out.some((q) => q.id === p.id)) out.push(p);
  });
  return out;
}
