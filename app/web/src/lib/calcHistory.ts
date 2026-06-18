// 計算（入力＋結果）の履歴を localStorage に永続化するモジュール。
// 履歴とお気に入りは 1 つのリストで管理し、favorite フラグで区別する。
// お気に入りは件数上限の対象外（履歴が溢れても消えない）。

import type { LatLng, Point, VehicleCost, GlobalWindow, OptimizeResponse } from '../pages/EditorPage';

// 1 回の計算のスナップショット（入力一式 + 結果）
export type CalcSnapshot = {
  id: string;
  createdAt: number; // epoch ms
  favorite: boolean;
  label?: string; // サンプル等の表示名（履歴は通常未設定で日時表示）
  input: {
    pickups: Point[];
    deliveries: Point[];
    start: LatLng;
    end: LatLng;
    vehicleCost: VehicleCost;
    // 最適化の全体時間枠。null = 明示的に未設定。undefined = 旧スナップショット（復元時はデフォルト）。
    globalWindow?: GlobalWindow | null;
  };
  // 計算済み履歴は結果を持つ。サンプル（入力のみ）は未計算なので undefined。
  result?: OptimizeResponse;
};

const STORAGE_KEY = 'editor.calcHistory.v1';

// お気に入り以外の履歴の保持上限（古いものから破棄）
export const HISTORY_CAP = 20;

export const makeId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

export const loadSnapshots = (): CalcSnapshot[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CalcSnapshot[]) : [];
  } catch {
    return [];
  }
};

// 保存。localStorage の容量超過時は、古い非お気に入りを 1 件ずつ間引いて再試行する。
export const persistSnapshots = (list: CalcSnapshot[]): void => {
  let working = [...list];
  for (let attempt = 0; attempt < working.length + 1; attempt++) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(working));
      return;
    } catch {
      // 末尾（＝最も古い）の非お気に入りを 1 件落として再試行
      const idx = [...working].reverse().findIndex((s) => !s.favorite);
      if (idx === -1) return; // お気に入りだけで溢れる場合は諦める
      const removeAt = working.length - 1 - idx;
      working = working.filter((_, i) => i !== removeAt);
    }
  }
};

// 新しいスナップショットを先頭に追加し、非お気に入りを上限まで間引いたリストを返す。
export const addSnapshot = (list: CalcSnapshot[], snap: CalcSnapshot): CalcSnapshot[] => {
  const next = [snap, ...list];
  let nonFav = 0;
  return next.filter((s) => {
    if (s.favorite) return true;
    nonFav += 1;
    return nonFav <= HISTORY_CAP;
  });
};
