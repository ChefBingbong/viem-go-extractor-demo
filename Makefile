# ─── Config ───────────────────────────────────────────────────────────────────
ENV_FILE := .env

# Load .env vars (if the file exists) so every target inherits them
ifneq (,$(wildcard $(ENV_FILE)))
  include $(ENV_FILE)
  export
endif

# ─── TypeScript (Bun) ────────────────────────────────────────────────────────
.PHONY: install ts go dev stop

install: ## Install TypeScript dependencies
	bun install

ts: ## Start the TypeScript extractor
	bun run mini-extractor-ts/index.ts

ts-dev: ## Start the TypeScript extractor in watch mode
	bun --watch mini-extractor-ts/index.ts

# ─── Go ───────────────────────────────────────────────────────────────────────
go: ## Start the Go extractor
	cd mini-extractor-go && go run .

go-build: ## Build the Go extractor binary
	cd mini-extractor-go && go build -o ../bin/mini-extractor-go .

# ─── Both ─────────────────────────────────────────────────────────────────────
dev: ## Start both extractors in parallel
	@echo "Starting TypeScript extractor (Bun) and Go extractor..."
	@trap 'kill 0' SIGINT SIGTERM; \
		(bun run mini-extractor-ts/index.ts) & \
		(cd mini-extractor-go && go run .) & \
		wait

start: dev ## Alias for dev

# ─── Utilities ────────────────────────────────────────────────────────────────
clean: ## Remove build artifacts and caches
	rm -rf mini-extractor-ts/dist bin
	rm -rf cache

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
