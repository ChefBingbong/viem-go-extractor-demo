# ─── Config ───────────────────────────────────────────────────────────────────
ENV_FILE := .env
TS_PORT  ?= 8000
GO_PORT  ?= 8001

# Load .env vars (if the file exists) so every target inherits them
ifneq (,$(wildcard $(ENV_FILE)))
  include $(ENV_FILE)
  export
endif

# ─── TypeScript (Bun) ────────────────────────────────────────────────────────
.PHONY: install ts ts-dev go go-build dev dev-anvil start \
        bench-go bench-ts bench-compare bench-all \
        k6-health-ts k6-health-go k6-insights-ts k6-insights-go k6-stress-ts k6-stress-go k6-all k6-compare k6-anvil-all \
        clean help

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

# ─── Anvil (local fork) ──────────────────────────────────────────────────────
dev-anvil: ## Start both extractors against local Anvil forks (Ctrl+C to stop)
	bash bench/anvil-dev.sh

k6-anvil-all: ## Full k6 pipeline: Anvil + extractors + all k6 suites + report
	bash bench/anvil-dev.sh make k6-all

# ─── Benchmarks: Microbenchmarks (each spins up its own Anvil) ────────────────
bench-go: ## Run Go microbenchmarks (starts Anvil, runs benches, stops Anvil)
	@mkdir -p bench/results
	bash bench/anvil.sh make _bench-go-inner

bench-ts: ## Run TS microbenchmarks (starts Anvil, runs benches, stops Anvil)
	@mkdir -p bench/results
	bash bench/anvil.sh make _bench-ts-inner

# Internal targets — called by anvil.sh with RPC_URL already set
_bench-go-inner:
	@echo "=== Go Benchmarks (RPC: $$RPC_URL) ==="
	@echo "  Config: benchtime=3s, count=1, warmup=none"
	cd bench/go && go test -bench=. -benchmem -benchtime=3s -count=1 -timeout=10m -v ./... \
		| tee ../../bench/results/go-bench.txt

_bench-ts-inner:
	@echo "=== TypeScript Benchmarks (RPC: $$RPC_URL) ==="
	bunx vitest bench --run

# ─── k6 API Load Tests (each service tested independently — no interleaving) ─
POOL_LIMIT ?= 1000

k6-health-ts: ## k6 /health on TypeScript
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(TS_PORT) --env LABEL=ts bench/k6/health.js

k6-health-go: ## k6 /health on Go
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(GO_PORT) --env LABEL=go bench/k6/health.js

k6-insights-ts: ## k6 /extractor-insights on TypeScript
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(TS_PORT) --env POOL_LIMIT=$(POOL_LIMIT) --env LABEL=ts bench/k6/insights.js

k6-insights-go: ## k6 /extractor-insights on Go
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(GO_PORT) --env POOL_LIMIT=$(POOL_LIMIT) --env LABEL=go bench/k6/insights.js

k6-stress-ts: ## k6 stress test on TypeScript
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(TS_PORT) --env POOL_LIMIT=$(POOL_LIMIT) --env LABEL=ts bench/k6/stress.js

k6-stress-go: ## k6 stress test on Go
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(GO_PORT) --env POOL_LIMIT=$(POOL_LIMIT) --env LABEL=go bench/k6/stress.js

k6-all: k6-health-ts k6-health-go k6-insights-ts k6-insights-go k6-stress-ts k6-stress-go k6-compare ## Run all k6 suites + comparison

k6-compare: ## Compare k6 results and generate report + charts
	@echo "=== Generating k6 Comparison Report ==="
	bun run bench/compare-k6.ts

# ─── Benchmarks: Comparison ───────────────────────────────────────────────────
bench-compare: ## Compare Go vs TS results and generate report + charts
	@echo "=== Generating Comparison Report ==="
	bun run bench/compare.ts

# ─── Benchmarks: Run All (single Anvil for both Go + TS) ─────────────────────
bench-all: ## Run all microbenchmarks + comparison (single Anvil instance)
	@mkdir -p bench/results
	bash bench/anvil.sh sh -c 'make _bench-go-inner && make _bench-ts-inner && make bench-compare'
	@echo ""
	@echo "Done! Full comparison report: bench/comparison-results/comparison.md"
	@echo "Charts: bench/comparison-results/charts/"
	@echo ""
	@echo "To run k6 API load tests, start both services first (make dev) then:"
	@echo "  make k6-all            # Run all k6 suites sequentially + comparison"
	@echo "  make k6-health-ts      # /health on TS only"
	@echo "  make k6-health-go      # /health on Go only"
	@echo "  make k6-insights-ts    # /insights on TS only"
	@echo "  make k6-insights-go    # /insights on Go only"
	@echo "  make k6-stress-ts      # Stress test TS"
	@echo "  make k6-stress-go      # Stress test Go"
	@echo "  make k6-compare        # Generate comparison report from results"

# ─── Utilities ────────────────────────────────────────────────────────────────
clean: ## Remove build artifacts, caches, and bench results
	rm -rf mini-extractor-ts/dist bin
	rm -rf cache
	rm -rf bench/results bench/comparison-results

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' Makefile | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
