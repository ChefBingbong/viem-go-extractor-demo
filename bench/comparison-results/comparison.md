# Benchmark Comparison: Go (viem-go) vs TypeScript (viem)

> Generated: 2026-02-07T03:34:21.533Z
> CPU: Apple M4 Pro
> Go benchmarks: 3 runs averaged | TS benchmarks: variable iterations

---

## Overall Summary

| Metric | Value |
|--------|-------|
| **Overall Winner** | **Go (viem-go)** |
| Go wins | 8 / 14 |
| TypeScript wins | 4 / 14 |
| Ties (<5% diff) | 2 / 14 |

![Winner Breakdown](./charts/winner-breakdown.svg)

---

## Detailed Results

### Multicall

![Multicall](./charts/multicall-latency.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Single getReserves | 69.94ms | 71.75ms | ⬜ Tie | ~1.0x | 291 | 28,570 B |
| Batch 10 | 74.37ms | 71.01ms | ⬜ Tie | ~1.0x | 831 | 162,861 B |
| Batch 50 | 74.61ms | 93.53ms | 🟦 Go | Go 1.3x | 3,138 | 574,150 B |
| Batch 100 | 83.61ms | 220.06ms | 🟦 Go | Go 2.6x | 6,003 | 1,086,227 B |
| Batch 200 | 97.60ms | 345.50ms | 🟦 Go | Go 3.5x | 11,725 | 2,054,158 B |

### Event Decoding

![Event Decoding](./charts/event-decoding.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Single Sync decode | 238ns | 2.2us | 🟦 Go | Go 9.1x | 5 | 272 B |
| Batch 1000 Sync decode | 200.2us | 2.16ms | 🟦 Go | Go 10.8x | 5,000 | 272,001 B |

### Factory Sync

![Factory Sync](./charts/factory-sync.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Chunk 50 | 156.85ms | 346.36ms | 🟦 Go | Go 2.2x | 11,112 | 2,057,992 B |
| Chunk 100 | 221.85ms | 283.72ms | 🟦 Go | Go 1.3x | 21,653 | 4,120,195 B |
| Chunk 500 | 764.28ms | 935.27ms | 🟦 Go | Go 1.2x | 106,406 | 19,970,985 B |

### JSON Serialization

![JSON Serialization](./charts/json-serialization.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| 100 pools | 52.4us | 28.3us | 🟪 TypeScript | TypeScript 1.9x | 10 | 41,283 B |
| 1,000 pools | 523.1us | 227.3us | 🟪 TypeScript | TypeScript 2.3x | 10 | 385,757 B |
| 5,000 pools | 2.54ms | 1.45ms | 🟪 TypeScript | TypeScript 1.7x | 10 | 1,910,268 B |
| 10,000 pools | 6.81ms | 3.29ms | 🟪 TypeScript | TypeScript 2.1x | 10 | 3,813,457 B |

---

## In-Depth Analysis

### 1. RPC / Multicall Performance

Both implementations use multicall to batch on-chain reads into single RPC calls.

- **Single call latency**: Go 69.94ms vs TS 71.75ms
- **Batch 200 latency**: Go 97.60ms vs TS 345.50ms
- **Scaling factor (1 -> 200)**: Go 1.4x vs TS 4.8x increase

Go's viem-go client has lower single-call latency, benefiting from Go's lightweight goroutine scheduling and efficient net/http stack. As batch sizes increase, both scale sub-linearly thanks to multicall aggregation.

### 2. Event Decoding Throughput

Event decoding is a pure CPU-bound operation (no RPC) — this is where language runtime differences show most clearly.

- **Go**: 238ns/event (4,196,978 ops/sec) — 5 allocs/op, 272 B/op
- **TS**: 2.2us/event (459,222 ops/sec)

Go's decode is **9.1x faster** per event. Go's `DecodeSyncEvent` does raw byte slicing on the hex data, while viem's `decodeEventLog` performs full ABI resolution.

### 3. Factory Sync (On-Chain Data at Scale)

Factory sync simulates the real-world workload: fetching pair addresses, then batching token0/token1/getReserves calls for all of them. This tests the full pipeline including RPC I/O, response parsing, and multicall encoding.

- **50 pools**: Go 156.85ms vs TS 346.36ms
- **500 pools**: Go 764.28ms vs TS 935.27ms

At 500 pools, Go is **1.2x faster**. This is the most representative benchmark for comparing how each version handles extreme on-chain data lookups, as it mirrors the actual `syncFactoryStreaming` hot path.

### 4. JSON Serialization (API Response Performance)

The `/extractor-insights` endpoint serializes the entire pool map to JSON. This directly impacts API response time under load.

- **100 pools**: Go 52.4us vs TS 28.3us
- **10,000 pools**: Go 6.81ms vs TS 3.29ms

Bun's `JSON.stringify` is **2.1x faster** at 10k pools. At this scale the serialization cost becomes a significant portion of API latency — consider streaming JSON or pagination if pool counts grow much further.

### 5. Memory Usage

**Go**: 0.03 MB for 10,000 pools (~0.00 KB/pool)
**TypeScript**: 47.36 MB heap at end of benchmark run

> **Note**: Memory comparisons are approximate. Go reports heap allocations via `runtime.MemStats`, while TS reports `process.memoryUsage().heapUsed`. The TS number includes all benchmark overhead in the same process.

---

## Conclusion

| Category | Winner | Margin |
|----------|--------|--------|
| Multicall | 🟦 Go | 3/5 benchmarks |
| Event Decoding | 🟦 Go | 2/2 benchmarks |
| Factory Sync | 🟦 Go | 3/3 benchmarks |
| JSON Serialization | 🟪 TypeScript | 4/4 benchmarks |

### Key Takeaways

1. **Go (viem-go) wins 8/14 benchmarks overall.** Go's advantages come from its compiled nature, lower GC overhead, and efficient memory allocation patterns.
2. **TypeScript (viem) wins 4/14 benchmarks.** Bun's JIT compilation and viem's mature, well-optimized API make it competitive, especially for I/O-bound multicall operations.
3. **For production use**: If your bottleneck is on-chain data throughput (syncing thousands of pools), Go has a meaningful edge. If your bottleneck is API latency at moderate pool counts, both are equally capable.

---

*Generated by `bench/compare.ts` — run `make bench-compare` to regenerate.*
