import { GoogleAuth } from 'google-auth-library';

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

export async function getAuthToken(): Promise<string> {
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken || !accessToken.token) {
    throw new Error('アクセストークンの取得に失敗しました');
  }
  return accessToken.token;
}
