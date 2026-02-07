# Benchmark Comparison: Go (viem-go) vs TypeScript (viem)

> Generated: 2026-02-07T06:41:03.108Z
> CPU: Apple M4 Pro
> Go benchmarks: 3 runs averaged | TS benchmarks: variable iterations

---

## Overall Summary

| Metric | Value |
|--------|-------|
| **Overall Winner** | **Go (viem-go)** |
| Go wins | 12 / 14 |
| TypeScript wins | 1 / 14 |
| Ties (<5% diff) | 1 / 14 |

![Winner Breakdown](./charts/winner-breakdown.svg)

---

## Detailed Results

### Multicall

![Multicall](./charts/multicall-latency.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Single getReserves | 69.46ms | 68.84ms | ⬜ Tie | ~1.0x | 125 | 18,123 B |
| Batch 10 | 71.29ms | 77.63ms | 🟦 Go | Go 1.1x | 254 | 130,116 B |
| Batch 50 | 71.43ms | 98.02ms | 🟦 Go | Go 1.4x | 762 | 469,265 B |
| Batch 100 | 73.13ms | 116.49ms | 🟦 Go | Go 1.6x | 1,363 | 862,947 B |
| Batch 200 | 122.36ms | 172.80ms | 🟦 Go | Go 1.4x | 2,577 | 1,565,167 B |

### Event Decoding

![Event Decoding](./charts/event-decoding.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Single Sync decode | 165ns | 1.7us | 🟦 Go | Go 10.4x | 5 | 272 B |
| Batch 1000 Sync decode | 168.6us | 1.67ms | 🟦 Go | Go 9.9x | 5,000 | 272,000 B |

### Factory Sync

![Factory Sync](./charts/factory-sync.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Chunk 50 | 136.59ms | 279.66ms | 🟦 Go | Go 2.0x | 1,770 | 1,435,747 B |
| Chunk 100 | 227.70ms | 307.27ms | 🟦 Go | Go 1.3x | 3,262 | 2,958,984 B |
| Chunk 500 | 846.39ms | 909.37ms | 🟦 Go | Go 1.1x | 15,274 | 13,796,532 B |

### JSON Serialization

![JSON Serialization](./charts/json-serialization.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| 100 pools | 54.9us | 46.7us | 🟪 TypeScript | TypeScript 1.2x | 10 | 41,292 B |
| 1,000 pools | 506.2us | 593.3us | 🟦 Go | Go 1.2x | 10 | 385,759 B |
| 5,000 pools | 2.55ms | 2.76ms | 🟦 Go | Go 1.1x | 10 | 1,912,991 B |
| 10,000 pools | 4.96ms | 5.55ms | 🟦 Go | Go 1.1x | 10 | 3,813,359 B |

---

## In-Depth Analysis

### 1. RPC / Multicall Performance

Both implementations use multicall to batch on-chain reads into single RPC calls.

- **Single call latency**: Go 69.46ms vs TS 68.84ms
- **Batch 200 latency**: Go 122.36ms vs TS 172.80ms
- **Scaling factor (1 -> 200)**: Go 1.8x vs TS 2.5x increase

TypeScript's viem client has lower single-call latency, likely due to Bun's optimized HTTP stack and viem's efficient request batching. As batch sizes increase, both scale sub-linearly thanks to multicall aggregation.

### 2. Event Decoding Throughput

Event decoding is a pure CPU-bound operation (no RPC) — this is where language runtime differences show most clearly.

- **Go**: 165ns/event (6,067,961 ops/sec) — 5 allocs/op, 272 B/op
- **TS**: 1.7us/event (586,078 ops/sec)

Go's decode is **10.4x faster** per event. Go's `DecodeSyncEvent` does raw byte slicing on the hex data, while viem's `decodeEventLog` performs full ABI resolution.

### 3. Factory Sync (On-Chain Data at Scale)

Factory sync simulates the real-world workload: fetching pair addresses, then batching token0/token1/getReserves calls for all of them. This tests the full pipeline including RPC I/O, response parsing, and multicall encoding.

- **50 pools**: Go 136.59ms vs TS 279.66ms
- **500 pools**: Go 846.39ms vs TS 909.37ms

At 500 pools, Go is **1.1x faster**. This is the most representative benchmark for comparing how each version handles extreme on-chain data lookups, as it mirrors the actual `syncFactoryStreaming` hot path.

### 4. JSON Serialization (API Response Performance)

The `/extractor-insights` endpoint serializes the entire pool map to JSON. This directly impacts API response time under load.

- **100 pools**: Go 54.9us vs TS 46.7us
- **10,000 pools**: Go 4.96ms vs TS 5.55ms

Go's `encoding/json` is **1.1x faster** at 10k pools. At this scale the serialization cost becomes a significant portion of API latency — consider streaming JSON or pagination if pool counts grow much further.

### 5. Memory Usage

**TypeScript**: heap stats not available (vitest bench does not report per-benchmark memory)

> **Note**: Memory comparisons are approximate. Go reports heap allocations via `runtime.MemStats`, while TS reports `process.memoryUsage().heapUsed`. The TS number includes all benchmark overhead in the same process.

---

## Conclusion

| Category | Winner | Margin |
|----------|--------|--------|
| Multicall | 🟦 Go | 4/5 benchmarks |
| Event Decoding | 🟦 Go | 2/2 benchmarks |
| Factory Sync | 🟦 Go | 3/3 benchmarks |
| JSON Serialization | 🟦 Go | 3/4 benchmarks |

### Key Takeaways

1. **Go (viem-go) wins 12/14 benchmarks overall.** Go's advantages come from its compiled nature, lower GC overhead, and efficient memory allocation patterns.
2. **TypeScript (viem) wins 1/14 benchmarks.** Bun's JIT compilation and viem's mature, well-optimized API make it competitive, especially for I/O-bound multicall operations.
3. **For production use**: If your bottleneck is on-chain data throughput (syncing thousands of pools), Go has a meaningful edge. If your bottleneck is API latency at moderate pool counts, both are equally capable.

---

*Generated by `bench/compare.ts` — run `make bench-compare` to regenerate.*
