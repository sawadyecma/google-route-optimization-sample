// ソルバー Playground（実地図版）。
//
// 移動時間・距離を Google に計算させず、ブラウザ側で作った行列を注入する（durationDistanceMatrices）。
// API に渡すのは「地点間の移動コスト表」と「制約」だけで、返るのは「訪問順と時刻」だけ。
// CLI 版は app/cmd/src/solverOnly.ts、調査の経緯は docs/solver-only-mode.md を参照。

import { useEffect, useMemo, useRef } from 'react';
import { GoogleMap, Marker } from '@react-google-maps/api';
import { SolverSidebar } from '../components/SolverSidebar';
import { SOLVER_COLORS, smallButton } from '../lib/solverUi';
import {
  type SolverPlace,
  DEFAULT_MATRIX_PARAMS,
  DEFAULT_PENALTIES,
  DEFAULT_PLACES,
  haversineMeters,
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

export const SolverPlaygroundPage: React.FC = () => {
  const model = useSolverModel<SolverPlace>({
    initialPlaces: DEFAULT_PLACES,
    initialPenalties: DEFAULT_PENALTIES,
    initialParams: DEFAULT_MATRIX_PARAMS,
    rawMeters: haversineMeters,
    idPrefix: 'loc-custom',
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

  const mapRef = useRef<google.maps.Map | null>(null);
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  const fittedRef = useRef(false);

  const center = useMemo(() => {
    if (places.length === 0) return { lat: 35.6895, lng: 139.6917 };
    const sum = places.reduce((a, p) => ({ lat: a.lat + p.lat, lng: a.lng + p.lng }), {
      lat: 0,
      lng: 0,
    });
    return { lat: sum.lat / places.length, lng: sum.lng / places.length };
  }, [places]);

  const fitToPlaces = (map: google.maps.Map | null = mapRef.current) => {
    if (!map || places.length === 0 || !window.google) return;
    const bounds = new google.maps.LatLngBounds();
    places.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds, 64);
  };

  // 出発地 → 訪問順 → 帰着地 を結ぶ直線ポリライン。
  // 行列モードでは道路形状（routePolyline）が返らないので、線は「順序と向き」しか表せない。
  useEffect(() => {
    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }
    if (!mapRef.current || orderPlaces.length === 0 || stale || !startPlace || !endPlace) return;
    const path = [startPlace, ...orderPlaces, endPlace]
      .filter((p): p is SolverPlace => Boolean(p))
      .map((p) => ({ lat: p.lat, lng: p.lng }));
    polylineRef.current = new google.maps.Polyline({
      path,
      map: mapRef.current,
      strokeColor: STOP_COLOR,
      strokeOpacity: 0.75,
      strokeWeight: 2,
      icons: [
        {
          // 進行方向の矢印。非対称行列の効果は「向き」に出るので方向表示は必須。
          icon: {
            path: window.google?.maps?.SymbolPath?.FORWARD_CLOSED_ARROW,
            scale: 2.6,
            strokeColor: STOP_COLOR,
            fillColor: STOP_COLOR,
            fillOpacity: 1,
          },
          offset: '55%',
          repeat: '120px',
        },
      ],
    });
    return () => {
      polylineRef.current?.setMap(null);
      polylineRef.current = null;
    };
  }, [orderPlaces, startPlace, endPlace, stale]);

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={center}
          zoom={7}
          onLoad={(map) => {
            mapRef.current = map;
            if (!fittedRef.current) {
              fittedRef.current = true;
              fitToPlaces(map);
            }
          }}
          onClick={(e) => {
            if (!e.latLng) return;
            const lat = e.latLng.lat();
            const lng = e.latLng.lng();
            model.addPlace((id, index) => ({ id, name: `地点 ${index + 1}`, lat, lng }));
          }}
          options={{ draggableCursor: 'crosshair' }}
        >
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
            return (
              <Marker
                key={p.id}
                position={{ lat: p.lat, lng: p.lng }}
                title={
                  isStart || isEnd
                    ? `${p.name}（${isStart && isEnd ? '出発・帰着' : isStart ? '出発' : '帰着'}）`
                    : `${p.name}（クリックで${
                        isSelected ? '訪問から外す' : '訪問に加える'
                      }／ドラッグで移動）`
                }
                draggable
                onDragEnd={(e) => {
                  if (e.latLng) model.movePlace(p.id, { lat: e.latLng.lat(), lng: e.latLng.lng() });
                }}
                onClick={() => {
                  if (!isStart && !isEnd) model.toggleSelected(p.id);
                }}
                label={
                  label !== ''
                    ? {
                        text: String(label),
                        color: 'white',
                        fontWeight: 'bold',
                        fontSize: isStart && isEnd ? '9px' : '11px',
                      }
                    : undefined
                }
                opacity={isSelected || isStart || isEnd ? 1 : 0.55}
                icon={{
                  path: window.google?.maps?.SymbolPath?.CIRCLE,
                  scale: isStart || isEnd ? 14 : isSelected ? 12 : 8,
                  fillColor: fill,
                  fillOpacity: 1,
                  strokeColor: 'white',
                  strokeWeight: 2,
                }}
              />
            );
          })}
        </GoogleMap>

        {/* 地図の注記：行列モードでは道路形状が返らないことを明示する */}
        <div
          style={{
            position: 'absolute',
            left: space.md,
            bottom: space.md,
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderRadius: radius.md,
            boxShadow: shadow.sm,
            padding: `${space.sm} ${space.md}`,
            fontSize: '11px',
            color: color.textSub,
            maxWidth: '340px',
            zIndex: 2,
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
          線が直線なのは仕様です。行列モードでは座標を送らないため、API は道路形状
          （routePolyline）を返しません。線が表しているのは<strong>順序と向き</strong>だけです。
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
              zIndex: 3,
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
            実際の地図の座標から<strong>ブラウザ側で移動コスト行列を計算</strong>して注入し、Google
            には<strong>最適化だけ</strong>をやらせるモードです。座標は API に送りません。
            行列生成を経路エンジン（OSRM / Valhalla）に差し替える前提の検証用。
          </>
        }
        placeHint="地図のマーカーをクリックしても訪問の ON / OFF を切り替えられます（ドラッグで移動、地図の余白クリックで地点を追加）。"
        describePlace={(p) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`}
        matrixNote="haversine 距離 × 迂回係数 ÷ 平均速度 で所要を見積もっています。実運用ではこの部分を経路エンジンの応答に置き換えます。"
        extraPlaceActions={
          <button onClick={() => fitToPlaces()} style={smallButton(color.blue)}>
            全体を表示
          </button>
        }
      />
    </div>
  );
};
