// 車両コスト（最適化パラメータ）のプリセットをお気に入りとして localStorage に保存するモジュール。
// 計算履歴（calcHistory）とは別ストアで、件数上限は設けない（手動登録のみのため）。

import type { VehicleCost } from '../pages/EditorPage';

export type VehicleCostFavorite = {
  id: string;
  cost: VehicleCost;
};

const STORAGE_KEY = 'editor.vehicleCostFavorites.v1';

export const loadVehicleCostFavorites = (): VehicleCostFavorite[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VehicleCostFavorite[]) : [];
  } catch {
    return [];
  }
};

export const persistVehicleCostFavorites = (list: VehicleCostFavorite[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 容量超過などの保存失敗は無視（お気に入りは任意機能）
  }
};

// 2 つの車両コストが全フィールド一致するか（重複登録の判定に使う）
export const sameVehicleCost = (a: VehicleCost, b: VehicleCost): boolean =>
  a.costPerHour === b.costPerHour &&
  a.costPerTraveledHour === b.costPerTraveledHour &&
  a.costPerKilometer === b.costPerKilometer &&
  a.fixedCost === b.fixedCost;
