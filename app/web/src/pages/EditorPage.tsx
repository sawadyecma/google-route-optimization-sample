import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { GoogleMap, Marker } from '@react-google-maps/api';
import {
  type CalcSnapshot,
  addSnapshot,
  loadSnapshots,
  makeId,
  persistSnapshots,
} from '../lib/calcHistory';
import { SAMPLE_SNAPSHOTS } from '../lib/sampleSnapshot';
import { color, radius, shadow, space } from '../theme';
// Polyline は @react-google-maps/api 側のクリーンアップが信頼できないため
// google.maps.Polyline を直接 ref で管理する
// LoadScript は App.tsx で全ページ共通に呼び出している（geometry ライブラリ含む）

export type LatLng = { latitude: number; longitude: number };

// hh:mm 形式（空文字 or undefined = 未設定）
export type Point = {
  loc: LatLng;
  // ハード時間枠（この範囲外には到着不可。守れない場合は実行不可能解になる）
  startTime?: string;
  endTime?: string;
  // ソフト時間枠（範囲外でも到着可だが、超過分にコスト＝ペナルティが発生する）
  softStartTime?: string;
  softEndTime?: string;
  // ソフト時間枠違反時の 1 時間あたりコスト
  costPerHourBeforeSoftStartTime?: number;
  costPerHourAfterSoftEndTime?: number;
  // スキップ（未配送）時のペナルティコスト。
  // 未設定 = 必須（スキップ不可）。設定すると任意 shipment になりスキップ時にこのコストが課される。
  // shipment 単位の概念なので pickup 側 Point にのみ持たせる。
  penaltyCost?: number;
};

type Mode = 'pickup' | 'delivery' | 'start' | 'end';

// ソフト時間枠を設定したのにコスト未指定だった場合のデフォルトコスト
const DEFAULT_SOFT_COST = 10;

// 日付は固定（hh:mm 入力と組み合わせて RFC3339 タイムスタンプを生成）
const FIXED_DATE = '2024-02-13';
const toIsoTime = (hhmm: string) => `${FIXED_DATE}T${hhmm}:00Z`;

// 最適化の全体時間枠（全ルートがこの範囲内で完結する）。各地点の時間枠はこの範囲に収める。
// hh:mm（UTC, FIXED_DATE 上で解釈）で保持する。
export type GlobalWindow = { start: string; end: string };
const DEFAULT_GLOBAL_WINDOW: GlobalWindow = { start: '00:00', end: '23:59' };

// ハード／ソフト両方をまとめて 1 つの timeWindow に詰める。
// いずれも未設定なら undefined（= 時間制約なし）。
const buildTimeWindows = (point: Point) => {
  const tw: Record<string, unknown> = {};
  if (point.startTime) tw.startTime = toIsoTime(point.startTime);
  if (point.endTime) tw.endTime = toIsoTime(point.endTime);
  if (point.softStartTime) {
    tw.softStartTime = toIsoTime(point.softStartTime);
    // costPerHourBeforeSoftStartTime は softStartTime とセットでのみ有効
    tw.costPerHourBeforeSoftStartTime =
      point.costPerHourBeforeSoftStartTime ?? DEFAULT_SOFT_COST;
  }
  if (point.softEndTime) {
    tw.softEndTime = toIsoTime(point.softEndTime);
    tw.costPerHourAfterSoftEndTime = point.costPerHourAfterSoftEndTime ?? DEFAULT_SOFT_COST;
  }
  return Object.keys(tw).length > 0 ? [tw] : undefined;
};

type OptimizedVisit = {
  shipmentIndex?: number;
  isPickup?: boolean;
  visitRequestIndex?: number;
  startTime?: string;
};

type EncodedPolyline = { points?: string };

type OptimizedTransition = {
  travelDuration?: string;
  travelDistanceMeters?: number;
  routePolyline?: EncodedPolyline;
};

type RouteMetrics = {
  travelDuration?: string;
  waitDuration?: string;
  delayDuration?: string;
  breakDuration?: string;
  visitDuration?: string;
  totalDuration?: string;
  travelDistanceMeters?: number;
};

export type OptimizeResponse = {
  routes?: Array<{
    vehicleStartTime?: string;
    vehicleEndTime?: string;
    visits?: OptimizedVisit[];
    transitions?: OptimizedTransition[];
    routePolyline?: EncodedPolyline;
    metrics?: RouteMetrics;
    // コスト内訳（コスト要因名 -> 金額）と合計
    routeCosts?: Record<string, number>;
    routeTotalCost?: number;
  }>;
  // ソリューション全体のコスト内訳と合計
  metrics?: {
    costs?: Record<string, number>;
    totalCost?: number;
  };
  // 任意 shipment のうち、スキップされたもの（penaltyCost を払って配送しなかった）
  skippedShipments?: Array<{
    index?: number;
    label?: string;
    reasons?: Array<{ code?: string; exampleVehicleIndex?: number }>;
  }>;
};

const MODE_COLORS: Record<Mode, string> = {
  pickup: color.yellow,
  delivery: color.blue,
  start: color.green,
  end: color.red,
};

const MODE_LABELS: Record<Mode, string> = {
  pickup: 'Pickup',
  delivery: 'Delivery',
  start: '出発地点',
  end: '帰着地点',
};

const DEFAULT_CENTER: LatLng = { latitude: 35.681236, longitude: 139.767125 }; // Tokyo Station

// サイドバー幅を永続化する localStorage キー
const SIDEBAR_WIDTH_KEY = 'editor.sidebarWidth';

const apiBase =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

// 車両のコスト系パラメータ（最適化の目的関数を構成する。動的に編集可能）
export type VehicleCost = {
  costPerHour: number; // 経過時間（移動＋待機）1 時間あたりコスト
  costPerTraveledHour: number; // 実移動時間 1 時間あたりコスト
  costPerKilometer: number; // 移動距離 1km あたりコスト
  fixedCost: number; // 車両を使うこと自体に掛かる固定コスト
};

const DEFAULT_VEHICLE_COST: VehicleCost = {
  costPerHour: 10,
  costPerTraveledHour: 0,
  costPerKilometer: 0,
  fixedCost: 0,
};

const buildRequest = (
  pickups: Point[],
  deliveries: Point[],
  start: LatLng,
  end: LatLng,
  vehicleCost: VehicleCost,
  globalWindow: GlobalWindow
) => ({
  timeout: '10s',
  // ルート全体の道路に沿ったポリラインを routes[].routePolyline.points に格納させる
  populatePolylines: true,
  // 区間ごとのポリラインを routes[].transitions[].routePolyline.points に格納させる
  // （区間ごとの色分け・選択ハイライト等の用途で利用可能）
  populateTransitionPolylines: true,
  model: {
    // 時間枠を有効に解釈させるためのグローバル範囲（固定日付上の hh:mm）
    globalStartTime: toIsoTime(globalWindow.start),
    globalEndTime: toIsoTime(globalWindow.end),
    shipments: pickups.map((p, i) => {
      const pickupTw = buildTimeWindows(p);
      const deliveryTw = buildTimeWindows(deliveries[i]);
      return {
        pickups: [
          {
            arrivalWaypoint: { location: { latLng: p.loc } },
            ...(pickupTw ? { timeWindows: pickupTw } : {}),
          },
        ],
        deliveries: [
          {
            arrivalWaypoint: { location: { latLng: deliveries[i].loc } },
            ...(deliveryTw ? { timeWindows: deliveryTw } : {}),
          },
        ],
        label: `Shipment ${i + 1}`,
        // penaltyCost を設定した shipment は任意（スキップ可）。未設定なら必須。
        ...(p.penaltyCost !== undefined ? { penaltyCost: p.penaltyCost } : {}),
      };
    }),
    vehicles: [
      {
        startWaypoint: { location: { latLng: start } },
        endWaypoint: { location: { latLng: end } },
        // 0 のコストは送らない（API デフォルト 0 と同義なのでリクエストを簡潔に保つ）
        ...(vehicleCost.costPerHour ? { costPerHour: vehicleCost.costPerHour } : {}),
        ...(vehicleCost.costPerTraveledHour
          ? { costPerTraveledHour: vehicleCost.costPerTraveledHour }
          : {}),
        ...(vehicleCost.costPerKilometer
          ? { costPerKilometer: vehicleCost.costPerKilometer }
          : {}),
        ...(vehicleCost.fixedCost ? { fixedCost: vehicleCost.fixedCost } : {}),
      },
    ],
  },
});

const formatLatLng = (loc: LatLng) => `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;

// 距離の「m（メートル）」と紛らわしいので、時間は日本語表記（時間/分/秒）にする
const formatDuration = (s: string | undefined): string => {
  if (!s) return '-';
  const sec = parseInt(s.replace('s', ''), 10);
  if (Number.isNaN(sec)) return s;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const r = sec % 60;
  if (h > 0) return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  if (m > 0) return `${m}分`;
  return `${r}秒`;
};

const formatDistance = (m: number | undefined): string => {
  if (m === undefined) return '-';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`;
};

// RFC3339 タイムスタンプ（UTC, 例: 2024-02-13T08:30:00Z）から hh:mm を取り出す。
// リクエストの時間枠を UTC(Z) で組み立てているため、表示もタイムゾーン変換せず
// UTC の時刻部分をそのまま表示してズレを防ぐ。
const formatTime = (iso: string | undefined): string => {
  if (!iso) return '-';
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : iso;
};

const formatCost = (n: number | undefined): string =>
  n === undefined ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

// hh:mm を 0 時からの秒数に（ソフト枠の入力は分単位なので秒は 0）
const hhmmToSec = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h * 60 + m) * 60;
};

// 秒数を「M分S秒」表記に（S=0 なら「M分」）
const formatMinSec = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
};

// visit の到着時刻（ISO）を、対応する地点のソフト時間枠と比較して違反を返す。
// late = ソフト終了より遅い（遅着）、early = ソフト開始より早い（早着）。
// API のコストは秒（厳密な時間）ベースなので、超過量も秒単位で求める。
const softViolation = (
  point: Point | undefined,
  visitIso: string | undefined
): { kind: 'late' | 'early'; seconds: number } | null => {
  if (!point || !visitIso) return null;
  const m = visitIso.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const visitSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (point.softEndTime && visitSec > hhmmToSec(point.softEndTime)) {
    return { kind: 'late', seconds: visitSec - hhmmToSec(point.softEndTime) };
  }
  if (point.softStartTime && visitSec < hhmmToSec(point.softStartTime)) {
    return { kind: 'early', seconds: hhmmToSec(point.softStartTime) - visitSec };
  }
  return null;
};

// 履歴の作成日時を MM/DD HH:mm で表示
const formatStamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// コスト内訳のキー（例: model.vehicles.cost_per_hour）を読みやすい短いラベルに。
// 注意: ソフト違反キーは `cost_per_hour_after_soft_end_time` のように `cost_per_hour` を
// 含むため、より具体的なソフト／ペナルティ系を先に判定する（penalty: true は制約違反コスト）。
const COST_LABELS: Array<{ test: RegExp; label: string; penalty?: boolean }> = [
  { test: /before_soft_start_time/, label: '早着ペナルティ', penalty: true },
  { test: /after_soft_end_time/, label: '遅着ペナルティ', penalty: true },
  { test: /penalty_cost/, label: 'スキップペナルティ', penalty: true },
  { test: /cost_per_traveled_hour/, label: '実移動時間コスト' },
  { test: /cost_per_hour/, label: '時間コスト' },
  { test: /cost_per_kilometer/, label: '距離コスト' },
  { test: /fixed_cost/, label: '車両固定費' },
];
const costInfo = (key: string): { label: string; penalty: boolean } => {
  const hit = COST_LABELS.find((c) => c.test.test(key));
  return { label: hit?.label ?? key, penalty: hit?.penalty ?? false };
};

// ハード枠／ソフト枠それぞれの「クリア」ボタン共通スタイル（小さめのアウトラインボタン）
const CLEAR_BTN_STYLE: React.CSSProperties = {
  border: '1px solid #d5d5d5',
  background: '#fff',
  cursor: 'pointer',
  color: '#777',
  fontSize: '10px',
  lineHeight: 1.5,
  padding: '1px 7px',
  borderRadius: '999px',
};

const PointRow: React.FC<{
  prefix: string;
  point: Point;
  onRemove: () => void;
  onChange: (patch: Partial<Point>) => void;
  // shipment 単位のスキップペナルティ入力を表示するか（pickup 行のみ true）
  showPenalty?: boolean;
}> = ({ prefix, point, onRemove, onChange, showPenalty }) => {
  const hasSoft = !!(point.softStartTime || point.softEndTime);
  const [showSoft, setShowSoft] = useState(hasSoft);
  return (
    <div
      style={{
        padding: '6px 0',
        borderBottom: '1px dashed #eee',
        fontSize: '11px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>
          {prefix}: {formatLatLng(point.loc)}
        </span>
        <button
          onClick={onRemove}
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: '#EA4335',
          }}
        >
          ×
        </button>
      </div>

      {/* ハード時間枠：この範囲外には到着不可（守れないと解なし） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          marginTop: '2px',
          color: '#666',
        }}
      >
        <span title="この範囲外には到着できない（厳格制約）">ハード枠</span>
        <input
          type="time"
          value={point.startTime ?? ''}
          onChange={(e) => onChange({ startTime: e.target.value || undefined })}
          style={{ fontSize: '11px', padding: '2px 4px' }}
        />
        <span>〜</span>
        <input
          type="time"
          value={point.endTime ?? ''}
          onChange={(e) => onChange({ endTime: e.target.value || undefined })}
          style={{ fontSize: '11px', padding: '2px 4px' }}
        />
        {(point.startTime || point.endTime) && (
          <button
            onClick={() => onChange({ startTime: undefined, endTime: undefined })}
            title="ハード枠をクリア"
            style={CLEAR_BTN_STYLE}
          >
            クリア
          </button>
        )}
        <button
          onClick={() => setShowSoft((s) => !s)}
          title="ソフト制約（違反するとコストが発生する時間枠）を設定"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: showSoft ? '#4285F4' : '#999',
            fontSize: '11px',
            marginLeft: 'auto',
          }}
        >
          ソフト{showSoft ? '▲' : '▼'}
        </button>
      </div>

      {/* ソフト時間枠：範囲外でも到着可だが超過分にコスト（ペナルティ）が乗る */}
      {showSoft && (
        <div style={{ marginTop: '4px', paddingLeft: '4px', borderLeft: '2px solid #cfe0ff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#666' }}>
            <span title="この時刻より早く着くと早着ペナルティ">早着</span>
            <input
              type="time"
              value={point.softStartTime ?? ''}
              onChange={(e) => onChange({ softStartTime: e.target.value || undefined })}
              style={{ fontSize: '11px', padding: '2px 4px' }}
            />
            <span>より前: </span>
            <input
              type="number"
              min={0}
              placeholder={String(DEFAULT_SOFT_COST)}
              value={point.costPerHourBeforeSoftStartTime ?? ''}
              onChange={(e) =>
                onChange({
                  costPerHourBeforeSoftStartTime:
                    e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              style={{ fontSize: '11px', padding: '2px 4px', width: '48px' }}
            />
            <span>/h</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              color: '#666',
              marginTop: '3px',
            }}
          >
            <span title="この時刻より遅く着くと遅着ペナルティ">遅着</span>
            <input
              type="time"
              value={point.softEndTime ?? ''}
              onChange={(e) => onChange({ softEndTime: e.target.value || undefined })}
              style={{ fontSize: '11px', padding: '2px 4px' }}
            />
            <span>より後: </span>
            <input
              type="number"
              min={0}
              placeholder={String(DEFAULT_SOFT_COST)}
              value={point.costPerHourAfterSoftEndTime ?? ''}
              onChange={(e) =>
                onChange({
                  costPerHourAfterSoftEndTime:
                    e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              style={{ fontSize: '11px', padding: '2px 4px', width: '48px' }}
            />
            <span>/h</span>
          </div>
          {(point.softStartTime ||
            point.softEndTime ||
            point.costPerHourBeforeSoftStartTime !== undefined ||
            point.costPerHourAfterSoftEndTime !== undefined) && (
            <button
              onClick={() =>
                onChange({
                  softStartTime: undefined,
                  softEndTime: undefined,
                  costPerHourBeforeSoftStartTime: undefined,
                  costPerHourAfterSoftEndTime: undefined,
                })
              }
              title="ソフト枠をクリア"
              style={{ ...CLEAR_BTN_STYLE, marginLeft: 0, marginTop: '3px' }}
            >
              クリア
            </button>
          )}
        </div>
      )}

      {/* スキップ時ペナルティ（shipment 単位＝pickup 行のみ）。未設定=必須 */}
      {showPenalty && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            marginTop: '4px',
            color: '#666',
          }}
        >
          <span title="未設定なら必須（スキップ不可）。設定するとスキップ可になり、スキップ時にこのコストが課される">
            スキップ可
          </span>
          <input
            type="checkbox"
            checked={point.penaltyCost !== undefined}
            onChange={(e) =>
              onChange({ penaltyCost: e.target.checked ? DEFAULT_SOFT_COST : undefined })
            }
          />
          {point.penaltyCost !== undefined && (
            <>
              <span>ペナルティ</span>
              <input
                type="number"
                min={0}
                value={point.penaltyCost}
                onChange={(e) =>
                  onChange({ penaltyCost: e.target.value === '' ? 0 : Number(e.target.value) })
                }
                style={{ fontSize: '11px', padding: '2px 4px', width: '60px' }}
              />
            </>
          )}
        </div>
      )}

    </div>
  );
};

// セクションの役割ごとのアクセント色とバッジ表記（入力=青 / 出力=緑 / 履歴=紫）
const SECTION_META: Record<'input' | 'output' | 'history', { accent: string; label: string }> = {
  input: { accent: color.blue, label: '入力' },
  output: { accent: color.green, label: '出力' },
  history: { accent: color.purple, label: '履歴' },
};

// 役割ラベル付きのカード。左アクセントバー＋ヘッダのバッジで役割をひと目で区別する。
const Section: React.FC<{
  role: 'input' | 'output' | 'history';
  title: string;
  children: React.ReactNode;
}> = ({ role, title, children }) => {
  const { accent, label } = SECTION_META[role];
  return (
    <div
      style={{
        backgroundColor: color.surface,
        borderRadius: radius.md,
        borderLeft: `4px solid ${accent}`,
        boxShadow: shadow.sm,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space.xs,
          padding: `6px ${space.md}`,
          backgroundColor: `${accent}14`, // 8% 程度の薄い同系色
          borderBottom: `1px solid ${accent}33`,
        }}
      >
        <span
          style={{
            fontSize: '10px',
            fontWeight: 'bold',
            color: color.surface,
            backgroundColor: accent,
            borderRadius: radius.sm,
            padding: '1px 6px',
          }}
        >
          {label}
        </span>
        <strong style={{ fontSize: '13px', color: color.text }}>{title}</strong>
      </div>
      <div style={{ padding: space.md }}>{children}</div>
    </div>
  );
};

// カーソル追従のホバーツールチップ。改行（\n）を保持。
// body 直下にポータルで描画し、サイドバーの overflow によるクリッピングを回避する。
const HoverTip: React.FC<{ text: string; children: React.ReactNode }> = ({ text, children }) => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  if (!text) return <>{children}</>;
  return (
    <span
      onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
      style={{ cursor: 'help', textDecoration: 'underline dotted' }}
    >
      {children}
      {pos &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: pos.x + 12,
              top: pos.y + 16,
              maxWidth: '280px',
              backgroundColor: '#202124',
              color: 'white',
              padding: '6px 9px',
              borderRadius: radius.sm,
              fontSize: '11px',
              lineHeight: 1.5,
              whiteSpace: 'pre',
              boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
              zIndex: 9999,
              pointerEvents: 'none',
            }}
          >
            {text}
          </div>,
          document.body
        )}
    </span>
  );
};

// 高さ上限つきのスクロール領域。下端のグリップをドラッグで高さ変更でき、
// 値は localStorage に保持する（縦長リストをユーザー好みの高さに収める用途）。
const ResizableScroll: React.FC<{
  storageKey: string;
  defaultHeight: number;
  min?: number;
  max?: number;
  children: React.ReactNode;
}> = ({ storageKey, defaultHeight, min = 240, max = 800, children }) => {
  const [height, setHeight] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved > 0 ? saved : defaultHeight;
  });
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(storageKey, String(height));
  }, [storageKey, height]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      const next = startRef.current.h + (e.clientY - startRef.current.y);
      setHeight(Math.min(Math.max(next, min), max));
    };
    const stop = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
    };
  }, [dragging, min, max]);

  return (
    <div>
      <div
        style={{
          height: `${height}px`,
          overflowY: 'auto',
          marginRight: '-4px',
          paddingRight: '4px',
        }}
      >
        {children}
      </div>
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          startRef.current = { y: e.clientY, h: height };
          setDragging(true);
        }}
        title="ドラッグで高さを調整"
        style={{
          height: '12px',
          marginTop: '2px',
          cursor: 'ns-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          style={{
            width: '28px',
            height: '3px',
            borderRadius: radius.pill,
            backgroundColor: dragging ? color.purple : color.borderStrong,
          }}
        />
      </div>
    </div>
  );
};

// 結果サマリの主要 KPI を見せる小カード
const StatCard: React.FC<{ label: string; value: string; accent: string }> = ({
  label,
  value,
  accent,
}) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      backgroundColor: `${accent}10`,
      border: `1px solid ${accent}30`,
      borderRadius: radius.sm,
      padding: '6px 8px',
      textAlign: 'center',
    }}
  >
    <div style={{ fontSize: '15px', fontWeight: 700, color: accent, lineHeight: 1.2 }}>
      {value}
    </div>
    <div style={{ fontSize: '10px', color: color.textSub, marginTop: '2px' }}>{label}</div>
  </div>
);

// 地図上の色凡例（S/E/Pickup/Delivery）
const MapLegend: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: space.md,
      bottom: space.md,
      backgroundColor: 'rgba(255,255,255,0.95)',
      borderRadius: radius.md,
      boxShadow: shadow.sm,
      padding: `${space.sm} ${space.md}`,
      display: 'flex',
      flexDirection: 'column',
      gap: space.xs,
      fontSize: '11px',
      color: color.textSub,
      zIndex: 2,
    }}
  >
    {(
      [
        [MODE_COLORS.start, '出発 (S)'],
        [MODE_COLORS.end, '帰着 (E)'],
        [MODE_COLORS.pickup, 'Pickup'],
        [MODE_COLORS.delivery, 'Delivery'],
      ] as Array<[string, string]>
    ).map(([c, label]) => (
      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: space.xs }}>
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: radius.pill,
            backgroundColor: c,
            border: '1.5px solid white',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
            flexShrink: 0,
          }}
        />
        {label}
      </div>
    ))}
  </div>
);

export function EditorPage() {
  const [mode, setMode] = useState<Mode>('pickup');
  const [pickups, setPickups] = useState<Point[]>([]);
  const [deliveries, setDeliveries] = useState<Point[]>([]);
  const [start, setStart] = useState<LatLng | null>(null);
  const [end, setEnd] = useState<LatLng | null>(null);
  const [vehicleCost, setVehicleCost] = useState<VehicleCost>(DEFAULT_VEHICLE_COST);
  const [globalWindow, setGlobalWindow] = useState<GlobalWindow>(DEFAULT_GLOBAL_WINDOW);
  const [result, setResult] = useState<OptimizeResponse | null>(null);

  // 計算履歴（入力＋結果）。localStorage に永続化し、favorite で履歴/お気に入りを分ける。
  const [snapshots, setSnapshots] = useState<CalcSnapshot[]>(() => loadSnapshots());
  const [historyTab, setHistoryTab] = useState<'history' | 'favorite' | 'sample'>('history');
  // ラベルのインライン編集（編集中のスナップショット id と入力中テキスト）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  useEffect(() => {
    persistSnapshots(snapshots);
  }, [snapshots]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentLocation, setCurrentLocation] = useState<LatLng | null>(null);
  const [geoError, setGeoError] = useState<string | null>(() =>
    typeof navigator !== 'undefined' && navigator.geolocation
      ? null
      : 'このブラウザは Geolocation 非対応です'
  );
  const mapRef = useRef<google.maps.Map | null>(null);
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  // マップ／サイドバーの境界をドラッグでリサイズ。幅は localStorage に永続化。
  const containerRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 340;
  });
  const [resizing, setResizing] = useState(false);

  // 幅が変わるたびに保存（ドラッグ中も含め最新値を残す）
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      // 右端からカーソルまでの距離 = サイドバー幅。最小 240px / マップ最小 320px に制限。
      const w = rect.right - e.clientX;
      setSidebarWidth(Math.min(Math.max(w, 240), rect.width - 320));
    };
    const stop = () => setResizing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
    };
  }, [resizing]);

  // 初期表示は GPS 現在地に。失敗時は DEFAULT_CENTER（東京駅）にフォールバック。
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc: LatLng = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
        setCurrentLocation(loc);
        // map が既に init 済みなら現在地に panTo
        mapRef.current?.panTo({ lat: loc.latitude, lng: loc.longitude });
      },
      (err) => {
        setGeoError(`現在地取得失敗: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  const handleMapClick = (e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    const loc: LatLng = { latitude: e.latLng.lat(), longitude: e.latLng.lng() };
    setResult(null);
    setError(null);
    if (mode === 'pickup') setPickups((arr) => [...arr, { loc }]);
    else if (mode === 'delivery') setDeliveries((arr) => [...arr, { loc }]);
    else if (mode === 'start') setStart(loc);
    else if (mode === 'end') setEnd(loc);
  };

  const removePickup = (idx: number) => {
    setPickups((arr) => arr.filter((_, i) => i !== idx));
    setResult(null);
  };
  const removeDelivery = (idx: number) => {
    setDeliveries((arr) => arr.filter((_, i) => i !== idx));
    setResult(null);
  };

  const updatePickup = (idx: number, patch: Partial<Point>) => {
    setPickups((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
    setResult(null);
  };
  const updateDelivery = (idx: number, patch: Partial<Point>) => {
    setDeliveries((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
    setResult(null);
  };

  const reset = () => {
    setPickups([]);
    setDeliveries([]);
    setStart(null);
    setEnd(null);
    setResult(null);
    setError(null);
  };

  // 履歴のスナップショットをエディタに復元（入力一式 + 結果を反映）
  const restoreSnapshot = (snap: CalcSnapshot) => {
    setPickups(snap.input.pickups);
    setDeliveries(snap.input.deliveries);
    setStart(snap.input.start);
    setEnd(snap.input.end);
    setVehicleCost(snap.input.vehicleCost);
    setGlobalWindow(snap.input.globalWindow ?? DEFAULT_GLOBAL_WINDOW);
    setResult(snap.result ?? null); // サンプル等、結果未計算なら地図はマーカーのみ
    setError(null);
  };

  const toggleFavorite = (id: string) =>
    setSnapshots((prev) =>
      prev.map((s) => (s.id === id ? { ...s, favorite: !s.favorite } : s))
    );

  const startEditLabel = (s: CalcSnapshot) => {
    setEditingId(s.id);
    setDraftLabel(s.label ?? '');
  };
  const commitEditLabel = () => {
    if (editingId) {
      const label = draftLabel.trim();
      setSnapshots((prev) =>
        prev.map((s) => (s.id === editingId ? { ...s, label: label || undefined } : s))
      );
    }
    setEditingId(null);
  };

  const deleteSnapshot = (id: string) =>
    setSnapshots((prev) => prev.filter((s) => s.id !== id));

  // サンプルタブは固定サンプル、それ以外は履歴（お気に入りは favorite で絞り込み）
  const isSampleTab = historyTab === 'sample';
  const visibleSnapshots = isSampleTab
    ? SAMPLE_SNAPSHOTS
    : snapshots.filter((s) => (historyTab === 'favorite' ? s.favorite : true));
  const favoriteCount = snapshots.filter((s) => s.favorite).length;

  const canCalculate =
    !!start && !!end && pickups.length > 0 && pickups.length === deliveries.length;

  const hasAnyPoint = !!start || !!end || pickups.length > 0 || deliveries.length > 0;

  const calculate = async () => {
    if (!start || !end || !canCalculate) return;
    // 前回の最適化結果（optimizedPath / visitOrder）を fetch 開始前に確実に視覚リセット。
    // flushSync で同期的に再描画させ、高速レスポンス時でも一瞬リセットが見えるようにする。
    flushSync(() => {
      setLoading(true);
      setError(null);
      setResult(null);
    });
    try {
      const body = buildRequest(pickups, deliveries, start, end, vehicleCost, globalWindow);
      const res = await fetch(`${apiBase}/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`${res.status}: ${errBody.error ?? res.statusText}`);
      }
      const data = (await res.json()) as OptimizeResponse;
      setResult(data);
      // 入力と結果のスナップショットを履歴に追加
      const snap: CalcSnapshot = {
        id: makeId(),
        createdAt: Date.now(),
        favorite: false,
        input: { pickups, deliveries, start, end, vehicleCost, globalWindow },
        result: data,
      };
      setSnapshots((prev) => addSnapshot(prev, snap));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // 道路に沿った最適化ルート（routes[].routePolyline.points を Maps geometry でデコード）
  // populatePolylines:true をリクエストで指定したことで返される encoded polyline を使う
  const optimizedPath = useMemo(() => {
    const encoded = result?.routes?.[0]?.routePolyline?.points;
    if (!encoded) return null;
    const decoder = window.google?.maps?.geometry?.encoding?.decodePath;
    if (!decoder) return null;
    return decoder(encoded).map((p) => ({ latitude: p.lat(), longitude: p.lng() }));
  }, [result]);

  // Polyline を imperative に管理：optimizedPath が変わるたびに必ず古いものを破棄して新規作成。
  // @react-google-maps/api の <Polyline> は再計算時にゴーストが残ることがあるため。
  useEffect(() => {
    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }
    if (!optimizedPath || !mapRef.current) return;
    polylineRef.current = new google.maps.Polyline({
      path: optimizedPath.map((p) => ({ lat: p.latitude, lng: p.longitude })),
      strokeColor: '#4285F4',
      strokeWeight: 3,
      strokeOpacity: 0.85,
      icons: [
        {
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
          offset: '0',
          repeat: '20px',
        },
      ],
      map: mapRef.current,
    });
  }, [optimizedPath]);

  // ページアンマウント時の cleanup
  useEffect(
    () => () => {
      polylineRef.current?.setMap(null);
      polylineRef.current = null;
    },
    []
  );

  const visitOrder = useMemo(() => {
    if (!result) return new Map<string, number>();
    const route = result.routes?.[0];
    if (!route) return new Map<string, number>();
    const map = new Map<string, number>();
    (route.visits ?? []).forEach((v, idx) => {
      const key = `${v.isPickup ? 'p' : 'd'}-${v.shipmentIndex ?? 0}`;
      map.set(key, idx + 1);
    });
    return map;
  }, [result]);

  // ソフト違反（遅着/早着）ペナルティの計算式ツールチップ。
  // 各 visit の超過分 × 地点の時間あたりコストを並べ、合計を末尾に付ける。
  const softCostTooltips = useMemo(() => {
    const route = result?.routes?.[0];
    const make = (kind: 'late' | 'early'): string => {
      const lines = (route?.visits ?? [])
        .map((v) => {
          const si = v.shipmentIndex ?? 0;
          const pt = v.isPickup ? pickups[si] : deliveries[si];
          const viol = softViolation(pt, v.startTime);
          if (!pt || !viol || viol.kind !== kind) return null;
          const perHour =
            kind === 'late'
              ? pt.costPerHourAfterSoftEndTime ?? DEFAULT_SOFT_COST
              : pt.costPerHourBeforeSoftStartTime ?? DEFAULT_SOFT_COST;
          const amount = (perHour * viol.seconds) / 3600;
          const word = kind === 'late' ? '遅延' : '早着';
          return {
            line: `${v.isPickup ? 'P' : 'D'}${si + 1}: ${word}${formatMinSec(viol.seconds)} × ${perHour}/h = ${amount.toFixed(2)}`,
            amount,
          };
        })
        .filter((x): x is { line: string; amount: number } => x !== null);
      if (lines.length === 0) return '';
      const total = lines.reduce((sum, l) => sum + l.amount, 0);
      const header = kind === 'late' ? '遅着ペナルティの内訳' : '早着ペナルティの内訳';
      return [header, ...lines.map((l) => l.line), `合計 ${total.toFixed(2)}`].join('\n');
    };
    return { late: make('late'), early: make('early') };
  }, [result, pickups, deliveries]);

  const center = useMemo(() => {
    const all: LatLng[] = [
      ...pickups.map((p) => p.loc),
      ...deliveries.map((p) => p.loc),
      ...(start ? [start] : []),
      ...(end ? [end] : []),
    ];
    if (all.length === 0) return currentLocation ?? DEFAULT_CENTER;
    const sum = all.reduce(
      (acc, p) => ({ latitude: acc.latitude + p.latitude, longitude: acc.longitude + p.longitude }),
      { latitude: 0, longitude: 0 }
    );
    return { latitude: sum.latitude / all.length, longitude: sum.longitude / all.length };
  }, [pickups, deliveries, start, end, currentLocation]);

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
      {/* リサイズ中は iframe(マップ) がマウスイベントを奪うのを防ぐ透明オーバーレイ */}
      {resizing && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            cursor: 'col-resize',
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={{ lat: center.latitude, lng: center.longitude }}
          zoom={15}
          onLoad={(map) => {
            mapRef.current = map;
          }}
          onClick={handleMapClick}
          options={{ draggableCursor: 'crosshair' }}
        >
          {currentLocation && (
            <Marker
              position={{ lat: currentLocation.latitude, lng: currentLocation.longitude }}
              title="現在地"
              icon={{
                path: window.google?.maps?.SymbolPath?.CIRCLE,
                scale: 8,
                fillColor: '#1A73E8',
                fillOpacity: 1,
                strokeColor: 'white',
                strokeWeight: 3,
              }}
              clickable={false}
              zIndex={1}
            />
          )}
          {start && (
            <Marker
              position={{ lat: start.latitude, lng: start.longitude }}
              title="出発"
              label={{ text: 'S', color: 'white', fontWeight: 'bold' }}
              icon={{
                path: window.google?.maps?.SymbolPath?.CIRCLE,
                scale: 14,
                fillColor: MODE_COLORS.start,
                fillOpacity: 1,
                strokeColor: 'white',
                strokeWeight: 2,
              }}
            />
          )}
          {end && (
            <Marker
              position={{ lat: end.latitude, lng: end.longitude }}
              title="帰着"
              label={{ text: 'E', color: 'white', fontWeight: 'bold' }}
              icon={{
                path: window.google?.maps?.SymbolPath?.CIRCLE,
                scale: 14,
                fillColor: MODE_COLORS.end,
                fillOpacity: 1,
                strokeColor: 'white',
                strokeWeight: 2,
              }}
            />
          )}
          {pickups.map((p, idx) => {
            const order = visitOrder.get(`p-${idx}`);
            return (
              <Marker
                key={`p-${idx}`}
                position={{ lat: p.loc.latitude, lng: p.loc.longitude }}
                title={`Pickup ${idx + 1}`}
                label={{
                  text: order ? String(order) : `P${idx + 1}`,
                  color: 'white',
                  fontWeight: 'bold',
                  fontSize: '11px',
                }}
                icon={{
                  path: window.google?.maps?.SymbolPath?.CIRCLE,
                  scale: 12,
                  fillColor: MODE_COLORS.pickup,
                  fillOpacity: 1,
                  strokeColor: 'white',
                  strokeWeight: 2,
                }}
              />
            );
          })}
          {deliveries.map((d, idx) => {
            const order = visitOrder.get(`d-${idx}`);
            return (
              <Marker
                key={`d-${idx}`}
                position={{ lat: d.loc.latitude, lng: d.loc.longitude }}
                title={`Delivery ${idx + 1}`}
                label={{
                  text: order ? String(order) : `D${idx + 1}`,
                  color: 'white',
                  fontWeight: 'bold',
                  fontSize: '11px',
                }}
                icon={{
                  path: window.google?.maps?.SymbolPath?.CIRCLE,
                  scale: 12,
                  fillColor: MODE_COLORS.delivery,
                  fillOpacity: 1,
                  strokeColor: 'white',
                  strokeWeight: 2,
                }}
              />
            );
          })}
          {/* Polyline は polylineRef による imperative 管理（useEffect 内）。JSX では描画しない */}
        </GoogleMap>

        {/* 色凡例 */}
        <MapLegend />

        {/* 空状態：地点が 1 つも無いときの操作ヒント */}
        {!hasAnyPoint && (
          <div
            style={{
              position: 'absolute',
              top: space.lg,
              left: '50%',
              transform: 'translateX(-50%)',
              backgroundColor: 'rgba(32,33,36,0.82)',
              color: 'white',
              borderRadius: radius.pill,
              padding: `${space.sm} ${space.lg}`,
              fontSize: '12px',
              boxShadow: shadow.sm,
              zIndex: 2,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            地図をクリックして地点を追加（種別は右パネルで選択）
          </div>
        )}
      </div>

      {/* ドラッグでマップ／サイドバーの幅を調整する仕切り */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          setResizing(true);
        }}
        title="ドラッグで幅を調整"
        style={{
          width: '6px',
          flexShrink: 0,
          cursor: 'col-resize',
          backgroundColor: resizing ? '#4285F4' : '#ddd',
          transition: resizing ? 'none' : 'background-color 0.15s',
        }}
      />

      <div
        style={{
          width: `${sidebarWidth}px`,
          flexShrink: 0,
          backgroundColor: '#f5f5f5',
          padding: '20px',
          overflowY: 'auto',
          borderLeft: '1px solid #ddd',
          fontSize: '13px',
        }}
      >
        {/* 幅に応じて自動段組み（CSS マルチカラム）。狭いと 1 列、広いと複数列に流れ込み、
            間延びを防ぐ。各セクションは列内で分割されないよう break-inside: avoid。
            カラム内のカード間隔は 16px。末尾カードには付けず、領域間の間隔は外側 flex の gap に統一。 */}
        <style>{`
          .editor-sections { column-width: 300px; column-gap: 16px; }
          .editor-sections > * { break-inside: avoid; }
          .editor-sections > *:not(:last-child) { margin-bottom: 16px; }
        `}</style>
        {/* 入力カラム / 計算ボタン / 出力カラム の 3 領域。間隔は gap で一律 16px。 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div className="editor-sections">

        {geoError && (
          <div
            style={{
              backgroundColor: '#fef7e0',
              color: '#996300',
              padding: '8px 10px',
              borderRadius: '4px',
              marginBottom: '12px',
              fontSize: '11px',
            }}
          >
            {geoError}（東京駅を初期表示）
          </div>
        )}

        <Section role="input" title="クリック時に追加する種別">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            {(['pickup', 'delivery', 'start', 'end'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  padding: '8px',
                  border: mode === m ? `2px solid ${MODE_COLORS[m]}` : '1px solid #ccc',
                  backgroundColor: mode === m ? MODE_COLORS[m] : 'white',
                  color: mode === m ? 'white' : '#333',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: mode === m ? 'bold' : 'normal',
                }}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <p style={{ color: '#666', fontSize: '11px', marginTop: '6px', marginBottom: 0 }}>
            地図をクリックして配置。Pickup と Delivery は同数必要、index 順にペア。
          </p>
        </Section>

        <Section role="input" title="グローバル時間枠（最適化の全体範囲）">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#444' }}>
            <span style={{ fontSize: '12px' }}>開始</span>
            <input
              type="time"
              value={globalWindow.start}
              onChange={(e) => {
                setGlobalWindow((w) => ({ ...w, start: e.target.value || DEFAULT_GLOBAL_WINDOW.start }));
                setResult(null);
              }}
              style={{ fontSize: '12px', padding: '3px 4px' }}
            />
            <span style={{ fontSize: '12px' }}>〜</span>
            <span style={{ fontSize: '12px' }}>終了</span>
            <input
              type="time"
              value={globalWindow.end}
              onChange={(e) => {
                setGlobalWindow((w) => ({ ...w, end: e.target.value || DEFAULT_GLOBAL_WINDOW.end }));
                setResult(null);
              }}
              style={{ fontSize: '12px', padding: '3px 4px' }}
            />
          </div>
          <p style={{ color: '#666', fontSize: '11px', marginTop: '6px', marginBottom: 0 }}>
            全ルートがこの範囲内で完結します。各地点のハード／ソフト枠はこの範囲に収めてください。
          </p>
          {(globalWindow.start !== DEFAULT_GLOBAL_WINDOW.start ||
            globalWindow.end !== DEFAULT_GLOBAL_WINDOW.end) && (
            <button
              onClick={() => {
                setGlobalWindow(DEFAULT_GLOBAL_WINDOW);
                setResult(null);
              }}
              title="デフォルト（00:00〜23:59）に戻す"
              style={{ ...CLEAR_BTN_STYLE, marginTop: '6px' }}
            >
              デフォルトに戻す
            </button>
          )}
        </Section>

        <Section role="input" title="車両コスト（最適化パラメータ）">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: '6px 8px',
              alignItems: 'center',
            }}
          >
            {(
              [
                { key: 'costPerHour', label: '時間あたり (/h)', hint: '経過時間＝移動＋待機の1時間あたりコスト' },
                {
                  key: 'costPerTraveledHour',
                  label: '実移動時間あたり (/h)',
                  hint: '待機を除く実移動1時間あたりコスト',
                },
                { key: 'costPerKilometer', label: '距離あたり (/km)', hint: '移動距離1kmあたりコスト' },
                { key: 'fixedCost', label: '固定費', hint: '車両を使うこと自体の固定コスト' },
              ] as Array<{ key: keyof VehicleCost; label: string; hint: string }>
            ).map(({ key, label, hint }) => (
              <Fragment key={key}>
                <label title={hint} style={{ fontSize: '12px', color: '#444' }}>
                  {label}
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  // 0 は「コストなし」を意味し、リクエストにも含めない（下の補足参照）。
                  // 0 を空表示にしておかないと、値型の制御 input がキー入力のたびに
                  // "0" を差し戻し、フィールドを消去・編集できず「キーボードで打てない」状態になる。
                  value={vehicleCost[key] === 0 ? '' : vehicleCost[key]}
                  placeholder="0"
                  onChange={(e) => {
                    const v = e.target.value === '' ? 0 : Number(e.target.value);
                    setVehicleCost((c) => ({ ...c, [key]: v }));
                    setResult(null);
                  }}
                  style={{ fontSize: '12px', padding: '3px 4px', width: '70px', textAlign: 'right' }}
                />
              </Fragment>
            ))}
          </div>
          <p style={{ color: '#666', fontSize: '11px', marginTop: '6px' }}>
            ソフト制約の違反コストとの<strong>相対値</strong>で挙動が決まります。0 のコストはリクエストに含めません。
          </p>
          <button
            onClick={() => {
              setVehicleCost(DEFAULT_VEHICLE_COST);
              setResult(null);
            }}
            style={{
              marginTop: '4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: '#999',
              fontSize: '11px',
              padding: 0,
            }}
          >
            デフォルトに戻す
          </button>
        </Section>

        <Section role="input" title="地点リスト">
          <ResizableScroll storageKey="editor.pointListHeight" defaultHeight={240}>
            <div style={{ marginBottom: '8px' }}>
              <strong style={{ color: MODE_COLORS.start }}>S 出発:</strong>{' '}
              {start ? formatLatLng(start) : <em style={{ color: '#999' }}>未設定</em>}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <strong style={{ color: MODE_COLORS.end }}>E 帰着:</strong>{' '}
              {end ? formatLatLng(end) : <em style={{ color: '#999' }}>未設定</em>}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <strong style={{ color: MODE_COLORS.pickup }}>Pickup ({pickups.length})</strong>
              {pickups.map((p, idx) => (
                <PointRow
                  key={idx}
                  prefix={`P${idx + 1}`}
                  point={p}
                  onRemove={() => removePickup(idx)}
                  onChange={(patch) => updatePickup(idx, patch)}
                  showPenalty
                />
              ))}
            </div>
            <div>
              <strong style={{ color: MODE_COLORS.delivery }}>
                Delivery ({deliveries.length})
              </strong>
              {deliveries.map((d, idx) => (
                <PointRow
                  key={idx}
                  prefix={`D${idx + 1}`}
                  point={d}
                  onRemove={() => removeDelivery(idx)}
                  onChange={(patch) => updateDelivery(idx, patch)}
                />
              ))}
            </div>
          </ResizableScroll>
        </Section>
        </div>

        {/* アクション（計算実行）。入力/出力カードと区別できるようオレンジ系の枠で強調。
            マルチカラムの外（全幅）に置くことで、結果カードの高さ変化に伴う段組み再配置で
            ボタン位置が飛び跳ねるのを防ぐ。 */}
        <div
          style={{
            backgroundColor: '#fff7e6',
            border: '1px solid #f6c453',
            borderRadius: '6px',
            padding: '10px',
          }}
        >
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={calculate}
              disabled={!canCalculate || loading}
              style={{
                flex: 1,
                padding: '12px',
                fontSize: '14px',
                backgroundColor: canCalculate && !loading ? '#F9AB00' : '#ccc',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: canCalculate && !loading ? 'pointer' : 'not-allowed',
                fontWeight: 'bold',
                boxShadow: canCalculate && !loading ? '0 1px 3px rgba(249,171,0,0.5)' : 'none',
              }}
            >
              {loading ? '計算中...' : '▶ 最適化を計算'}
            </button>
            <button
              onClick={reset}
              style={{
                padding: '12px',
                backgroundColor: 'white',
                border: '1px solid #ccc',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              クリア
            </button>
          </div>

          {!canCalculate && (
            <p style={{ color: '#a36b00', fontSize: '11px', margin: '8px 0 0' }}>
              S/E と Pickup×N + Delivery×N（同数）が必要です。
            </p>
          )}
        </div>

        {error && (
          <div
            style={{
              backgroundColor: '#fce8e6',
              color: '#c5221f',
              padding: '10px',
              borderRadius: '4px',
              fontSize: '12px',
              wordBreak: 'break-all',
            }}
          >
            <strong>エラー:</strong> {error}
          </div>
        )}

        {/* 出力・履歴は別のマルチカラム領域に分離（入力側・計算ボタンと独立して段組み） */}
        <div className="editor-sections">
        {/* 結果セクションは常に存在させ、内容だけ切り替える（サンプル切替時のチラつき防止） */}
        <Section role="output" title="結果">
          {result?.routes?.[0] ? (
            <div>
              {/* 主要 KPI（移動時間・距離・合計コスト） */}
              <div style={{ display: 'flex', gap: space.xs, marginBottom: space.md }}>
                <StatCard
                  label="移動時間"
                  value={formatDuration(result.routes[0].metrics?.travelDuration)}
                  accent={color.green}
                />
                <StatCard
                  label="距離"
                  value={formatDistance(result.routes[0].metrics?.travelDistanceMeters)}
                  accent={color.blue}
                />
                <StatCard
                  label="合計コスト"
                  value={formatCost(
                    result.routes[0].routeTotalCost ?? result.metrics?.totalCost
                  )}
                  accent={color.orange}
                />
              </div>
              <p style={{ marginTop: 0, marginBottom: '4px' }}>
                <strong>訪問スケジュール:</strong>
              </p>
              <ol style={{ paddingLeft: '20px', margin: 0, listStyle: 'none' }}>
                <li style={{ marginBottom: '4px', color: MODE_COLORS.start }}>
                  <strong>{formatTime(result.routes[0].vehicleStartTime)}</strong> 出発（S）
                </li>
                {(result.routes[0].visits ?? []).map((v, idx) => {
                  const si = v.shipmentIndex ?? 0;
                  const pt = v.isPickup ? pickups[si] : deliveries[si];
                  const viol = softViolation(pt, v.startTime);
                  return (
                    <li key={idx} style={{ marginBottom: '4px' }}>
                      <strong style={{ color: viol?.kind === 'late' ? color.red : undefined }}>
                        {formatTime(v.startTime)}
                      </strong>{' '}
                      <span
                        style={{ color: v.isPickup ? MODE_COLORS.pickup : MODE_COLORS.delivery }}
                      >
                        {v.isPickup ? 'Pickup' : 'Delivery'} Shipment {si + 1}
                      </span>
                      {viol && (
                        <span
                          style={{
                            marginLeft: '6px',
                            fontSize: '10px',
                            fontWeight: 'bold',
                            color: viol.kind === 'late' ? color.red : color.blue,
                            backgroundColor: viol.kind === 'late' ? '#fce8e6' : '#e8f0fe',
                            borderRadius: radius.sm,
                            padding: '0 4px',
                          }}
                        >
                          {viol.kind === 'late'
                            ? `遅延 +${formatMinSec(viol.seconds)}`
                            : `早着 -${formatMinSec(viol.seconds)}`}
                        </span>
                      )}
                    </li>
                  );
                })}
                <li style={{ color: MODE_COLORS.end }}>
                  <strong>{formatTime(result.routes[0].vehicleEndTime)}</strong> 帰着（E）
                </li>
              </ol>

              {/* 所要時間の内訳（計算過程の各要素） */}
              <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '10px 0' }} />
              <p style={{ marginBottom: '4px' }}>
                <strong>所要時間内訳:</strong>
              </p>
              <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                <tbody>
                  {(
                    [
                      ['移動', result.routes[0].metrics?.travelDuration],
                      ['待機', result.routes[0].metrics?.waitDuration],
                      ['遅延', result.routes[0].metrics?.delayDuration],
                      ['訪問', result.routes[0].metrics?.visitDuration],
                      ['休憩', result.routes[0].metrics?.breakDuration],
                      ['合計', result.routes[0].metrics?.totalDuration],
                    ] as Array<[string, string | undefined]>
                  )
                    .filter(([, v]) => v !== undefined)
                    .map(([label, v]) => (
                      <tr key={label}>
                        <td style={{ color: '#666', padding: '1px 0' }}>{label}</td>
                        <td style={{ textAlign: 'right' }}>{formatDuration(v)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>

              {/* コスト内訳（最適化の目的関数の各要素がいくらだったか） */}
              {result.routes[0].routeCosts &&
                Object.keys(result.routes[0].routeCosts).length > 0 && (
                  <>
                    <hr
                      style={{ border: 'none', borderTop: '1px solid #eee', margin: '10px 0' }}
                    />
                    <p style={{ marginBottom: '4px' }}>
                      <strong>コスト内訳:</strong>
                    </p>
                    <table
                      style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}
                    >
                      <tbody>
                        {Object.entries(result.routes[0].routeCosts).map(([key, val]) => {
                          const { label, penalty } = costInfo(key);
                          // 遅着/早着ペナルティ行には計算式のツールチップを出す
                          const formula = /after_soft_end_time/.test(key)
                            ? softCostTooltips.late
                            : /before_soft_start_time/.test(key)
                              ? softCostTooltips.early
                              : '';
                          const hasFormula = formula.length > 0;
                          return (
                            <tr key={key}>
                              <td
                                style={{
                                  color: penalty ? '#d56e0c' : '#666',
                                  padding: '1px 0',
                                  fontWeight: penalty ? 'bold' : 'normal',
                                }}
                                title={hasFormula ? undefined : key}
                              >
                                {penalty ? '⚠ ' : ''}
                                {hasFormula ? (
                                  <HoverTip text={formula}>
                                    {label} ⓘ
                                  </HoverTip>
                                ) : (
                                  label
                                )}
                              </td>
                              <td
                                style={{
                                  textAlign: 'right',
                                  color: penalty ? '#d56e0c' : undefined,
                                  fontWeight: penalty ? 'bold' : 'normal',
                                }}
                              >
                                {formatCost(val)}
                              </td>
                            </tr>
                          );
                        })}
                        {(() => {
                          // ソフト制約違反（早着/遅着/スキップ）の合計を小計として強調表示
                          const violation = Object.entries(result.routes[0].routeCosts ?? {})
                            .filter(([key]) => costInfo(key).penalty)
                            .reduce((sum, [, v]) => sum + v, 0);
                          if (violation <= 0) return null;
                          return (
                            <tr style={{ borderTop: '1px dashed #f0c89a' }}>
                              <td style={{ color: '#d56e0c', padding: '2px 0 2px 12px' }}>
                                うち制約違反ペナルティ
                              </td>
                              <td
                                style={{
                                  textAlign: 'right',
                                  color: '#d56e0c',
                                  fontWeight: 'bold',
                                }}
                              >
                                {formatCost(violation)}
                              </td>
                            </tr>
                          );
                        })()}
                        <tr style={{ borderTop: '1px solid #ddd' }}>
                          <td style={{ fontWeight: 'bold', padding: '2px 0' }}>合計コスト</td>
                          <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                            {formatCost(
                              result.routes[0].routeTotalCost ?? result.metrics?.totalCost
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </>
                )}

              {/* スキップされた shipment（ペナルティを払って未配送にしたもの） */}
              {result.skippedShipments && result.skippedShipments.length > 0 && (
                <>
                  <hr
                    style={{ border: 'none', borderTop: '1px solid #eee', margin: '10px 0' }}
                  />
                  <p style={{ marginBottom: '4px', color: '#c5221f' }}>
                    <strong>スキップ（未配送）:</strong>
                  </p>
                  <ul style={{ paddingLeft: '18px', margin: 0, color: '#c5221f' }}>
                    {result.skippedShipments.map((s, idx) => (
                      <li key={idx}>
                        {s.label ?? `Shipment ${(s.index ?? 0) + 1}`}
                        {s.reasons?.[0]?.code ? `（${s.reasons[0].code}）` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: space.sm,
                padding: '24px 12px',
                textAlign: 'center',
                color: color.textMuted,
              }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke={color.borderStrong}
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="6" cy="19" r="2" />
                <circle cx="18" cy="5" r="2" />
                <path d="M8 19h6a3 3 0 0 0 3-3V8" strokeDasharray="0.1 3" />
              </svg>
              <div style={{ fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                {loading
                  ? '計算中…'
                  : canCalculate
                    ? '「最適化を計算」を押すと\nここに結果が表示されます'
                    : '地点を配置して計算すると\nここに結果が表示されます'}
              </div>
            </div>
          )}
        </Section>

        <Section role="history" title="計算履歴">
          {/* 履歴 / お気に入り タブ */}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
            {(
              [
                ['history', `履歴 (${snapshots.length})`],
                ['favorite', `★ (${favoriteCount})`],
                ['sample', `サンプル (${SAMPLE_SNAPSHOTS.length})`],
              ] as Array<['history' | 'favorite' | 'sample', string]>
            ).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setHistoryTab(tab)}
                style={{
                  flex: 1,
                  padding: '5px 8px',
                  fontSize: '11px',
                  borderRadius: '999px',
                  border: '1px solid',
                  borderColor: historyTab === tab ? '#9334E6' : '#ddd',
                  backgroundColor: historyTab === tab ? '#9334E6' : 'white',
                  color: historyTab === tab ? 'white' : '#666',
                  fontWeight: historyTab === tab ? 'bold' : 'normal',
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {visibleSnapshots.length === 0 ? (
            <p style={{ color: '#999', fontSize: '11px', margin: 0 }}>
              {historyTab === 'favorite'
                ? 'お気に入りはまだありません（★ で追加）'
                : 'まだ履歴がありません'}
            </p>
          ) : (
            <ResizableScroll storageKey="editor.historyHeight" defaultHeight={240}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {visibleSnapshots.map((s) => {
                const route = s.result?.routes?.[0];
                const cost = route?.routeTotalCost ?? s.result?.metrics?.totalCost;
                const isCurrent = !!s.result && result === s.result;
                return (
                  <li
                    key={s.id}
                    style={{
                      border: `1px solid ${isCurrent ? '#9334E6' : '#eee'}`,
                      borderRadius: '5px',
                      padding: '6px 8px',
                      marginBottom: '6px',
                      backgroundColor: isCurrent ? '#f8f0ff' : 'white',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      {editingId === s.id ? (
                        <input
                          autoFocus
                          value={draftLabel}
                          onChange={(e) => setDraftLabel(e.target.value)}
                          onBlur={commitEditLabel}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEditLabel();
                            else if (e.key === 'Escape') setEditingId(null);
                          }}
                          placeholder={formatStamp(s.createdAt)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: '11px',
                            fontWeight: 'bold',
                            padding: '1px 4px',
                            border: `1px solid ${color.purple}`,
                            borderRadius: radius.sm,
                          }}
                        />
                      ) : (
                        <span style={{ fontSize: '11px', color: '#444', fontWeight: 'bold' }}>
                          {s.label ?? formatStamp(s.createdAt)}
                        </span>
                      )}
                      {!isSampleTab && editingId !== s.id && (
                        <span style={{ display: 'flex', gap: '2px' }}>
                          <button
                            onClick={() => startEditLabel(s)}
                            title="ラベルを編集"
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              fontSize: '12px',
                              color: '#bbb',
                              padding: '0 2px',
                            }}
                          >
                            ✎
                          </button>
                          <button
                            onClick={() => toggleFavorite(s.id)}
                            title={s.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              fontSize: '13px',
                              color: s.favorite ? '#F9AB00' : '#ccc',
                              padding: '0 2px',
                            }}
                          >
                            {s.favorite ? '★' : '☆'}
                          </button>
                          <button
                            onClick={() => deleteSnapshot(s.id)}
                            title="削除"
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              fontSize: '12px',
                              color: '#bbb',
                              padding: '0 2px',
                            }}
                          >
                            🗑
                          </button>
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: '#666', margin: '2px 0 4px' }}>
                      荷物 {s.input.pickups.length}
                      {s.result ? (
                        <>
                          {' '}
                          ・ 距離 {formatDistance(route?.metrics?.travelDistanceMeters)} ・ コスト{' '}
                          {formatCost(cost)}
                          {s.result.skippedShipments && s.result.skippedShipments.length > 0
                            ? ` ・ skip ${s.result.skippedShipments.length}`
                            : ''}
                        </>
                      ) : (
                        <span style={{ color: '#999' }}> ・ 未計算（復元して計算）</span>
                      )}
                    </div>
                    <button
                      onClick={() => restoreSnapshot(s)}
                      style={{
                        width: '100%',
                        padding: '4px',
                        fontSize: '11px',
                        border: '1px solid #9334E6',
                        borderRadius: '4px',
                        backgroundColor: 'white',
                        color: '#9334E6',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                      }}
                    >
                      この条件を復元
                    </button>
                  </li>
                );
              })}
            </ul>
            </ResizableScroll>
          )}
        </Section>
        </div>
        </div>
      </div>
    </div>
  );
}
