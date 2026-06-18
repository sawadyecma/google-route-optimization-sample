// 軽量スポットライト型チュートリアルツアー（外部ライブラリ非依存）。
// 各ステップは data-tour 属性で対象要素を指定し、その周囲をハイライト（くり抜き）して
// 吹き出しで解説する。target 未指定のステップは画面中央に表示（イントロ/まとめ用）。
// ステップ内容は lib/tourSteps.ts に定義。開くたびのステップ初期化は呼び出し側の
// key による再マウントで行う（App.tsx 参照）。
//
// 仕組み：
//   - 透明のクリックブロッカーで背後の操作を一時的に遮断
//   - 対象矩形に box-shadow の巨大スプレッドを掛けて周囲だけ暗くする（=スポットライト）
//   - 吹き出しは対象の空いている側へ自動配置（左右優先→上下→中央フォールバック）
//   - スクロール（ネスト含む）・リサイズに追従して矩形を再計測

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TourStep } from '../lib/tourSteps';
import { color, radius } from '../theme';

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 6; // スポットライトの余白
const GAP = 14; // 対象と吹き出しの間隔
const MARGIN = 10; // ビューポート端からの最小マージン
const TIP_WIDTH = 300;

const Z = 10000;

const primaryBtn: React.CSSProperties = {
  border: 'none',
  background: color.blue,
  color: 'white',
  fontSize: '13px',
  fontWeight: 700,
  padding: '6px 14px',
  borderRadius: radius.sm,
  cursor: 'pointer',
};

const ghostBtn: React.CSSProperties = {
  border: `1px solid ${color.borderStrong}`,
  background: 'white',
  color: color.textSub,
  fontSize: '13px',
  padding: '6px 12px',
  borderRadius: radius.sm,
  cursor: 'pointer',
};

const skipBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: color.textMuted,
  fontSize: '12px',
  padding: '6px 4px',
  cursor: 'pointer',
};

export const Tour: React.FC<{
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
}> = ({ steps, open, onClose }) => {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const step = steps[index];
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  // 対象要素の矩形を計測（無ければ中央表示）
  const measure = useCallback(() => {
    const sel = step?.target;
    if (!sel) {
      setRect(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${sel}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step]);

  // ステップ切替時：対象を画面内へスクロールしてから計測
  // （計測は次フレームに回し、effect 内での同期 setState を避ける）
  useLayoutEffect(() => {
    if (!open) return;
    if (step?.target) {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [open, index, measure, step]);

  // スクロール（ネストした要素は capture で拾う）・リサイズに追従。
  // smooth スクロール中も滑らかに追わせるため短時間だけポーリングも併用。
  useEffect(() => {
    if (!open) return;
    const onChange = () => measure();
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    const poll = window.setInterval(measure, 80);
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 700);
    return () => {
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
      window.clearInterval(poll);
      window.clearTimeout(stopPoll);
    };
  }, [open, index, measure]);

  // 吹き出し位置の算出（対象の空いている側へ。中央ステップは画面中央）
  useLayoutEffect(() => {
    if (!open) return;
    const tip = tipRef.current;
    const tw = tip?.offsetWidth ?? TIP_WIDTH;
    const th = tip?.offsetHeight ?? 160;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!rect) {
      setPos({ left: (vw - tw) / 2, top: (vh - th) / 2 });
      return;
    }
    const clampH = (x: number) => Math.min(Math.max(x, MARGIN), vw - tw - MARGIN);
    const clampV = (y: number) => Math.min(Math.max(y, MARGIN), vh - th - MARGIN);
    const spaceLeft = rect.left;
    const spaceRight = vw - (rect.left + rect.width);
    const spaceBottom = vh - (rect.top + rect.height);
    const spaceTop = rect.top;
    const midV = clampV(rect.top + rect.height / 2 - th / 2);
    const midH = clampH(rect.left + rect.width / 2 - tw / 2);
    let p: { top: number; left: number };
    if (spaceLeft >= tw + GAP && spaceLeft >= spaceRight) {
      p = { left: rect.left - GAP - tw, top: midV };
    } else if (spaceRight >= tw + GAP) {
      p = { left: rect.left + rect.width + GAP, top: midV };
    } else if (spaceBottom >= th + GAP) {
      p = { left: midH, top: rect.top + rect.height + GAP };
    } else if (spaceTop >= th + GAP) {
      p = { left: midH, top: rect.top - GAP - th };
    } else {
      p = { left: (vw - tw) / 2, top: (vh - th) / 2 };
    }
    setPos(p);
  }, [open, rect, index]);

  const next = useCallback(() => {
    if (isLast) onClose();
    else setIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [isLast, onClose, steps.length]);
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // キーボード操作（Esc=閉じる / →・Enter=次へ / ←=戻る）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, prev, onClose]);

  if (!open || !step) return null;

  return createPortal(
    <>
      <style>{`@keyframes tourFade{from{opacity:0}to{opacity:1}}`}</style>

      {/* 透明クリックブロッカー：背後の操作を一時遮断 */}
      <div style={{ position: 'fixed', inset: 0, zIndex: Z, cursor: 'default' }} />

      {/* スポットライト（対象あり）／全面ディマー（中央ステップ） */}
      {rect ? (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: radius.lg,
            boxShadow: '0 0 0 9999px rgba(32,33,36,0.55)',
            border: `2px solid ${color.blue}`,
            zIndex: Z + 1,
            pointerEvents: 'none',
            transition: 'top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease',
          }}
        />
      ) : (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(32,33,36,0.55)',
            zIndex: Z + 1,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* 吹き出し */}
      <div
        ref={tipRef}
        style={{
          position: 'fixed',
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          width: TIP_WIDTH,
          maxWidth: 'calc(100vw - 20px)',
          backgroundColor: color.surface,
          borderRadius: radius.md,
          boxShadow: '0 6px 24px rgba(0,0,0,0.25)',
          zIndex: Z + 2,
          padding: '16px',
          boxSizing: 'border-box',
          visibility: pos ? 'visible' : 'hidden',
          animation: 'tourFade 0.2s ease',
        }}
      >
        <div
          style={{
            fontSize: '15px',
            fontWeight: 700,
            color: color.text,
            marginBottom: '8px',
          }}
        >
          {step.title}
        </div>
        <div style={{ fontSize: '13px', lineHeight: 1.7, color: color.textSub }}>{step.body}</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: '16px',
          }}
        >
          <span style={{ fontSize: '12px', color: color.textMuted }}>
            {index + 1} / {steps.length}
          </span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {!isLast && (
              <button onClick={onClose} style={skipBtn}>
                スキップ
              </button>
            )}
            {!isFirst && (
              <button onClick={prev} style={ghostBtn}>
                戻る
              </button>
            )}
            <button onClick={next} style={primaryBtn}>
              {isLast ? '完了' : '次へ'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
};
