import { GoogleAuth } from 'google-auth-library';

// 認証情報の解決方針:
// ローカルと Vercel で「コード（GoogleAuth）」は共通で、認証情報の "出どころ" だけを
// 環境変数 GOOGLE_CREDENTIALS_BASE64 の有無で切り替える。
//
// - ローカル: 環境変数が無い → credentials を渡さない → GoogleAuth が ADC の探索順
//   （GOOGLE_APPLICATION_CREDENTIALS → gcloud のADCファイル → GCEメタデータサーバ）で
//   資格情報を解決する。`gcloud auth application-default login` 済みなら個人の認証が使われる。
// - 本番(Vercel): 環境変数にサービスアカウント鍵(JSON)を base64 化して設定 → それを
//   credentials として明示的に渡す。
//   ※ Vercel は GCP ではなく gcloud のADCもメタデータサーバも無いため、鍵を注入しないと
//     認証に失敗する。これが分岐が必要な理由。
//
// どちらの経路でも最終的には getAuthToken() が OAuth アクセストークンを返す流れは同じ。
function loadCredentials(): Record<string, unknown> | undefined {
  const b64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (!b64) return undefined;
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json);
}

const credentials = loadCredentials();

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  // credentials があれば SA鍵で認証、無ければ未指定のまま ADC にフォールバックする
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
