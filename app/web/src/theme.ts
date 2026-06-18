// アプリ共通のデザイントークン。色・余白・角丸・影をここに集約し、
// インラインスタイルのマジック値を置き換える。

export const color = {
  // ブランド／役割色
  blue: '#4285F4', // 入力・ルート
  green: '#34A853', // 出力・出発
  red: '#EA4335', // 帰着・エラー
  yellow: '#FBBC04', // pickup
  purple: '#9334E6', // 履歴
  orange: '#F9AB00', // アクション（計算）

  // テキスト
  text: '#202124',
  textSub: '#5f6368',
  textMuted: '#9aa0a6',

  // サーフェス・境界
  surface: '#ffffff',
  surfaceAlt: '#f5f5f5',
  border: '#e8eaed',
  borderStrong: '#dadce0',
} as const;

export const BRAND_GRADIENT = `linear-gradient(135deg, ${color.blue} 0%, ${color.green} 100%)`;

// 余白スケール（4 の倍数）
export const space = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
} as const;

export const radius = {
  sm: '4px',
  md: '6px',
  lg: '8px',
  pill: '999px',
} as const;

export const shadow = {
  sm: '0 1px 3px rgba(0,0,0,0.12)',
  card: '0 1px 3px rgba(0,0,0,0.06)',
} as const;
