# Google Route Optimization Sample

Google Route Optimization API の練習プロジェクトです。

## セットアップ

### 1. gcloud CLI のインストール

```bash
# macOS
brew install google-cloud-sdk

# Linux / Windows
# https://cloud.google.com/sdk/docs/install
```

### 2. gcloud で認証

```bash
gcloud auth application-default login
```

ブラウザが開くので、Google アカウントでログインしてください。

### 3. Project ID を設定

Google Cloud Console で Project ID を確認し、`.env` ファイルに設定します。

```bash
# ルートディレクトリで実行
npm install

# cmd パッケージで実行
cd app/cmd
cp .env.example .env
```

`.env` ファイルを編集：

```
GOOGLE_PROJECT_ID=your-project-id-here
```

## 実行

### CLI（cmd）で API を実行

```bash
# 開発環境（ts-node で直接実行）
make dev-cmd
# または
npm run --workspace=cmd dev

# ビルド
make build

# 本番環境（コンパイル済みコードを実行）
make start
```

### API サーバー（server）を起動

`app/server` は Hono ベースの API サーバーで、`POST /optimize` で受け取ったリクエストを Google Route Optimization API にそのまま転送します。

```bash
# .env を作成
make env-setup

# app/server/.env で GOOGLE_PROJECT_ID を設定したうえで起動
make dev-server
# または
npm run --workspace=server dev
```

デフォルトで `http://localhost:3000` で起動します。動作確認:

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/optimize \
  -H 'Content-Type: application/json' \
  -d @./payload.json
```

リクエストボディは [Route Optimization API の `OptimizeToursRequest`](https://cloud.google.com/optimization/docs/reference/rest/v1/projects/optimizeTours) と同じ形式（`model.shipments`, `model.vehicles` など）をそのまま受け取ります。

### Web ブラウザで結果を可視化

まず環境変数のテンプレートを作成します：

```bash
make env-setup
```

`app/web/.env.local` を編集し、Google Maps API キーを設定します（必要に応じて `VITE_API_BASE_URL` も）：

```
VITE_GOOGLE_MAPS_API_KEY=your-google-maps-api-key-here
VITE_API_BASE_URL=http://localhost:3000
```

その後、開発サーバーを起動：

```bash
make dev-web
# または
npm run --workspace=web dev
```

ブラウザで `http://localhost:5173` にアクセスしてルート最適化の結果を Google Maps 上で確認できます。

## 環境変数の管理

各ワークスペースは独立した env ファイルを持ちます（いずれも git 管理外）。
`make env-setup` で各 `.env.example` から雛形を作成できます。

| ワークスペース | ファイル | 変数 | 用途 |
|---|---|---|---|
| cmd | `app/cmd/.env` | `GOOGLE_PROJECT_ID` | 呼び出す GCP プロジェクト |
| server | `app/server/.env` | `GOOGLE_PROJECT_ID` | 呼び出す GCP プロジェクト |
| server | `app/server/.env` | `PORT` | ローカルの listen ポート（既定 3000） |
| server | `app/server/.env` | `GOOGLE_CREDENTIALS_BASE64` | （任意）デプロイ時のサービスアカウント鍵。ローカルは未設定で ADC を使用 |
| web | `app/web/.env.local` | `VITE_GOOGLE_MAPS_API_KEY` | 地図表示用の Maps API キー |
| web | `app/web/.env.local` | `VITE_API_BASE_URL` | バックエンド API の URL（末尾スラッシュ無し） |

- **ローカル認証**: cmd / server は `gcloud auth application-default login` の ADC を使うため、
  鍵ファイル（`GOOGLE_APPLICATION_CREDENTIALS`）は不要です。
- **Vite の制約**: web ではビルド時に `VITE_` 接頭辞の変数のみがバンドルへ埋め込まれます。
  値を変えたら再ビルドが必要で、`GOOGLE_PROJECT_ID` 等のサーバー側変数は web では使われません。
- **デプロイ時**: Vercel では環境変数はダッシュボードで設定します（`.env` ファイルは使いません）。
  サービスアカウント鍵・Basic 認証など本番固有の変数を含む全手順は
  [docs/vercel-deploy.md](docs/vercel-deploy.md) を参照してください。

## ディレクトリ構造

```
.
├── app/
│   ├── cmd/
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── dist/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── .env.example
│   │   └── .env (git 管理外)
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── google-auth.ts
│   │   │   └── route-optimization.ts
│   │   ├── dist/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── .env.example
│   │   └── .env (git 管理外)
│   └── web/
│       ├── src/
│       │   ├── components/
│       │   │   └── RouteVisualizer.tsx
│       │   ├── data/
│       │   │   └── testData.ts
│       │   ├── App.tsx
│       │   └── main.tsx
│       ├── dist/
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── .env.example
│       └── .env.local (git 管理外)
├── package.json
├── Makefile
└── .gitignore
```

## 利用できるコマンド

```bash
make help           # ヘルプを表示
make install        # 依存関係をインストール
make env-setup      # .env ファイルを作成

# CLI の実行
make dev-cmd        # CLI を開発モードで実行
make build-cmd      # CLI を TypeScript コンパイル
make start-cmd      # CLI をコンパイル済みコードで実行

# Web の実行
make dev-web        # Web を開発モードで実行

# API サーバーの実行
make dev-server     # API サーバーを開発モードで実行
make build-server   # API サーバーを TypeScript コンパイル
make start-server   # API サーバーをコンパイル済みコードで実行

# まとめてビルド
make build          # cmd と server をまとめてビルド

# メンテナンス
make clean          # ビルド成果物を削除
make format         # Prettier で整形
make lint           # ESLint を実行
```

## 機能

### CLI（app/cmd）

- Google Route Optimization API を呼び出し
- テストデータを送信
- API レスポンスを表示

### Web App（app/web）

- Google Maps 上にピックアップ・デリバリーポイントを表示
- ルート経路を可視化
- ポイント情報の詳細表示

### API Server（app/server）

- Hono 製の軽量 API サーバー
- `POST /optimize` で受け取ったリクエストを Google Route Optimization API に転送
- `GET /health` でヘルスチェック
- 全オリジン許可の CORS を有効化（開発用途）

## 今後の拡張

- `packages/` - 共通ライブラリの追加
