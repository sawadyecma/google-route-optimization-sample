import { useEffect, useState } from 'react';
import { LoadScript } from '@react-google-maps/api';
import { EditorPage } from './pages/EditorPage';
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

function App() {
  const [tourOpen, setTourOpen] = useState(false);

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

          {/* 使い方ツアーをいつでも再表示できるボタン */}
          <button
            onClick={() => setTourOpen(true)}
            title="使い方ツアーを表示"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
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

        <EditorPage />
      </div>

      {/* open になるたび key を変えて再マウントし、ステップを先頭へ初期化する */}
      <Tour key={tourOpen ? 'tour-open' : 'tour-closed'} steps={TOUR_STEPS} open={tourOpen} onClose={closeTour} />
    </LoadScript>
  );
}

export default App;
