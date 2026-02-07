# viem vs viem-go: Extractor Performance Comparison

A side-by-side benchmark comparing [viem](https://viem.sh/) (TypeScript/Bun) and [viem-go](https://github.com/ChefBingbong/viem-go) (Go) by running identical UniswapV2 pool extractor applications against the same RPC endpoint.

Both extractors do the same work: sync pool data from on-chain UniswapV2 factories via multicall, decode Sync events from block logs, resolve ERC-20 token metadata, and serve the pool state over an HTTP API.

## Prerequisites

- [Bun](https://bun.sh/) (v1.3+)
- [Go](https://go.dev/) (v1.24+)
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (for API load tests)
- An Ethereum RPC URL (set in `.env`)

## Setup

```bash
# 1. Clone and enter the project
cd viem-go-extractor-demo

# 2. Copy the env template and set your RPC URL
cp .env.example .env
# Edit .env and set RPC_URL=https://your-rpc-url

# 3. Install TypeScript dependencies
make install

# 4. Verify Go dependencies
cd mini-extractor-go && go mod tidy && cd ..
```

## Running the Extractors

```bash
make ts              # Start TypeScript extractor only
make go              # Start Go extractor only
make dev             # Start both in parallel
```

## Running Benchmarks

### CPU / Library Microbenchmarks

These benchmark the core viem library operations in isolation — no running services needed, just an RPC URL.

```bash
make bench-go        # Go benchmarks (benchtime=3s, count=3)
make bench-ts        # TypeScript benchmarks (same config)
make bench-compare   # Generate comparison report + charts
make bench-all       # All three in sequence
```

Both harnesses use identical configuration:
- **benchtime**: 3 seconds per run (time-based, not fixed iterations)
- **count**: 3 independent runs per benchmark
- **warmup**: none (neither Go nor TS gets warmup iterations)

Results are written to `bench/results/` and the comparison report to `bench/comparison-results/`.

### k6 API Load Tests

These test the HTTP endpoints under concurrent load. Both services must be running first.

```bash
# Terminal 1: start both services
make dev

# Terminal 2: run k6 suites
make k6-health       # /health endpoint (lightweight)
make k6-insights     # /extractor-insights?limit=1000 (serializes pools)
make k6-stress-ts    # Stress test TS (50 steady → 200 spike VUs)
make k6-stress-go    # Stress test Go (50 steady → 200 spike VUs)
make k6-compare      # Generate comparison report + charts
make k6-all          # All five in sequence
```

Both insights and stress tests use `?limit=1000` to ensure equal data volume regardless of how many pools each service has synced.

---

## Benchmark Results

> CPU: Apple M4 Pro | RPC: QuickNode Ethereum Mainnet
> All results are averages across 3 independent runs

### CPU Benchmark Summary

![Winner Breakdown](./bench/comparison-results/charts/winner-breakdown.svg)

| Category | Go Wins | TS Wins | Ties | Winner |
|----------|---------|---------|------|--------|
| Multicall (RPC batching) | 3 | 0 | 2 | Go |
| Event Decoding (CPU-bound) | 2 | 0 | 0 | Go |
| Factory Sync (full pipeline) | 3 | 0 | 0 | Go |
| JSON Serialization | 0 | 4 | 0 | TypeScript |
| **Total** | **8** | **4** | **2** | **Go** |

---

### 1. Multicall Performance

Multicall batches multiple smart contract reads into a single RPC call. This is the core primitive both libraries use for all on-chain data fetching.

![Multicall Latency](./bench/comparison-results/charts/multicall-latency.svg)

| Batch Size | Go | TypeScript | Winner | Speedup |
|------------|-----|-----------|--------|---------|
| 1 contract | 69.9ms | 71.8ms | Tie | ~1.0x |
| 10 contracts | 74.4ms | 71.0ms | Tie | ~1.0x |
| 50 contracts | 74.6ms | 93.5ms | Go | 1.3x |
| 100 contracts | 83.6ms | 220.1ms | Go | 2.6x |
| 200 contracts | 97.6ms | 345.5ms | Go | 3.5x |

**Analysis**: At small batch sizes (1-10 contracts), both libraries are neck and neck — latency is dominated by the RPC round-trip. As batch size grows, Go's advantage becomes dramatic. At 200 contracts, Go is **3.5x faster**. This suggests viem's multicall encoding or response parsing has quadratic-ish overhead at larger batch sizes, whereas viem-go scales linearly. Since the real extractor batches up to 1048 contracts per multicall, this difference compounds significantly during factory sync.

---

### 2. Event Decoding

Decoding Sync events from raw log data is a pure CPU operation with no I/O. This isolates the language runtime and library overhead.

![Event Decoding](./bench/comparison-results/charts/event-decoding.svg)

| Benchmark | Go | TypeScript | Speedup |
|-----------|-----|-----------|---------|
| Single decode | 238 ns/op | 2,178 ns/op | Go **9.1x** faster |
| 1000 decodes | 200 us | 2,160 us | Go **10.8x** faster |

**Analysis**: Go is an order of magnitude faster at event decoding. Go's `DecodeSyncEvent` does direct byte slicing on the hex data (two `big.Int.SetBytes` calls), while viem's `decodeEventLog` performs full ABI schema lookup, topic matching, and typed decoding. In the real extractor, every block's Sync events flow through this path, so a 10x decode speedup translates to meaningfully lower CPU usage per block.

---

### 3. Factory Sync (On-Chain Data at Scale)

This is the most representative benchmark — it simulates the actual `syncFactoryStreaming` hot path: fetch N pair addresses via `allPairs()`, then batch-fetch `token0`, `token1`, and `getReserves` for all of them.

![Factory Sync](./bench/comparison-results/charts/factory-sync.svg)

| Chunk Size | Go | TypeScript | Speedup |
|------------|-----|-----------|---------|
| 50 pools | 157ms | 346ms | Go **2.2x** faster |
| 100 pools | 222ms | 284ms | Go **1.3x** faster |
| 500 pools | 764ms | 935ms | Go **1.2x** faster |

**Analysis**: Go wins across all sizes, with the largest advantage at smaller chunks where the overhead-per-call ratio is highest. At 500 pools (which involves 2 multicalls — one for addresses, one for 1500 contract calls), Go saves ~170ms per batch. Over a full factory sync of 60,000+ pools, this advantage compounds to minutes of wall-clock difference.

---

### 4. JSON Serialization

The `/extractor-insights` endpoint serializes the entire pool map to JSON. This benchmark measures pure serialization throughput at various pool counts.

![JSON Serialization](./bench/comparison-results/charts/json-serialization.svg)

| Pool Count | Go | TypeScript | Speedup |
|------------|-----|-----------|---------|
| 100 | 52 us | 28 us | TS **1.9x** faster |
| 1,000 | 523 us | 227 us | TS **2.3x** faster |
| 5,000 | 2.54ms | 1.45ms | TS **1.7x** faster |
| 10,000 | 6.81ms | 3.29ms | TS **2.1x** faster |

**Analysis**: TypeScript wins decisively here. Bun's `JSON.stringify` is consistently ~2x faster than Go's `encoding/json.Marshal`. This is one of Bun's marquee optimizations — its JSON serializer is written in Zig and heavily optimized for common patterns. Go's standard library `encoding/json` is known to be slower than alternatives like `sonic` or `go-json`; switching to one of those would likely close this gap.

---

## k6 API Load Test Results

All k6 tests use `?limit=1000` to ensure both services serialize the same data volume per request, regardless of how many pools each has synced.

### /health — Lightweight Endpoint

![Health Latency](./bench/comparison-results/charts/k6-health-latency.svg)

| Percentile | Go | TypeScript | Speedup |
|------------|-----|-----------|---------|
| avg | 23.5ms | 1.9ms | TS **12.2x** |
| p50 | 11.1ms | 0.3ms | TS **36.4x** |
| p95 | 84.6ms | 5.9ms | TS **14.3x** |
| p99 | 162.3ms | 21.0ms | TS **7.7x** |

### /extractor-insights — Heavy Endpoint

![Insights Latency](./bench/comparison-results/charts/k6-insights-latency.svg)

| Percentile | Go | TypeScript | Speedup |
|------------|-----|-----------|---------|
| avg | 42.6ms | 10.0ms | TS **4.3x** |
| p50 | 14.5ms | 2.5ms | TS **5.7x** |
| p95 | 151.5ms | 43.8ms | TS **3.5x** |
| p99 | 354.8ms | 110.1ms | TS **3.2x** |

Both services processed 29,934 requests with 3.4 GB transferred and 0% error rate.

### Stress Test — 50 Steady to 200 Spike VUs

![Stress Latency](./bench/comparison-results/charts/k6-stress-latency.svg)

| Percentile | Go | TypeScript | Speedup |
|------------|-----|-----------|---------|
| avg | 423.8ms | 77.4ms | TS **5.5x** |
| p50 | 256.4ms | 45.5ms | TS **5.6x** |
| p95 | 1,354.9ms | 203.3ms | TS **6.7x** |
| p99 | 2,069.0ms | 315.3ms | TS **6.6x** |

| Metric | Go | TypeScript |
|--------|-----|-----------|
| Total requests | 28,350 | 135,796 |
| Throughput | ~147 req/s | ~706 req/s |
| Error rate | 0% | 0% |

**Analysis**: TypeScript dominates the API load tests by a wide margin. Bun's event-loop-based HTTP server (Elysia on top of Bun's native server) handles concurrent connections extremely efficiently — its single-threaded async I/O model avoids goroutine scheduling overhead and delivers consistently low latency even under 200 concurrent users. Go's `net/http` with synchronous handler goroutines shows higher tail latency as concurrency increases. The 2x JSON serialization advantage for TS also compounds here since every response involves serializing 1000 pools.

Note that Go's `net/http` performance could be improved by switching to a more optimized server like `fasthttp`, adding response caching, or using a faster JSON library (`sonic`, `go-json`).

---

## Overall Verdict

| Dimension | Winner | Key Insight |
|-----------|--------|-------------|
| **RPC Multicall** | Go | 3.5x faster at large batch sizes (200 contracts) |
| **Event Decoding** | Go | 9-11x faster (compiled byte slicing vs ABI resolution) |
| **Factory Sync** | Go | 1.2-2.2x faster end-to-end on-chain data pipeline |
| **JSON Serialization** | TypeScript | 1.7-2.3x faster (Bun's Zig-optimized JSON) |
| **HTTP API (low load)** | TypeScript | 12-36x lower latency on /health |
| **HTTP API (high load)** | TypeScript | 5-7x lower latency, 4.8x higher throughput under stress |

### When to choose Go (viem-go)

- Your bottleneck is **on-chain data throughput** — syncing tens of thousands of pools, processing high event volumes
- You need **predictable memory usage** and minimal GC pauses
- You're building backend infrastructure where **CPU-bound decoding** dominates
- You want a single compiled binary with no runtime dependencies

### When to choose TypeScript (viem)

- Your bottleneck is **API serving** — returning pool data to clients under concurrent load
- You want the **most mature library** with the largest ecosystem, best documentation, and widest chain support
- You need fast **JSON serialization** for large API responses
- You're building a full-stack application where **developer velocity** matters
- You want to leverage Bun's extremely fast HTTP server

### The big picture

Go (viem-go) is the better choice for the **data pipeline** — fetching, decoding, and processing on-chain data. TypeScript (viem) is the better choice for the **API layer** — serving that data to clients. In a production architecture, the optimal design might be a Go-based indexer feeding data into a Bun/TypeScript API server.

---

## Regenerating Results

```bash
# CPU benchmarks (no running services needed)
make bench-all

# k6 API load tests (start services first)
make dev             # Terminal 1
make k6-all          # Terminal 2

# Regenerate reports from existing results
make bench-compare
make k6-compare
```

All reports are written to `bench/comparison-results/`.
