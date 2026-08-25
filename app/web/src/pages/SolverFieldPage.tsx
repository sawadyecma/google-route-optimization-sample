// ソルバー Playground（仮想フィールド版）。
//
// 実地図を使わず、まっさらなフレーム上に地点を置いて遊ぶモード。
// 距離は座標のユークリッド距離（＝直線距離）でそのまま測る。
// 「地図がなくても、行列さえ作れば Route Optimization は解ける」ことを確かめるための画面。

import { useRef, useState } from 'react';
import { SolverSidebar } from '../components/SolverSidebar';
import { SOLVER_COLORS } from '../lib/solverUi';
import {
  type FieldPlace,
  DEFAULT_FIELD_PENALTIES,
  DEFAULT_FIELD_PLACES,
  FIELD_HEIGHT,
  FIELD_MATRIX_PARAMS,
  FIELD_WIDTH,
  fieldMeters,
} from '../lib/solverMatrix';
import { useSolverModel } from '../lib/useSolverModel';
import { color, radius, shadow, space } from '../theme';

const {
  start: START_COLOR,
  end: END_COLOR,
  stop: STOP_COLOR,
  off: OFF_COLOR,
  skipped: SKIPPED_COLOR,
} = SOLVER_COLORS;

const GRID = 25; // 補助線の間隔（km）

// 新しく置いた地点の名前は A, B, ... Z, P26, P27 ... と付ける
const placeName = (index: number) =>
  index < 26 ? String.fromCharCode(65 + index) : `P${index}`;

export const SolverFieldPage: React.FC = () => {
  const model = useSolverModel<FieldPlace>({
    initialPlaces: DEFAULT_FIELD_PLACES,
    initialPenalties: DEFAULT_FIELD_PENALTIES,
    initialParams: FIELD_MATRIX_PARAMS,
    rawMeters: fieldMeters,
    idPrefix: 'fld-custom',
  });

  const {
    places,
    startPlace,
    endPlace,
    selectedIds,
    orderById,
    orderPlaces,
    skippedIds,
    stale,
    loading,
  } = model;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // ドラッグ直後のクリックで選択が切り替わってしまうのを防ぐ
  const draggedRef = useRef(false);

  // 画面座標 → フレーム座標（viewBox の単位 = km）
  const toField = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return {
      x: Math.min(FIELD_WIDTH, Math.max(0, Math.round(p.x * 10) / 10)),
      y: Math.min(FIELD_HEIGHT, Math.max(0, Math.round(p.y * 10) / 10)),
    };
  };

  const routePath = !stale && startPlace && endPlace ? [startPlace, ...orderPlaces, endPlace] : [];

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* --- 仮想フィールド --- */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          position: 'relative',
          backgroundColor: '#fafafa',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.xl,
        }}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${FIELD_WIDTH} ${FIELD_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: color.surface,
            border: `1px solid ${color.borderStrong}`,
            borderRadius: radius.md,
            boxShadow: shadow.card,
            cursor: dragId ? 'grabbing' : 'crosshair',
            touchAction: 'none',
          }}
          onPointerMove={(e) => {
            if (!dragId) return;
            const pos = toField(e);
            if (!pos) return;
            draggedRef.current = true;
            model.movePlace(dragId, pos);
          }}
          onPointerUp={() => setDragId(null)}
          onPointerLeave={() => setDragId(null)}
          onClick={(e) => {
            // 地点の上のクリックは地点側で処理する（stopPropagation 済み）
            if (draggedRef.current) {
              draggedRef.current = false;
              return;
            }
            const pos = toField(e);
            if (!pos) return;
            model.addPlace((id, index) => ({ id, name: placeName(index), ...pos }));
          }}
        >
          <defs>
            <marker
              id="field-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={STOP_COLOR} />
            </marker>
          </defs>

          {/* 方眼（1 マス = GRID km） */}
          {Array.from({ length: Math.floor(FIELD_WIDTH / GRID) + 1 }).map((_, i) => (
            <line
              key={`v${i}`}
              x1={i * GRID}
              y1={0}
              x2={i * GRID}
              y2={FIELD_HEIGHT}
              stroke={color.border}
              strokeWidth={0.4}
            />
          ))}
          {Array.from({ length: Math.floor(FIELD_HEIGHT / GRID) + 1 }).map((_, i) => (
            <line
              key={`h${i}`}
              x1={0}
              y1={i * GRID}
              x2={FIELD_WIDTH}
              y2={i * GRID}
              stroke={color.border}
              strokeWidth={0.4}
            />
          ))}

          {/* ルート（区間ごとに矢印付きの直線） */}
          {routePath.slice(0, -1).map((from, i) => {
            const to = routePath[i + 1];
            if (!from || !to) return null;
            return (
              <line
                key={`leg-${i}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={STOP_COLOR}
                strokeWidth={1}
                strokeOpacity={0.75}
                markerEnd="url(#field-arrow)"
              />
            );
          })}

          {/* 地点 */}
          {places.map((p) => {
            const isStart = p.id === startPlace?.id;
            const isEnd = p.id === endPlace?.id;
            const isSelected = selectedIds.includes(p.id);
            const order = orderById.get(p.id);
            const isSkipped = !stale && skippedIds.has(p.id);
            const fill = isStart
              ? START_COLOR
              : isEnd
                ? END_COLOR
                : isSkipped
                  ? SKIPPED_COLOR
                  : isSelected
                    ? STOP_COLOR
                    : OFF_COLOR;
            const label = isStart && isEnd ? 'SE' : isStart ? 'S' : isEnd ? 'E' : (order ?? '');
            const r = isStart || isEnd ? 6 : isSelected ? 5 : 3.5;
            return (
              <g
                key={p.id}
                style={{ cursor: 'pointer' }}
                opacity={isSelected || isStart || isEnd ? 1 : 0.5}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.target as Element).releasePointerCapture?.(e.pointerId);
                  draggedRef.current = false;
                  setDragId(p.id);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (draggedRef.current) {
                    draggedRef.current = false;
                    return;
                  }
                  if (!isStart && !isEnd) model.toggleSelected(p.id);
                }}
              >
                <title>
                  {`${p.name}（x=${p.x} / y=${p.y} km）${
                    isStart || isEnd ? '' : isSelected ? ' クリックで訪問から外す' : ' クリックで訪問に加える'
                  }`}
                </title>
                <circle cx={p.x} cy={p.y} r={r} fill={fill} stroke="white" strokeWidth={1.2} />
                {label !== '' && (
                  <text
                    x={p.x}
                    y={p.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="white"
                    fontSize={isStart && isEnd ? 4.5 : 5.5}
                    fontWeight={700}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {label}
                  </text>
                )}
                <text
                  x={p.x}
                  y={p.y - r - 2}
                  textAnchor="middle"
                  fill={color.textSub}
                  fontSize={5}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {p.name}
                </text>
              </g>
            );
          })}
        </svg>

        {/* 凡例・スケール */}
        <div
          style={{
            position: 'absolute',
            left: space.xl,
            bottom: space.xl,
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderRadius: radius.md,
            boxShadow: shadow.sm,
            padding: `${space.sm} ${space.md}`,
            fontSize: '11px',
            color: color.textSub,
            maxWidth: '340px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: space.xs,
              marginBottom: '4px',
              flexWrap: 'wrap',
            }}
          >
            {(
              [
                [START_COLOR, '出発 (S)'],
                [END_COLOR, '帰着 (E)'],
                [STOP_COLOR, '訪問（数字＝訪問順）'],
                [SKIPPED_COLOR, '時間枠に入らず未訪問'],
                [OFF_COLOR, '選択外'],
              ] as [string, string][]
            ).map(([c, legendLabel]) => (
              <span
                key={legendLabel}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
              >
                <span
                  style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: c }}
                />
                {legendLabel}
              </span>
            ))}
          </div>
          フレームは {FIELD_WIDTH} × {FIELD_HEIGHT} km（方眼 1 マス = {GRID}
          km）。距離は座標の<strong>直線距離</strong>そのままです。
        </div>

        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(255,255,255,0.5)',
              fontSize: '13px',
              fontWeight: 600,
              color: color.textSub,
            }}
          >
            最適化中…
          </div>
        )}
      </div>

      <SolverSidebar
        model={model}
        intro={
          <>
            地図を使わず、<strong>まっさらなフレーム上に置いた地点</strong>
            の直線距離から行列を作って注入するモードです。地理データに邪魔されずに、
            <strong>行列の値と最適解の関係</strong>だけを観察できます。
          </>
        }
        placeHint="フレームの余白をクリックで地点を追加、地点をドラッグで移動、クリックで訪問の ON / OFF を切り替えられます。"
        describePlace={(p) => `x=${p.x} / y=${p.y} km`}
        matrixNote="座標のユークリッド距離（直線距離）× 迂回係数 ÷ 平均速度 で所要を見積もっています。迂回係数 1.0 なら純粋な直線距離です。"
      />
    </div>
  );
};
