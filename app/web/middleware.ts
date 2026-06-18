import { next } from '@vercel/edge';

export const config = {
  // 静的アセットを含む全リクエストに Basic 認証を適用する
  matcher: '/:path*',
};

export default function middleware(request: Request): Response {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Basic ')) {
    const encoded = authHeader.slice('Basic '.length);
    const decoded = atob(encoded); // "user:password"
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);

    if (user === expectedUser && password === expectedPassword) {
      return next(); // 認証 OK → そのままアプリへ
    }
  }

  // 未認証 → ブラウザの認証ダイアログを出す
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure Area", charset="UTF-8"',
    },
  });
}
