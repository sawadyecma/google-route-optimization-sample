.PHONY: help install dev dev-cmd dev-web dev-server build build-cmd build-server start start-cmd start-server clean lint format env-setup watch

help:
	@echo "Google Route Optimization Sample - Available Commands"
	@echo ""
	@echo "Setup:"
	@echo "  make install       Install dependencies"
	@echo ""
	@echo "Development:"
	@echo "  make dev-cmd       Run cmd in development mode (ts-node)"
	@echo "  make dev-web       Run web in development mode (Vite)"
	@echo "  make dev-server    Run API server in development mode (ts-node-dev)"
	@echo "  make dev           Run all workspaces (開発モード)"
	@echo "  make build         Build TypeScript (cmd & server)"
	@echo "  make build-cmd     Build cmd only"
	@echo "  make build-server  Build server only"
	@echo "  make start         Run compiled cmd"
	@echo "  make start-server  Run compiled server"
	@echo ""
	@echo "Maintenance:"
	@echo "  make clean         Remove build artifacts"
	@echo "  make format        Format code with prettier"
	@echo "  make lint          Lint with eslint"
	@echo ""
	@echo "Info:"
	@echo "  make env-setup     Setup .env files from .env.example"

install:
	npm install

dev-cmd:
	npm run --workspace=cmd dev

dev-web:
	npm run --workspace=web dev

dev-server:
	npm run --workspace=server dev

dev:
	@echo "複数ワークスペースは同時実行できません"
	@echo "以下のいずれかを実行してください:"
	@echo "  make dev-cmd     # CLI を実行"
	@echo "  make dev-web     # Web を実行"
	@echo "  make dev-server  # API サーバーを実行"

build: build-cmd build-server

build-cmd:
	npm run --workspace=cmd build

build-server:
	npm run --workspace=server build

start: start-cmd

start-cmd: build-cmd
	npm run --workspace=cmd start

start-server: build-server
	npm run --workspace=server start

clean:
	rm -rf app/cmd/dist app/web/dist app/server/dist
	rm -rf node_modules app/cmd/node_modules app/web/node_modules app/server/node_modules
	rm -rf package-lock.json app/cmd/package-lock.json app/web/package-lock.json app/server/package-lock.json

env-setup:
	@if [ ! -f app/cmd/.env ]; then \
		cp app/cmd/.env.example app/cmd/.env; \
		echo "✓ app/cmd/.env ファイルを作成しました"; \
		echo "⚠️  Google Project ID を設定してください"; \
	else \
		echo "✓ app/cmd/.env は既に存在します"; \
	fi
	@if [ ! -f app/web/.env.local ]; then \
		cp app/web/.env.example app/web/.env.local; \
		echo "✓ app/web/.env.local ファイルを作成しました"; \
		echo "⚠️  Google Maps API キーを設定してください"; \
	else \
		echo "✓ app/web/.env.local は既に存在します"; \
	fi
	@if [ ! -f app/server/.env ]; then \
		cp app/server/.env.example app/server/.env; \
		echo "✓ app/server/.env ファイルを作成しました"; \
		echo "⚠️  Google Project ID を設定してください"; \
	else \
		echo "✓ app/server/.env は既に存在します"; \
	fi

format:
	npx prettier --write "app/cmd/src/**/*.ts" "app/server/src/**/*.ts"

lint:
	npx eslint "app/cmd/src/**/*.ts" "app/server/src/**/*.ts" || true

watch:
	npm run --workspace=cmd dev -- --watch
