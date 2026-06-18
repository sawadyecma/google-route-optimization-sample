import { LoadScript } from '@react-google-maps/api';
import { EditorPage } from './pages/EditorPage';
import { BrandMark, BRAND_GRADIENT } from './components/Brand';
import './App.css';

// 全ページで共通の Maps JS ロード設定
// geometry: encoded polyline のデコード（EditorPage で使用）
const MAPS_LIBRARIES: ('geometry')[] = ['geometry'];
const googleMapsApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '';

function App() {
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
        </header>

        <EditorPage />
      </div>
    </LoadScript>
  );
}

export default App;
