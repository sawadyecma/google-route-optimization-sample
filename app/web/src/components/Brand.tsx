// アプリ共通のブランド要素（ロゴアイコン・グラデーション）。
// App.tsx のグローバルヘッダーと EditorPage のサイドバー見出しで共用する。

import { BRAND_GRADIENT } from '../theme';

// 後方互換のため再エクスポート（既存 import 元を壊さない）
export { BRAND_GRADIENT };

// 2 点を点線で結ぶルートを表す線画アイコン。
const RouteGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="white"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M8 19h6a3 3 0 0 0 3-3V8" strokeDasharray="0.1 3.2" />
  </svg>
);

// グラデーションの角丸タイルにルートアイコンを載せたブランドマーク。
export const BrandMark: React.FC<{ size?: number }> = ({ size = 28 }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: `${Math.round(size * 0.29)}px`,
      background: BRAND_GRADIENT,
      boxShadow: '0 1px 3px rgba(66,133,244,0.4)',
      flexShrink: 0,
    }}
  >
    <RouteGlyph size={Math.round(size * 0.57)} />
  </span>
);
