// ソルバー Playground 2 種類で共通の見た目トークン。
// コンポーネントファイルから定数を export すると Fast Refresh が効かなくなるため分離している。

import { color, radius } from '../theme';

export const SOLVER_COLORS = {
  start: color.green, // 出発地
  end: color.red, // 帰着地
  stop: color.blue, // 訪問先
  off: color.textMuted, // 選択されていない地点
  skipped: color.orange, // 選ばれたが訪問されなかった地点
  penalty: color.red, // 非対称セル
} as const;

export const smallButton = (accent: string, filled = false): React.CSSProperties => ({
  border: `1px solid ${filled ? accent : color.borderStrong}`,
  backgroundColor: filled ? accent : color.surface,
  color: filled ? color.surface : color.textSub,
  fontSize: '11px',
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: radius.pill,
  cursor: 'pointer',
});
