// ソルバー Playground（実地図版 / 仮想フィールド版）で共通のサイドバー。
// 地点の選択・行列パラメータ・方向別ペナルティ・行列プレビュー・実行・結果・比較をまとめて描く。
// 2 種類で違うのは左側のキャンバス（Google マップ / 仮想フレーム）だけ。

import { useState } from 'react';
import { type BuiltMatrix, type PlaceBase, SYNC_PAYLOAD_LIMIT_BYTES } from '../lib/solverMatrix';
import {
  END_WINDOW_KEY,
  START_WINDOW_KEY,
  TODAY,
  type PlaceTimeWindow,
  type SolverModel,
} from '../lib/useSolverModel';
import { SOLVER_COLORS, smallButton } from '../lib/solverUi';
import { Section, StatCard } from './Section';
import { color, radius, shadow, space } from '../theme';

const START_COLOR = SOLVER_COLORS.start;
const END_COLOR = SOLVER_COLORS.end;
const STOP_COLOR = SOLVER_COLORS.stop;
const PENALTY_COLOR = SOLVER_COLORS.penalty;

// --- 表示ヘルパー -----------------------------------------------------------
const secOf = (v?: string) => Number((v ?? '0s').replace('s', ''));
const fmtDur = (v?: string) => {
  const s = secOf(v);
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
  return base && dateOf(iso) !== dateOf(base) ? `${dateOf(iso)} ${t}` : t;
};
// 自動延長した終了時刻など、日付まで見せたいとき用
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: JST,
  });
const fmtKm = (m?: number) => `${((m ?? 0) / 1000).toFixed(1)} km`;
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
// 行列の見出し用。「神奈川県庁」→「神奈」
const shortName = (name: string) => name.slice(0, 2);

const dateInputStyle: React.CSSProperties = {
  width: '80px',
  flexShrink: 0,
  padding: '2px 4px',
  border: `1px solid ${color.borderStrong}`,
  borderRadius: radius.sm,
  fontSize: '11px',
};

// 数値入力（小さめ・ラベル付き）
const NumberField: React.FC<{
  label: string;
  value: number;
  step?: number;
  min?: number;
  suffix?: string;
  onChange: (v: number) => void;
}> = ({ label, value, step = 1, min = 0, suffix, onChange }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: space.xs, fontSize: '11px' }}>
    <span style={{ color: color.textSub, flex: 1 }}>{label}</span>
    <input
      type="number"
      value={value}
      step={step}
      min={min}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
      style={{
        width: '68px',
        padding: '3px 6px',
        border: `1px solid ${color.borderStrong}`,
        borderRadius: radius.sm,
        fontSize: '11px',
        textAlign: 'right',
      }}
    />
    {suffix && <span style={{ color: color.textMuted, width: '28px' }}>{suffix}</span>}
  </label>
);


// 時間枠の 1 レンジぶんの入力。日付指定が ON のときだけ日付欄を並べ、
// 横幅が足りなくなるので「開始 / 終了」の 2 行に折り返す。
const WindowRange: React.FC<{
  withDate: boolean;
  from: string;
  fromDate: string;
  to: string;
  toDate: string;
  onFrom: (v: string) => void;
  onFromDate: (v: string) => void;
  onTo: (v: string) => void;
  onToDate: (v: string) => void;
}> = ({ withDate, from, fromDate, to, toDate, onFrom, onFromDate, onTo, onToDate }) => {
  const line = (
    label: string,
    time: string,
    date: string,
    onTime: (v: string) => void,
    onDate: (v: string) => void,
  ) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      {withDate && (
        <>
          <span style={{ width: '24px', flexShrink: 0, fontSize: '10px', color: color.textMuted }}>
            {label}
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => onDate(e.target.value)}
            style={{ ...dateInputStyle, width: '112px' }}
          />
        </>
      )}
      <input
        type="time"
        value={time}
        onChange={(e) => onTime(e.target.value)}
        style={dateInputStyle}
      />
    </span>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: withDate ? 'column' : 'row',
        alignItems: withDate ? 'flex-start' : 'center',
        gap: '4px',
      }}
    >
      {line('開始', from, fromDate, onFrom, onFromDate)}
      {!withDate && <span style={{ color: color.textMuted, fontSize: '10px' }}>〜</span>}
      {line('終了', to, toDate, onTo, onToDate)}
    </div>
  );
};

// S / E を割り当てるトグル
const RoleToggle: React.FC<{
  text: string;
  active: boolean;
  accent: string;
  title: string;
  onClick: () => void;
}> = ({ text, active, accent, title, onClick }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      width: '22px',
      height: '20px',
      flexShrink: 0,
      border: `1px solid ${active ? accent : color.borderStrong}`,
      backgroundColor: active ? accent : color.surface,
      color: active ? color.surface : color.textMuted,
      fontSize: '10px',
      fontWeight: 700,
      borderRadius: radius.sm,
      cursor: 'pointer',
      lineHeight: 1,
    }}
  >
    {text}
  </button>
);

// --- 行列プレビュー ---------------------------------------------------------
// 非対称なセル（往復で値が違う）に色を付けて、ペナルティがどこに効いているかを見せる。
const MatrixTable: React.FC<{
  srcPlaces: PlaceBase[];
  dstPlaces: PlaceBase[];
  matrix: BuiltMatrix;
}> = ({ srcPlaces, dstPlaces, matrix }) => (
  <div style={{ overflow: 'auto', maxHeight: '260px', border: `1px solid ${color.border}` }}>
    <table style={{ borderCollapse: 'collapse', fontSize: '10px', whiteSpace: 'nowrap' }}>
      <thead>
        <tr>
          <th
            style={{
              position: 'sticky',
              left: 0,
              top: 0,
              zIndex: 2,
              backgroundColor: color.surfaceAlt,
              padding: '3px 5px',
              color: color.textMuted,
              fontWeight: 600,
            }}
            title="行 = 出発側、列 = 到着側"
          >
            分
          </th>
          {dstPlaces.map((p) => (
            <th
              key={p.id}
              title={`到着: ${p.name}`}
              style={{
                position: 'sticky',
                top: 0,
                backgroundColor: color.surfaceAlt,
                padding: '3px 5px',
                color: color.textSub,
                fontWeight: 600,
              }}
            >
              {shortName(p.name)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {srcPlaces.map((p, i) => (
          <tr key={p.id}>
            <th
              title={`出発: ${p.name}`}
              style={{
                position: 'sticky',
                left: 0,
                backgroundColor: color.surfaceAlt,
                padding: '3px 5px',
                color: color.textSub,
                fontWeight: 600,
                textAlign: 'right',
              }}
            >
              {shortName(p.name)}
            </th>
            {dstPlaces.map((q, j) => {
              const sec = matrix.seconds[i][j];
              const same = p.id === q.id;
              const asym = matrix.asymmetric[i][j];
              return (
                <td
                  key={q.id}
                  title={`${p.name} → ${q.name}: ${Math.round(sec / 60)}分 / ${(
                    matrix.meters[i][j] / 1000
                  ).toFixed(2)}km`}
                  style={{
                    padding: '3px 5px',
                    textAlign: 'right',
                    color: same ? color.textMuted : asym ? PENALTY_COLOR : color.text,
                    backgroundColor: asym ? `${PENALTY_COLOR}18` : undefined,
                    fontWeight: asym ? 700 : 400,
                  }}
                >
                  {same ? '-' : Math.round(sec / 60)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

type Props<T extends PlaceBase> = {
  model: SolverModel<T>;
  intro: React.ReactNode; // 画面ごとの説明（上部バナー）
  placeHint: React.ReactNode; // 地点セクションの操作ヒント
  describePlace: (place: T) => string; // 地点行のツールチップ（座標など）
  matrixNote: React.ReactNode; // 距離の作り方の説明
  extraPlaceActions?: React.ReactNode; // 画面固有のボタン（「全体を表示」など）
};

export function SolverSidebar<T extends PlaceBase>({
  model,
  intro,
  placeHint,
  describePlace,
  matrixNote,
  extraPlaceActions,
}: Props<T>) {
  const [showMatrix, setShowMatrix] = useState(true);
  const {
    places,
    startPlace,
    endPlace,
    stops,
    selectedIds,
    setStartId,
    setEndId,
    defaultIds,
    renamePlace,
    removePlace,
    removeAllPlaces,
    toggleSelected,
    selectAll,
    selectNone,
    resetAll,
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
    globalStart,
    setGlobalStart,
    globalEnd,
    setGlobalEnd,
    dateEnabled,
    setDateEnabled,
    globalStartDate,
    setGlobalStartDate,
    globalEndDate,
    setGlobalEndDate,
    globalWindowInvalid,
    noSkip,
    setNoSkip,
    autoGlobalEndIso,
    globalEndExtended,
    timeWindows,
    setTimeWindow,
    clearTimeWindow,
    penalties,
    penaltyEnabled,
    setPenaltyEnabled,
    activePenalties,
    isPenaltyActive,
    addPenalty,
    updatePenalty,
    removePenalty,
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
    orderNames,
    baseline,
    saveBaseline,
    reversedFromBaseline,
    sameAsBaseline,
  } = model;

  // 時間枠を設定できるのは「出発地・帰着地・いま選ばれている訪問先」だけ。
  // S と E は同じ地点でも別々に指定できるよう、地点 id ではなく役割をキーにする。
  const timeWindowRows: {
    key: string;
    name: string;
    badge: string;
    accent: string;
    fixedMode?: string;
  }[] = [
    ...(startPlace
      ? [
          {
            key: START_WINDOW_KEY,
            name: startPlace.name,
            badge: 'S',
            accent: START_COLOR,
            fixedMode: '出発',
          },
        ]
      : []),
    ...(endPlace
      ? [
          {
            key: END_WINDOW_KEY,
            name: endPlace.name,
            badge: 'E',
            accent: END_COLOR,
            fixedMode: '到着',
          },
        ]
      : []),
    ...stops.map((p, i) => ({
      key: p.id,
      name: p.name,
      badge: String(i + 1),
      accent: STOP_COLOR,
    })),
  ];

  const metrics = route?.metrics;
  const skipped = result?.skippedShipments ?? [];
  // 最後の訪問から帰着地までの区間（transitions は訪問数 + 1 本ある）
  const lastLeg = route?.transitions?.[route?.visits?.length ?? 0];

  return (
      <div
        className="solver-sections"
        style={{
          width: '400px',
          flexShrink: 0,
          backgroundColor: color.surfaceAlt,
          padding: space.xl,
          overflowY: 'auto',
          borderLeft: `1px solid ${color.border}`,
          fontSize: '13px',
          display: 'flex',
          flexDirection: 'column',
          gap: space.lg,
        }}
      >
        {/* flex カラムの子はデフォルトで縮むため、スクロール時にカードの中身が
            クリップされてしまう。明示的に縮まないようにする。 */}
        <style>{`.solver-sections > * { flex-shrink: 0; }`}</style>

        <div
          style={{
            backgroundColor: '#e8f0fe',
            border: `1px solid ${STOP_COLOR}40`,
            borderRadius: radius.md,
            padding: `${space.sm} ${space.md}`,
            fontSize: '11px',
            color: color.textSub,
            lineHeight: 1.6,
          }}
        >
          {intro}
        </div>

        {/* 1. 地点の選択 */}
        <Section role="input" title={`地点（${places.length} 中 ${stops.length} を訪問）`}>
          <p style={{ margin: `0 0 ${space.sm}`, color: color.textSub, fontSize: '11px' }}>
            チェックで訪問する地点を選び、<strong style={{ color: START_COLOR }}>S</strong>
            ＝出発地、<strong style={{ color: END_COLOR }}>E</strong>＝帰着地を指定します。
            S / E は訪問先ではなく車両の起点・終点です（同じ地点でも構いません）。
          </p>
          <div
            style={{
              maxHeight: '260px',
              overflowY: 'auto',
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
            }}
          >
            {places.map((p, i) => {
              const isStart = p.id === startPlace?.id;
              const isEnd = p.id === endPlace?.id;
              const isEndpoint = isStart || isEnd;
              const isSelected = selectedIds.includes(p.id);
              return (
                <div
                  key={p.id}
                  title={describePlace(p)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    padding: '4px 6px',
                    borderBottom: i === places.length - 1 ? 'none' : `1px solid ${color.border}`,
                    backgroundColor: isStart
                      ? `${START_COLOR}0f`
                      : isEnd
                        ? `${END_COLOR}0f`
                        : undefined,
                    opacity: isEndpoint || isSelected ? 1 : 0.55,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isEndpoint}
                    title={isEndpoint ? '出発地・帰着地は訪問先ではありません' : '訪問先に含める'}
                    onChange={() => toggleSelected(p.id)}
                    style={{ flexShrink: 0 }}
                  />
                  <input
                    value={p.name}
                    onChange={(e) => renamePlace(p.id, e.target.value)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: 'none',
                      background: 'transparent',
                      fontSize: '11px',
                      color: color.text,
                      padding: '2px',
                    }}
                  />
                  <RoleToggle
                    text="S"
                    active={isStart}
                    accent={START_COLOR}
                    title="この地点を出発地にする"
                    onClick={() => setStartId(p.id)}
                  />
                  <RoleToggle
                    text="E"
                    active={isEnd}
                    accent={END_COLOR}
                    title="この地点を帰着地にする"
                    onClick={() => setEndId(p.id)}
                  />
                  {/* 初期 10 地点は消さない。地図クリックで足した地点だけ削除できる */}
                  {!defaultIds.has(p.id) && (
                    <button
                      onClick={() => removePlace(p.id)}
                      title="この地点を削除"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: color.textMuted,
                        cursor: 'pointer',
                        fontSize: '13px',
                        lineHeight: 1,
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' }}>
            <button onClick={selectAll} style={smallButton(color.blue)}>
              全部訪問
            </button>
            <button
              onClick={selectNone}
              title="地点は残したまま、訪問先の選択だけを外します"
              style={smallButton(color.textSub)}
            >
              全部外す
            </button>
            <button
              onClick={removeAllPlaces}
              disabled={places.length === 0}
              title="地点そのものを全部消して、まっさらな状態から置き直します（「初期状態に戻す」で復帰できます）"
              style={{
                ...smallButton(color.red),
                color: places.length === 0 ? color.textMuted : color.red,
                borderColor: places.length === 0 ? color.borderStrong : `${color.red}80`,
                cursor: places.length === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              全部除去
            </button>
            {extraPlaceActions}
            <button onClick={resetAll} style={smallButton(color.textSub)}>
              初期状態に戻す
            </button>
          </div>
          <p style={{ margin: `${space.sm} 0 0`, color: color.textMuted, fontSize: '10px' }}>
            {placeHint}
          </p>
        </Section>

        {/* 2. 時間枠 */}
      <Section role="input" title="時間枠（到着・出発の許容レンジ）">
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: space.xs,
            fontSize: '11px',
            marginBottom: space.sm,
          }}
        >
          <input
            type="checkbox"
            checked={dateEnabled}
            onChange={(e) => setDateEnabled(e.target.checked)}
          />
          <span>
            日付も指定する（外すと<strong>すべて当日</strong>の時刻として扱います）
          </span>
        </label>

        <div
          style={{
            display: 'flex',
            alignItems: dateEnabled ? 'flex-start' : 'center',
            gap: '4px',
            fontSize: '10px',
          }}
        >
          <span
            style={{
              color: color.textSub,
              width: '58px',
              flexShrink: 0,
              paddingTop: dateEnabled ? '3px' : 0,
            }}
          >
            全体時間枠
          </span>
          <WindowRange
            withDate={dateEnabled}
            from={globalStart}
            fromDate={globalStartDate}
            to={globalEnd}
            toDate={globalEndDate}
            onFrom={setGlobalStart}
            onFromDate={setGlobalStartDate}
            onTo={setGlobalEnd}
            onToDate={setGlobalEndDate}
          />
        </div>
        <p style={{ margin: `4px 0 ${space.sm}`, color: color.textMuted, fontSize: '10px' }}>
          全ルートがこの範囲で完結します{dateEnabled ? '' : '（日付は当日固定）'}
          。以下の各枠もこの範囲に収めてください。
        </p>

        {globalWindowInvalid && (
          <p
            style={{
              margin: `0 0 ${space.sm}`,
              padding: `4px ${space.sm}`,
              backgroundColor: '#fce8e6',
              borderRadius: radius.sm,
              color: '#c5221f',
              fontSize: '10px',
            }}
          >
            全体時間枠の終了が開始以前になっています。
            {dateEnabled
              ? '日付を含めて開始より後になるよう直してください。'
              : '日をまたぐ枠にしたい場合は「日付も指定する」を ON にしてください。'}
          </p>
        )}

        {/* どの地点もスキップさせない */}
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: space.xs,
            fontSize: '11px',
            marginBottom: '4px',
          }}
        >
          <input
            type="checkbox"
            checked={noSkip}
            onChange={(e) => setNoSkip(e.target.checked)}
            style={{ marginTop: '2px', flexShrink: 0 }}
          />
          <span>どの地点もスキップさせない（全体時間枠を自動で延長する）</span>
        </label>
        <p style={{ margin: `0 0 ${space.sm}`, color: color.textMuted, fontSize: '10px', lineHeight: 1.6 }}>
          API は <code>penaltyCost</code> 未設定（＝必須）の地点でも、全体時間枠に収まらない分は
          <strong>スキップして解を返します</strong>（理由コード
          <code>CANNOT_BE_PERFORMED_WITHIN_VEHICLE_TIME_WINDOWS</code>）。
          penaltyCost をいくら上げても防げないため、ここを ON にすると
          <strong>必ず全地点が収まる終了時刻</strong>まで枠を広げて送ります。
          コストは時間あたりで効くので、枠を広げても解は最短のままです。
          <br />
          ※ E（帰着）や各地点に明示した枠は残るので、それ自体が守れない地点は依然スキップされます。
        </p>
        {noSkip && globalEndExtended && (
          <p
            style={{
              margin: `0 0 ${space.sm}`,
              padding: `4px ${space.sm}`,
              backgroundColor: '#e6f4ea',
              borderRadius: radius.sm,
              color: '#137333',
              fontSize: '10px',
            }}
          >
            全体終了時刻を <strong>{fmtDateTime(autoGlobalEndIso)}</strong> まで自動延長して送ります。
          </p>
        )}

        {timeWindowRows.map((row) => {
          const w = timeWindows[row.key];
          const has = Boolean(w && (w.from || w.to));
          return (
            <div
              key={row.key}
              style={{
                borderTop: `1px solid ${color.border}`,
                paddingTop: '5px',
                marginTop: '5px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: space.xs,
                  fontSize: '11px',
                  marginBottom: '3px',
                }}
              >
                <span
                  style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    backgroundColor: row.accent,
                    color: 'white',
                    fontSize: '9px',
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {row.badge}
                </span>
                <strong style={{ flex: 1, minWidth: 0 }}>{row.name}</strong>
                {row.fixedMode ? (
                  <span style={{ fontSize: '10px', color: color.textSub }}>{row.fixedMode}</span>
                ) : (
                  <select
                    value={w?.mode ?? 'arrival'}
                    onChange={(e) =>
                      setTimeWindow(row.key, { mode: e.target.value as PlaceTimeWindow['mode'] })
                    }
                    style={{ fontSize: '10px', padding: '1px' }}
                  >
                    <option value="arrival">到着</option>
                    <option value="departure">出発</option>
                  </select>
                )}
                {has && (
                  <button
                    onClick={() => clearTimeWindow(row.key)}
                    title="この時間枠を外す"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: color.textMuted,
                      cursor: 'pointer',
                      fontSize: '13px',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <WindowRange
                withDate={dateEnabled}
                from={w?.from ?? ''}
                fromDate={w?.fromDate ?? TODAY}
                to={w?.to ?? ''}
                toDate={w?.toDate ?? TODAY}
                onFrom={(v) => setTimeWindow(row.key, { from: v })}
                onFromDate={(v) => setTimeWindow(row.key, { fromDate: v })}
                onTo={(v) => setTimeWindow(row.key, { to: v })}
                onToDate={(v) => setTimeWindow(row.key, { toDate: v })}
              />
            </div>
          );
        })}

        <p
          style={{
            margin: `${space.sm} 0 0`,
            color: color.textMuted,
            fontSize: '10px',
            lineHeight: 1.6,
          }}
        >
          片側だけの指定も可（「この時刻以降」だけ、など）。API が縛れるのは訪問の
          <strong>到着（訪問開始）時刻</strong>だけなので、「出発」を選んだ場合は
          作業時間ぶん前倒しした到着枠に変換して送っています。守れない枠を指定すると
          <strong>実行不可能</strong>として API がエラーを返します。
        </p>
      </Section>

      {/* 3. 行列の作り方 */}
        <Section role="input" title="移動コスト行列の生成パラメータ">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <NumberField
              label="迂回係数（素の距離 → 移動距離）"
              value={params.detourFactor}
              step={0.05}
              onChange={(v) => setParams((p) => ({ ...p, detourFactor: v }))}
            />
            <NumberField
              label="平均速度"
              value={params.speedKmh}
              step={1}
              suffix="km/h"
              onChange={(v) => setParams((p) => ({ ...p, speedKmh: v }))}
            />
            <NumberField
              label="各訪問の作業時間"
              value={visitMinutes}
              step={1}
              suffix="分"
              onChange={setVisitMinutes}
            />
            <NumberField
              label="時間あたりコスト"
              value={costPerHour}
              step={100}
              onChange={setCostPerHour}
            />
            <NumberField
              label="1km あたりコスト"
              value={costPerKilometer}
              step={5}
              onChange={setCostPerKilometer}
            />
          </div>
          <p style={{ margin: `${space.sm} 0 0`, color: color.textMuted, fontSize: '10px' }}>
            {matrixNote}
          </p>
        </Section>

        {/* 4. 方向別ペナルティ */}
        <Section role="input" title="方向別ペナルティ（非対称化）">
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: space.xs,
              fontSize: '11px',
              marginBottom: space.sm,
            }}
          >
            <input
              type="checkbox"
              checked={penaltyEnabled}
              onChange={(e) => setPenaltyEnabled(e.target.checked)}
            />
            <span>
              ペナルティを適用する（外すと対称行列。CLI の <code>--no-penalty</code> 相当）
            </span>
          </label>

          {penalties.length === 0 && (
            <p style={{ margin: 0, color: color.textMuted, fontSize: '11px' }}>
              ペナルティなし。結果の区間リストから「この向きを重くする」で追加できます。
            </p>
          )}

          {penalties.map((pen) => {
            // 選択から外れた地点を指すペナルティは無視される（設定自体は残す）
            const inactive = !isPenaltyActive(pen);
            return (
              <div
                key={pen.id}
                title={
                  inactive
                    ? '行列に載らない向きなので無視されます（出発側にない地点が起点、到着側にない地点が終点、など）'
                    : undefined
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  marginBottom: '4px',
                  opacity: penaltyEnabled && !inactive ? 1 : 0.45,
                }}
              >
                <select
                  value={pen.from}
                  onChange={(e) => updatePenalty(pen.id, { from: e.target.value })}
                  style={{ flex: 1, minWidth: 0, fontSize: '10px', padding: '2px' }}
                >
                  {places.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span style={{ color: color.textMuted }}>→</span>
                <select
                  value={pen.to}
                  onChange={(e) => updatePenalty(pen.id, { to: e.target.value })}
                  style={{ flex: 1, minWidth: 0, fontSize: '10px', padding: '2px' }}
                >
                  {places.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  value={pen.factor}
                  step={0.5}
                  min={0.1}
                  onChange={(e) => updatePenalty(pen.id, { factor: Number(e.target.value) })}
                  style={{ width: '46px', fontSize: '10px', padding: '2px', textAlign: 'right' }}
                />
                <span style={{ fontSize: '10px', color: color.textMuted }}>倍</span>
                <button
                  onClick={() => removePenalty(pen.id)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: color.textMuted,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}

          {places.length >= 2 && (
            <button
              onClick={() => addPenalty(places[0].id, places[1].id)}
              style={{ ...smallButton(color.blue), marginTop: space.xs }}
            >
              ＋ ペナルティを追加
            </button>
          )}

          <p
            style={{
              margin: `${space.sm} 0 0`,
              color: color.textMuted,
              fontSize: '10px',
              lineHeight: 1.6,
            }}
          >
            重くする向きは<strong>最適解が実際に通っている向き</strong>を選ばないと結果が変わりません
            （通らない向きを重くしても解は同じままです）。
          </p>
        </Section>

        {/* 5. 生成された行列 */}
        <Section role="input" title="生成された行列">
          <div style={{ display: 'flex', gap: space.sm, marginBottom: space.sm }}>
            <StatCard
              label="行列サイズ"
              value={`${srcPlaces.length}×${dstPlaces.length}`}
              accent={color.blue}
            />
            <StatCard
              label="非対称ペア"
              value={`${matrix.asymmetricPairs}`}
              accent={matrix.asymmetricPairs > 0 ? PENALTY_COLOR : color.textMuted}
            />
            <StatCard
              label="リクエスト"
              value={fmtBytes(payloadBytes)}
              accent={payloadBytes > SYNC_PAYLOAD_LIMIT_BYTES ? color.red : color.green}
            />
          </div>
          <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
            <button
              onClick={() => setShowMatrix((v) => !v)}
              style={smallButton(color.blue, showMatrix)}
            >
              {showMatrix ? '行列を隠す' : '行列を表示'}
            </button>
            <span style={{ fontSize: '10px', color: color.textMuted }}>
              行＝出発側 / 列＝到着側、単位は分。
              <span style={{ color: PENALTY_COLOR, fontWeight: 700 }}>赤</span>＝往復で値が違うセル
            </span>
          </div>
          {showMatrix && srcPlaces.length > 0 && (
            <div style={{ marginTop: space.sm }}>
              <MatrixTable srcPlaces={srcPlaces} dstPlaces={dstPlaces} matrix={matrix} />
            </div>
          )}
          {payloadBytes > SYNC_PAYLOAD_LIMIT_BYTES && (
            <p style={{ margin: `${space.sm} 0 0`, color: color.red, fontSize: '11px' }}>
              同期リクエストの上限 4MiB を超えています。地点数を減らすか batchOptimizeTours が必要です。
            </p>
          )}
          {request && (
            <details style={{ marginTop: space.sm }}>
              <summary style={{ cursor: 'pointer', fontSize: '11px', color: color.textSub }}>
                送信するリクエスト JSON を見る（座標が含まれていないことを確認できます）
              </summary>
              <pre
                style={{
                  maxHeight: '220px',
                  overflow: 'auto',
                  backgroundColor: '#202124',
                  color: '#e8eaed',
                  padding: space.sm,
                  borderRadius: radius.sm,
                  fontSize: '10px',
                  marginTop: space.xs,
                }}
              >
                {requestJson}
              </pre>
            </details>
          )}
        </Section>

        {/* 6. 実行 */}
        <div>
          <button
            onClick={run}
            disabled={!canRun || loading}
            style={{
              width: '100%',
              padding: '12px',
              border: 'none',
              borderRadius: radius.md,
              backgroundColor: canRun && !loading ? color.orange : color.borderStrong,
              color: 'white',
              fontSize: '14px',
              fontWeight: 700,
              cursor: canRun && !loading ? 'pointer' : 'not-allowed',
              boxShadow: shadow.sm,
            }}
          >
            {loading ? '最適化中…' : 'ソルバーを実行'}
          </button>
          {places.length === 0 ? (
            <p style={{ margin: `${space.xs} 0 0`, fontSize: '11px', color: color.textMuted }}>
              地点がありません。キャンバスをクリックして置くか、「初期状態に戻す」で戻せます。
            </p>
          ) : (
            stops.length === 0 && (
              <p style={{ margin: `${space.xs} 0 0`, fontSize: '11px', color: color.textMuted }}>
                訪問先が 1 つも選択されていません（出発地・帰着地は訪問先に含まれません）。
              </p>
            )
          )}
          {globalWindowInvalid && (
            <p style={{ margin: `${space.xs} 0 0`, fontSize: '11px', color: color.red }}>
              全体時間枠が不正なので実行できません（終了が開始以前）。
            </p>
          )}
          {stale && (
            <p style={{ margin: `${space.xs} 0 0`, fontSize: '11px', color: color.orange }}>
              入力が変わりました。結果は前回の実行時のものです。
            </p>
          )}
        </div>

        {error && (
          <div
            style={{
              backgroundColor: '#fce8e6',
              color: '#c5221f',
              padding: space.md,
              borderRadius: radius.sm,
              fontSize: '11px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {error}
          </div>
        )}

        {/* 7. 結果 */}
        {route && (
          <Section role="output" title="最適化結果">
            <div style={{ display: 'flex', gap: space.sm, marginBottom: space.md }}>
              <StatCard
                label="移動時間"
                value={fmtDur(metrics?.travelDuration)}
                accent={color.blue}
              />
              <StatCard
                label="走行距離"
                value={fmtKm(metrics?.travelDistanceMeters)}
                accent={color.green}
              />
              <StatCard
                label="総コスト"
                value={result?.metrics?.totalCost?.toFixed(0) ?? '-'}
                accent={color.orange}
              />
            </div>

            <div style={{ fontSize: '11px', color: color.textSub, marginBottom: space.sm }}>
              拘束 {fmtDur(metrics?.totalDuration)} / 作業 {fmtDur(metrics?.visitDuration)} / 待機{' '}
              {fmtDur(metrics?.waitDuration)}
              {elapsedMs !== null && ` / API 応答 ${elapsedMs} ms`}
            </div>

            {/* 訪問順と区間。各区間から「その向きを重くする」でペナルティを足せる */}
            <div style={{ border: `1px solid ${color.border}`, borderRadius: radius.sm }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '4px 8px',
                  backgroundColor: `${START_COLOR}12`,
                  fontSize: '11px',
                  fontWeight: 600,
                }}
              >
                <span>{fmtTime(route.vehicleStartTime)} 出発</span>
                <span>{startPlace?.name}</span>
              </div>
              {orderPlaces.map((place, i) => {
                const leg = route.transitions?.[i];
                const fromPlace = i === 0 ? startPlace : orderPlaces[i - 1];
                return (
                  <div
                    key={`${place?.id ?? i}-${i}`}
                    style={{
                      padding: '5px 8px',
                      borderTop: `1px solid ${color.border}`,
                      fontSize: '11px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: space.xs }}>
                      <span
                        style={{
                          width: '16px',
                          height: '16px',
                          borderRadius: '50%',
                          backgroundColor: STOP_COLOR,
                          color: 'white',
                          fontSize: '9px',
                          fontWeight: 700,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {i + 1}
                      </span>
                      <strong style={{ flex: 1, minWidth: 0 }}>{place?.name}</strong>
                      <span style={{ color: color.textSub }}>
                        {fmtTime(route.visits?.[i]?.startTime, route.vehicleStartTime)}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: space.xs,
                        marginTop: '2px',
                        paddingLeft: '22px',
                        color: color.textMuted,
                        fontSize: '10px',
                      }}
                    >
                      <span>
                        {fromPlace?.name} → {place?.name}: {fmtDur(leg?.travelDuration)} /{' '}
                        {fmtKm(leg?.travelDistanceMeters)}
                      </span>
                      {fromPlace && place && fromPlace.id !== place.id && (
                        <button
                          onClick={() => addPenalty(fromPlace.id, place.id)}
                          title={`${fromPlace.name} → ${place.name} を 3 倍に重くする`}
                          style={{
                            marginLeft: 'auto',
                            border: `1px solid ${PENALTY_COLOR}55`,
                            background: 'transparent',
                            color: PENALTY_COLOR,
                            fontSize: '9px',
                            padding: '1px 6px',
                            borderRadius: radius.pill,
                            cursor: 'pointer',
                            flexShrink: 0,
                          }}
                        >
                          この向きを重くする
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div
                style={{
                  borderTop: `1px solid ${color.border}`,
                  backgroundColor: `${END_COLOR}12`,
                  padding: '4px 8px',
                  fontSize: '11px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                  <span>{fmtTime(route.vehicleEndTime, route.vehicleStartTime)} 帰着</span>
                  <span>{endPlace?.name}</span>
                </div>
                {lastLeg && orderPlaces.length > 0 && (
                  <div style={{ color: color.textMuted, fontSize: '10px', marginTop: '2px' }}>
                    {orderPlaces[orderPlaces.length - 1]?.name} → {endPlace?.name}:{' '}
                    {fmtDur(lastLeg.travelDuration)} / {fmtKm(lastLeg.travelDistanceMeters)}
                  </div>
                )}
              </div>
            </div>

            {skipped.length > 0 && (
              <div
                style={{
                  margin: `${space.sm} 0 0`,
                  padding: `6px ${space.sm}`,
                  backgroundColor: '#fef7e0',
                  borderRadius: radius.sm,
                  fontSize: '11px',
                  color: '#996300',
                }}
              >
                <strong>
                  訪問できなかった地点（{skipped.length}）:{' '}
                  {skipped.map((s) => stops[s.index ?? 0]?.name ?? '?').join(', ')}
                </strong>
                <div style={{ marginTop: '2px', fontSize: '10px' }}>
                  全体時間枠や各地点の時間枠に収まらないと、ここに落ちます。
                  時間枠セクションの「<strong>どの地点もスキップさせない</strong>」を ON にすると
                  全体時間枠を自動で延ばして解消できます（終了時刻を延ばす・平均速度を上げる・
                  訪問先を減らす、でも同じことができます）。
                </div>
              </div>
            )}

            {result?.metrics?.costs && (
              <div style={{ marginTop: space.sm, fontSize: '10px', color: color.textMuted }}>
                {Object.entries(result.metrics.costs).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{k}</span>
                    <span>{v.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {/* 8. A/B 比較 */}
        {route && (
          <Section role="history" title="比較（設定を変えて見比べる）">
            <p style={{ margin: `0 0 ${space.sm}`, fontSize: '11px', color: color.textSub }}>
              いまの結果を保存 → 地点やペナルティを変えて再実行 → 訪問順がどう変わったかを比較します。
            </p>
            <button onClick={saveBaseline} style={smallButton(color.purple, true)}>
              いまの結果を比較用に保存
            </button>

            {baseline && (
              <div style={{ marginTop: space.sm, fontSize: '11px' }}>
                <div style={{ color: color.textSub, marginBottom: '2px' }}>
                  保存済み（{baseline.label}
                  {baseline.cost !== undefined && ` / コスト ${baseline.cost.toFixed(0)}`}）
                </div>
                <div style={{ color: color.textMuted, fontSize: '10px', lineHeight: 1.6 }}>
                  {baseline.order.join(' → ')}
                </div>
                <div style={{ color: color.textSub, margin: '6px 0 2px' }}>
                  現在（訪問 {stops.length} 地点 /{' '}
                  {penaltyEnabled ? `ペナルティ ${activePenalties.length} 件` : 'ペナルティ無効'}
                  {result?.metrics?.totalCost !== undefined &&
                    ` / コスト ${result.metrics.totalCost.toFixed(0)}`}
                  ）
                </div>
                <div style={{ color: color.textMuted, fontSize: '10px', lineHeight: 1.6 }}>
                  {orderNames.join(' → ')}
                </div>

                <div
                  style={{
                    marginTop: space.sm,
                    padding: `6px ${space.sm}`,
                    borderRadius: radius.sm,
                    fontSize: '11px',
                    fontWeight: 600,
                    backgroundColor: reversedFromBaseline
                      ? `${color.green}18`
                      : sameAsBaseline
                        ? `${color.orange}18`
                        : `${color.blue}18`,
                    color: reversedFromBaseline
                      ? '#137333'
                      : sameAsBaseline
                        ? '#996300'
                        : color.blue,
                  }}
                >
                  {reversedFromBaseline
                    ? '完全な逆回りに反転しました。非対称行列が効いています。'
                    : sameAsBaseline
                      ? '訪問順は変わっていません。重くした向きを最適解が通っていない可能性があります。'
                      : '訪問順が変化しました。'}
                </div>
              </div>
            )}
          </Section>
        )}
      </div>
  );
}
