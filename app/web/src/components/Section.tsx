// サイドバーで使う共通カード。EditorPage と SolverPlaygroundPage で共用する。

import { color, radius, shadow, space } from '../theme';

// セクションの役割ごとのアクセント色とバッジ表記（入力=青 / 出力=緑 / 履歴=紫）
const SECTION_META: Record<'input' | 'output' | 'history', { accent: string; label: string }> = {
  input: { accent: color.blue, label: '入力' },
  output: { accent: color.green, label: '出力' },
  history: { accent: color.purple, label: '履歴' },
};

// 役割ラベル付きのカード。左アクセントバー＋ヘッダのバッジで役割をひと目で区別する。
export const Section: React.FC<{
  role: 'input' | 'output' | 'history';
  title: string;
  children: React.ReactNode;
  // チュートリアルツアーのスポットライト対象にするための目印（任意）
  dataTour?: string;
}> = ({ role, title, children, dataTour }) => {
  const { accent, label } = SECTION_META[role];
  return (
    <div
      data-tour={dataTour}
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

// 結果サマリの主要 KPI を見せる小カード
export const StatCard: React.FC<{ label: string; value: string; accent: string }> = ({
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
