import { useEffect, useState } from 'react';
import { LoadScript } from '@react-google-maps/api';
import { EditorPage } from './pages/EditorPage';
import { SolverPlaygroundPage } from './pages/SolverPlaygroundPage';
import { SolverFieldPage } from './pages/SolverFieldPage';
import { BrandMark, BRAND_GRADIENT } from './components/Brand';
import { Tour } from './components/Tour';
import { TOUR_STEPS } from './lib/tourSteps';
import './App.css';

// 全ページで共通の Maps JS ロード設定
// geometry: encoded polyline のデコード（EditorPage で使用）
const MAPS_LIBRARIES: ('geometry')[] = ['geometry'];
const googleMapsApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '';

// チュートリアルツアーを初回だけ自動表示するための既読フラグ
const TOUR_SEEN_KEY = 'route-studio.tourSeen';

// ヘッダーのタブで切り替える画面。ルーターは入れず、状態ひとつで足りる規模に留める。
type Page = 'editor' | 'solver' | 'field';
const PAGES: { key: Page; label: string; hint: string }[] = [
  { key: 'editor', label: 'エディタ', hint: '座標を送って Google に経路計算ごと任せる通常モード' },
  {
    key: 'solver',
    label: 'ソルバー（実地図）',
    hint: '実際の地図の座標から自前の移動コスト行列を作って注入し、最適化だけを API にやらせるモード',
  },
  {
    key: 'field',
    label: 'ソルバー（仮想フィールド）',
    hint: '地図を使わず、フレーム上に置いた地点の直線距離から行列を作って最適化するモード',
  },
];

function App() {
  const [tourOpen, setTourOpen] = useState(false);
  const [page, setPage] = useState<Page>('editor');

  // 初回訪問時のみ自動でツアーを開く（レイアウト確定を待って少し遅延）
  useEffect(() => {
    if (localStorage.getItem(TOUR_SEEN_KEY)) return;
    const t = window.setTimeout(() => setTourOpen(true), 500);
    return () => window.clearTimeout(t);
  }, []);

  const closeTour = () => {
    setTourOpen(false);
    localStorage.setItem(TOUR_SEEN_KEY, '1');
  };

  return (
    <LoadScript googleMapsApiKey={googleMapsApiKey} libraries={MAPS_LIBRARIES}>
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            display: 'flex',
            gap: '8px',
            padding: '10px 18px',
            borderBottom: '1px solid #e8eaed',
            backgroundColor: 'white',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            alignItems: 'center',
            zIndex: 5,
          }}
        >
          <BrandMark size={28} />
          <span
            style={{
              fontSize: '16px',
              fontWeight: 700,
              letterSpacing: '0.01em',
              background: BRAND_GRADIENT,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Route Studio
          </span>

          {/* 画面切り替えタブ */}
          <nav style={{ display: 'flex', gap: '4px', marginLeft: '18px' }}>
            {PAGES.map((p) => (
              <button
                key={p.key}
                onClick={() => setPage(p.key)}
                title={p.hint}
                style={{
                  border: 'none',
                  background: page === p.key ? '#e8f0fe' : 'transparent',
                  color: page === p.key ? '#1967d2' : '#5f6368',
                  fontSize: '13px',
                  fontWeight: page === p.key ? 700 : 500,
                  padding: '6px 14px',
                  borderRadius: '999px',
                  cursor: 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </nav>

          {/* 使い方ツアーをいつでも再表示できるボタン（エディタ画面のみ） */}
          <button
            onClick={() => setTourOpen(true)}
            title="使い方ツアーを表示"
            style={{
              marginLeft: 'auto',
              display: page === 'editor' ? 'inline-flex' : 'none',
              alignItems: 'center',
              gap: '5px',
              border: '1px solid #dadce0',
              background: 'white',
              color: '#5f6368',
              fontSize: '12px',
              fontWeight: 600,
              padding: '5px 12px',
              borderRadius: '999px',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden>？</span>使い方
          </button>
        </header>

        {page === 'editor' && <EditorPage />}
        {page === 'solver' && <SolverPlaygroundPage />}
        {page === 'field' && <SolverFieldPage />}
      </div>

      {/* open になるたび key を変えて再マウントし、ステップを先頭へ初期化する */}
      <Tour
        key={tourOpen ? 'tour-open' : 'tour-closed'}
        steps={TOUR_STEPS}
        open={tourOpen && page === 'editor'}
        onClose={closeTour}
      />
    </LoadScript>
  );
}

export default App;
