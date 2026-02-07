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
.PHONY: install ts ts-dev go go-build dev start \
        bench-go bench-ts bench-compare bench-api bench-health bench-stress-ts bench-stress-go bench-all \
        k6-health k6-insights k6-stress-ts k6-stress-go k6-all k6-compare \
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

# ─── Benchmarks: Microbenchmarks ─────────────────────────────────────────────
bench-go: ## Run Go viem-go microbenchmarks
	@echo "=== Go Benchmarks ==="
	@echo "  Config: benchtime=3s, count=3, warmup=none"
	@mkdir -p bench/results
	cd bench/go && go test -bench=. -benchmem -benchtime=3s -count=3 -timeout=10m -v ./... \
		| tee ../../bench/results/go-bench.txt

bench-ts: ## Run TypeScript viem microbenchmarks
	@echo "=== TypeScript Benchmarks ==="
	@mkdir -p bench/results
	bun run bench/ts/viem-bench.ts

# ─── k6 API Load Tests ───────────────────────────────────────────────────────
POOL_LIMIT ?= 1000

k6-health: ## k6 /health load test (both services must be running)
	@mkdir -p bench/results
	k6 run --env TS_URL=http://localhost:$(TS_PORT) \
	       --env GO_URL=http://localhost:$(GO_PORT) \
	       bench/k6/health.js

k6-insights: ## k6 /extractor-insights load test (both must be running)
	@mkdir -p bench/results
	k6 run --env TS_URL=http://localhost:$(TS_PORT) \
	       --env GO_URL=http://localhost:$(GO_PORT) \
	       --env POOL_LIMIT=$(POOL_LIMIT) \
	       bench/k6/insights.js

k6-stress-ts: ## k6 stress test on the TypeScript service
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(TS_PORT) \
	       --env POOL_LIMIT=$(POOL_LIMIT) \
	       --env LABEL=ts \
	       bench/k6/stress.js

k6-stress-go: ## k6 stress test on the Go service
	@mkdir -p bench/results
	k6 run --env TARGET_URL=http://localhost:$(GO_PORT) \
	       --env POOL_LIMIT=$(POOL_LIMIT) \
	       --env LABEL=go \
	       bench/k6/stress.js

k6-all: k6-health k6-insights k6-stress-ts k6-stress-go k6-compare ## Run all k6 suites + comparison

k6-compare: ## Compare k6 results and generate report + charts
	@echo "=== Generating k6 Comparison Report ==="
	bun run bench/compare-k6.ts

# ─── Benchmarks: Comparison ───────────────────────────────────────────────────
bench-compare: ## Compare Go vs TS results and generate report + charts
	@echo "=== Generating Comparison Report ==="
	bun run bench/compare.ts

# ─── Benchmarks: Run All ─────────────────────────────────────────────────────
bench-all: bench-go bench-ts bench-compare ## Run all microbenchmarks + comparison
	@echo ""
	@echo "Done! Full comparison report: bench/comparison-results/comparison.md"
	@echo "Charts: bench/comparison-results/charts/"
	@echo ""
	@echo "To run k6 API load tests, start both services first (make dev) then:"
	@echo "  make k6-all            # Run all k6 suites + comparison report"
	@echo "  make k6-health         # /health load test"
	@echo "  make k6-insights       # /extractor-insights load test"
	@echo "  make k6-stress-ts      # TS stress test"
	@echo "  make k6-stress-go      # Go stress test"
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
