import { GoogleAuth } from 'google-auth-library';

// 認証情報の解決方針:
// - 本番(Vercel): 環境変数 GOOGLE_CREDENTIALS_BASE64 に
//   サービスアカウント鍵(JSON)を base64 エンコードして設定する。
// - ローカル: 環境変数が無ければ ADC
//   （gcloud auth application-default login）を使う。
function loadCredentials(): Record<string, unknown> | undefined {
  const b64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (!b64) return undefined;
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json);
}

const credentials = loadCredentials();

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  ...(credentials ? { credentials } : {}),
});

export async function getAuthToken(): Promise<string> {
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken || !accessToken.token) {
    throw new Error('アクセストークンの取得に失敗しました');
  }
  return accessToken.token;
}
