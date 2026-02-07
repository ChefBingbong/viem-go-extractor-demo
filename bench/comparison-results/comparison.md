# Benchmark Comparison: Go (viem-go) vs TypeScript (viem)

> Generated: 2026-02-07T05:07:34.318Z
> CPU: Apple M4 Pro
> Go benchmarks: 3 runs averaged | TS benchmarks: variable iterations

---

## Overall Summary

| Metric | Value |
|--------|-------|
| **Overall Winner** | **Go (viem-go)** |
| Go wins | 10 / 14 |
| TypeScript wins | 2 / 14 |
| Ties (<5% diff) | 2 / 14 |

![Winner Breakdown](./charts/winner-breakdown.svg)

---

## Detailed Results

### Multicall

![Multicall](./charts/multicall-latency.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Single getReserves | 65.97ms | 73.05ms | 🟦 Go | Go 1.1x | 190 | 19,410 B |
| Batch 10 | 69.01ms | 71.06ms | ⬜ Tie | ~1.0x | 696 | 144,747 B |
| Batch 50 | 77.09ms | 86.48ms | 🟦 Go | Go 1.1x | 2,848 | 545,306 B |
| Batch 100 | 75.31ms | 326.57ms | 🟦 Go | Go 4.3x | 5,500 | 991,640 B |
| Batch 200 | 90.73ms | 285.21ms | 🟦 Go | Go 3.1x | 10,820 | 1,937,133 B |

### Event Decoding

![Event Decoding](./charts/event-decoding.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Single Sync decode | 153ns | 1.7us | 🟦 Go | Go 11.4x | 5 | 272 B |
| Batch 1000 Sync decode | 165.9us | 1.77ms | 🟦 Go | Go 10.7x | 5,000 | 272,001 B |

### Factory Sync

![Factory Sync](./charts/factory-sync.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| Chunk 50 | 141.18ms | 311.05ms | 🟦 Go | Go 2.2x | 10,112 | 1,917,883 B |
| Chunk 100 | 220.38ms | 482.77ms | 🟦 Go | Go 2.2x | 19,842 | 3,829,553 B |
| Chunk 500 | 743.51ms | 2.30s | 🟦 Go | Go 3.1x | 97,980 | 18,974,422 B |

### JSON Serialization

![JSON Serialization](./charts/json-serialization.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
| 100 pools | 53.4us | 48.1us | 🟪 TypeScript | TypeScript 1.1x | 10 | 41,286 B |
| 1,000 pools | 567.9us | 539.0us | 🟪 TypeScript | TypeScript 1.1x | 10 | 385,808 B |
| 5,000 pools | 2.68ms | 2.75ms | ⬜ Tie | ~1.0x | 10 | 1,911,606 B |
| 10,000 pools | 5.09ms | 5.61ms | 🟦 Go | Go 1.1x | 10 | 3,813,629 B |

---

## In-Depth Analysis

### 1. RPC / Multicall Performance

Both implementations use multicall to batch on-chain reads into single RPC calls.

- **Single call latency**: Go 65.97ms vs TS 73.05ms
- **Batch 200 latency**: Go 90.73ms vs TS 285.21ms
- **Scaling factor (1 -> 200)**: Go 1.4x vs TS 3.9x increase

Go's viem-go client has lower single-call latency, benefiting from Go's lightweight goroutine scheduling and efficient net/http stack. As batch sizes increase, both scale sub-linearly thanks to multicall aggregation.

### 2. Event Decoding Throughput

Event decoding is a pure CPU-bound operation (no RPC) — this is where language runtime differences show most clearly.

- **Go**: 153ns/event (6,548,788 ops/sec) — 5 allocs/op, 272 B/op
- **TS**: 1.7us/event (573,690 ops/sec)

Go's decode is **11.4x faster** per event. Go's `DecodeSyncEvent` does raw byte slicing on the hex data, while viem's `decodeEventLog` performs full ABI resolution.

### 3. Factory Sync (On-Chain Data at Scale)

Factory sync simulates the real-world workload: fetching pair addresses, then batching token0/token1/getReserves calls for all of them. This tests the full pipeline including RPC I/O, response parsing, and multicall encoding.

- **50 pools**: Go 141.18ms vs TS 311.05ms
- **500 pools**: Go 743.51ms vs TS 2.30s

At 500 pools, Go is **3.1x faster**. This is the most representative benchmark for comparing how each version handles extreme on-chain data lookups, as it mirrors the actual `syncFactoryStreaming` hot path.

### 4. JSON Serialization (API Response Performance)

The `/extractor-insights` endpoint serializes the entire pool map to JSON. This directly impacts API response time under load.

- **100 pools**: Go 53.4us vs TS 48.1us
- **10,000 pools**: Go 5.09ms vs TS 5.61ms

Go's `encoding/json` is **1.1x faster** at 10k pools. At this scale the serialization cost becomes a significant portion of API latency — consider streaming JSON or pagination if pool counts grow much further.

### 5. Memory Usage

**Go**: 0.02 MB for 10,000 pools (~0.00 KB/pool)
**TypeScript**: heap stats not available (vitest bench does not report per-benchmark memory)

> **Note**: Memory comparisons are approximate. Go reports heap allocations via `runtime.MemStats`, while TS reports `process.memoryUsage().heapUsed`. The TS number includes all benchmark overhead in the same process.

---

## Conclusion

| Category | Winner | Margin |
|----------|--------|--------|
| Multicall | 🟦 Go | 4/5 benchmarks |
| Event Decoding | 🟦 Go | 2/2 benchmarks |
| Factory Sync | 🟦 Go | 3/3 benchmarks |
| JSON Serialization | 🟪 TypeScript | 2/4 benchmarks |

### Key Takeaways

1. **Go (viem-go) wins 10/14 benchmarks overall.** Go's advantages come from its compiled nature, lower GC overhead, and efficient memory allocation patterns.
2. **TypeScript (viem) wins 2/14 benchmarks.** Bun's JIT compilation and viem's mature, well-optimized API make it competitive, especially for I/O-bound multicall operations.
3. **For production use**: If your bottleneck is on-chain data throughput (syncing thousands of pools), Go has a meaningful edge. If your bottleneck is API latency at moderate pool counts, both are equally capable.

---

*Generated by `bench/compare.ts` — run `make bench-compare` to regenerate.*
