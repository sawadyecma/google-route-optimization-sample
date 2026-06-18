# Vercel デプロイ手順書

このプロジェクト（`google-route-optimization-sample`）を Vercel にデプロイするための手順書です。

- **web**（`app/web` / Vite + React SPA）… Basic 認証付きの静的サイトとしてデプロイ
- **server**（`app/server` / Hono API）… Vercel Functions（サーバーレス）としてデプロイ
- **cmd**（`app/cmd` / CLI）… デプロイ対象外

---

## 0. 全体構成

同一の GitHub リポジトリから **2 つの Vercel プロジェクト**を作成します（モノレポ。各プロジェクトで Root Directory を切り替える）。

```
                          ┌─────────────────────────────────────┐
   ブラウザ ──Basic認証──▶ │ Vercel Project A  (web / 静的SPA)     │
                          │   Root Directory: app/web            │
                          │   middleware.ts で Basic 認証         │
                          └──────────────┬──────────────────────┘
                                         │  fetch  POST /optimize
                                         ▼
                          ┌─────────────────────────────────────┐
                          │ Vercel Project B  (server / Hono API)│
                          │   Root Directory: app/server         │
                          │   Vercel Functions (Node.js)         │
                          └──────────────┬──────────────────────┘
                                         │  サービスアカウント認証
                                         ▼
                          Google Route Optimization API
```

> デプロイ順序は **server → web** の順です。先に server をデプロイして URL を確定し、その URL を web の `VITE_API_BASE_URL` に設定してから web をビルド・デプロイします（Vite は環境変数をビルド時にバンドルへ埋め込むため）。

---

## 1. 前提条件

- [ ] Vercel アカウント（GitHub 連携済み）
- [ ] このリポジトリが GitHub に push 済み
- [ ] [Vercel CLI](https://vercel.com/docs/cli)（任意。ダッシュボード操作だけでも可）: `npm i -g vercel`
- [ ] [gcloud CLI](https://cloud.google.com/sdk/docs/install) がインストール済み
- [ ] Google Cloud プロジェクト（課金有効）
- [ ] Google Maps JavaScript API キー（web の地図表示用）

---

## 2. 事前のコード変更（必須）

ローカルでは動くが Vercel では動かない箇所が 3 つあるため、デプロイ前にコードを変更します。
いずれも **ローカル開発（`make dev-server` / `make dev-web`）を壊さない**ように分岐させています。

### 2-1. server を Vercel Functions に対応させる

`app/server/src/index.ts` は現状 `serve()` で常駐サーバーを起動しています。Vercel では
**`export default app`** された Hono インスタンスが自動的に Function 化される（ゼロコンフィグ）ため、
`serve()` はローカル実行時のみ動くように分岐させ、`export default app` を追加します。

[app/server/src/index.ts](../app/server/src/index.ts) を以下のように変更します（差分は末尾の `export` と `serve` 周辺）。

```ts
import dotenv from 'dotenv';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import {
  OptimizeToursRequest,
  RouteOptimizationError,
  optimizeTours,
} from './route-optimization';

dotenv.config();

const PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const PORT = Number(process.env.PORT ?? 3000);

if (!PROJECT_ID) {
  // Vercel では process.exit は使わず例外で落とす（Function のエラーとして表面化させる）
  throw new Error('環境変数 GOOGLE_PROJECT_ID が必要です');
}

const app = new Hono();

app.use('*', logger());
app.use('*', cors({ origin: '*' }));

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/optimize', async (c) => {
  let body: OptimizeToursRequest;
  try {
    body = await c.req.json<OptimizeToursRequest>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  try {
    const data = await optimizeTours(PROJECT_ID, body);
    return c.json(data);
  } catch (error) {
    if (error instanceof RouteOptimizationError) {
      return c.json(
        { error: error.message, details: error.details },
        error.status as 400 | 401 | 403 | 404 | 500,
      );
    }
    console.error('予期しないエラー:', error);
    return c.json({ error: 'internal server error' }, 500);
  }
});

// Vercel ではこの default export が自動的に Function として実行される
export default app;

// ローカル開発（make dev-server）でのみ Node サーバーを起動する。
// Vercel 実行環境では VERCEL=1 が自動設定されるため、ここは実行されない。
if (!process.env.VERCEL) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Server listening on http://localhost:${info.port}`);
    console.log(`  GET  /health`);
    console.log(`  POST /optimize`);
  });
}
```

### 2-2. server の Google 認証をサービスアカウント鍵に対応させる

ローカルは ADC（`gcloud auth application-default login`）で認証できますが、Vercel には ADC が存在しません。
そこで **サービスアカウント鍵を環境変数で渡す**経路を追加します。環境変数が無ければ従来どおり ADC を使うので、
ローカル開発はそのまま動きます。

[app/server/src/google-auth.ts](../app/server/src/google-auth.ts) を以下に置き換えます。

```ts
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
```

### 2-3. web に Basic 認証用の Edge Middleware を追加

Vite の静的サイトには Basic 認証機能が無いため、**Vercel Edge Middleware**（フレームワーク非依存）を使います。
Root Directory（`app/web`）直下に `middleware.ts` を置くと、静的アセットを含む全リクエストの前段で実行されます。

新規ファイル `app/web/middleware.ts` を作成します。

```ts
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
```

### 2-4. web に `@vercel/edge` を追加

Middleware で使う `next()` を提供するパッケージを web ワークスペースに追加します。

```bash
# リポジトリのルートで実行
npm install -w web @vercel/edge
```

> これで `app/web/package.json` の `devDependencies` に `@vercel/edge` が追加され、ルートの `package-lock.json` が更新されます。

### 2-5. 変更をコミットして push

```bash
git add -A
git commit -m "Add Vercel deploy support (functions entry, SA auth, basic auth middleware)"
git push origin main
```

---

## 3. Google Cloud 側の準備（サービスアカウント）

server がローカルの ADC ではなくサービスアカウントで認証できるようにします。

```bash
# 自分の値に置き換える
PROJECT_ID="your-project-id"
SA_NAME="route-opt-server"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# 1) Route Optimization API を有効化
gcloud services enable routeoptimization.googleapis.com --project="$PROJECT_ID"

# 2) サービスアカウントを作成
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Route Optimization server (Vercel)" \
  --project="$PROJECT_ID"

# 3) ロールを付与（Route Optimization 利用権限）
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/routeoptimization.editor"

# 4) 鍵(JSON)を発行
gcloud iam service-accounts keys create sa-key.json \
  --iam-account="$SA_EMAIL"
```

> **ロール名について**: `roles/routeoptimization.editor` が見つからない場合は、Cloud Console の
> 「IAM と管理 → ロール」で “Route Optimization” を検索して正しいロール ID を確認してください。
> 検証用途であれば一時的に `roles/editor`（プロジェクト編集者）でも動作します（本番では最小権限を推奨）。

発行した `sa-key.json` を **base64 1 行文字列**に変換します。これを Vercel の環境変数に貼り付けます。

```bash
# macOS（クリップボードへコピー）
base64 -i sa-key.json | tr -d '\n' | pbcopy

# Linux
base64 -w0 sa-key.json
```

> ⚠️ `sa-key.json` は機密情報です。`.gitignore` でルートに `*.json` 除外が無いため、**コミットしないよう**注意し、
> 使い終わったら `rm sa-key.json` で削除してください（base64 文字列は Vercel に保存済みになります）。

---

## 4. server を Vercel にデプロイ（Project B）

### 4-1. プロジェクト作成（ダッシュボード）

1. Vercel ダッシュボード → **Add New… → Project** → このリポジトリを Import
2. **Root Directory** を `app/server` に設定
3. **Framework Preset**: 自動で `Hono` が検出される（されない場合は `Hono` を選択）
4. Build / Output はゼロコンフィグのまま（変更不要）

### 4-2. 環境変数を設定

Project Settings → **Environment Variables**（Production / Preview 両方に設定）

| Key | Value |
|-----|-------|
| `GOOGLE_PROJECT_ID` | あなたの GCP プロジェクト ID |
| `GOOGLE_CREDENTIALS_BASE64` | 手順 3 で作った base64 1 行文字列 |

> `PORT` は不要です（Vercel Functions では使われません）。

### 4-3. Deploy

**Deploy** を実行。完了後、`https://<server-project>.vercel.app` の URL を控えます。

### 4-4. 動作確認

```bash
SERVER_URL="https://<server-project>.vercel.app"

# ヘルスチェック
curl "$SERVER_URL/health"
# => {"status":"ok"}

# 最適化（payload は OptimizeToursRequest 形式）
curl -X POST "$SERVER_URL/optimize" \
  -H 'Content-Type: application/json' \
  -d @./payload.json
```

> CLI でデプロイする場合は `cd app/server && vercel --prod`（初回は対話で Root Directory 等を設定）。

---

## 5. web を Vercel にデプロイ（Project A / Basic 認証付き）

### 5-1. プロジェクト作成（ダッシュボード）

1. Vercel ダッシュボード → **Add New… → Project** → 同じリポジトリを再度 Import
2. **Root Directory** を `app/web` に設定
3. **Framework Preset**: `Vite`（自動検出）
   - Build Command: `npm run build`（= `tsc -b && vite build`）
   - Output Directory: `dist`

> モノレポ（npm workspaces）のため、Vercel はルートの `package-lock.json` を検出して依存をインストールします。
> もし install に失敗する場合は Project Settings → General で
> 「Include files outside of the Root Directory in the Build Step」が ON になっているか確認してください。

### 5-2. 環境変数を設定

Project Settings → **Environment Variables**（Production / Preview 両方に設定）

| Key | Value | 用途 |
|-----|-------|------|
| `VITE_GOOGLE_MAPS_API_KEY` | Google Maps JavaScript API キー | 地図表示（ビルド時に埋め込み） |
| `VITE_API_BASE_URL` | `https://<server-project>.vercel.app` | server の URL（**末尾スラッシュ無し**） |
| `BASIC_AUTH_USER` | 任意のユーザー名 | Basic 認証（Middleware が実行時に参照） |
| `BASIC_AUTH_PASSWORD` | 任意のパスワード | Basic 認証 |

> - `VITE_*` は**ビルド時**にバンドルへ埋め込まれます。変更したら再デプロイが必要です。
> - `BASIC_AUTH_*` は **Edge Middleware が実行時**に参照します。
> - `VITE_API_BASE_URL` はコード上 `` `${apiBase}/optimize` `` と連結されるため、末尾スラッシュを付けないこと。

### 5-3. Deploy & 動作確認

**Deploy** 実行後、`https://<web-project>.vercel.app` にアクセスすると Basic 認証ダイアログが表示されます。

- [ ] 正しい `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` でログインできる
- [ ] 誤った資格情報では 401 のまま入れない
- [ ] ログイン後、地図が表示される（Maps キーが有効）
- [ ] ルート最適化の実行ボタンで `POST /optimize` が成功する（server と疎通）

```bash
# Basic 認証の CLI 確認
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASSWORD" https://<web-project>.vercel.app/
# 資格情報無し → 401 が返る
curl -i https://<web-project>.vercel.app/
```

---

## 6. デプロイ後の推奨設定

- **Google Maps API キーの制限**: Cloud Console で当該キーに「HTTP リファラー制限」を付け、
  `https://<web-project>.vercel.app/*`（独自ドメインがあればそれも）からのみ利用可能にする。
- **API サーバーの公開範囲**: server は CORS が `*` かつ認証なしの公開 API です。サンプル用途なら問題ありませんが、
  必要なら server 側にも Hono の `basicAuth` ミドルウェアや共有トークン検証を追加してください。
- **独自ドメイン**: Project Settings → Domains から割り当て可能。

---

## 7. 環境変数まとめ

| プロジェクト | Key | タイミング | 例 / 備考 |
|---|---|---|---|
| server | `GOOGLE_PROJECT_ID` | 実行時 | `route-optimization-sample` |
| server | `GOOGLE_CREDENTIALS_BASE64` | 実行時 | sa-key.json の base64 1 行 |
| web | `VITE_GOOGLE_MAPS_API_KEY` | ビルド時 | Maps JS API キー |
| web | `VITE_API_BASE_URL` | ビルド時 | `https://<server>.vercel.app`（末尾スラッシュ無し） |
| web | `BASIC_AUTH_USER` | 実行時(Edge) | 任意 |
| web | `BASIC_AUTH_PASSWORD` | 実行時(Edge) | 任意 |

---

## 8. トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| server が 500、ログに `GOOGLE_PROJECT_ID が必要です` | server プロジェクトに `GOOGLE_PROJECT_ID` 未設定。設定して再デプロイ。 |
| server が 401/403（Google 側） | サービスアカウントのロール不足、または `GOOGLE_CREDENTIALS_BASE64` の base64 が壊れている（改行混入など）。`tr -d '\n'` で 1 行化したか確認。 |
| server ビルドで `Cannot use import statement outside a module` | `app/server/package.json` に `"type": "module"` を追加（ローカル `tsc` ビルドを使う場合は tsconfig の `module` 設定と整合を取る）。 |
| web で地図が出ない | `VITE_GOOGLE_MAPS_API_KEY` 未設定 / リファラー制限で弾かれている。設定後**再デプロイ**（ビルド時反映のため）。 |
| web から最適化すると CORS / 接続エラー | `VITE_API_BASE_URL` が誤り（末尾スラッシュ、http/https、未デプロイ）。値を直して再デプロイ。 |
| Basic 認証ダイアログが出ない | `app/web/middleware.ts` が Root Directory（`app/web`）直下にあるか、`@vercel/edge` が入っているか確認。 |
| web の install 失敗（workspace 解決エラー） | 「Include files outside of the Root Directory」を ON。ルートの `package-lock.json` がコミット済みか確認。 |

---

## 付録: ローカル開発との両立

上記コード変更後も、ローカル開発は従来どおり動きます。

```bash
make env-setup      # .env / .env.local を作成
gcloud auth application-default login   # ローカルは ADC で認証
make dev-server     # http://localhost:3000（VERCEL 未設定なので serve() が起動）
make dev-web        # http://localhost:5173（middleware.ts は Vercel 上でのみ実行）
```

- `GOOGLE_CREDENTIALS_BASE64` をローカルで設定しなければ ADC が使われます。
- `middleware.ts` は Vercel のエッジでのみ実行されるため、`vite dev` には Basic 認証はかかりません。
