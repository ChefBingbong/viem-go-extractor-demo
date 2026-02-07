/**
 * Viem (TypeScript) microbenchmarks — run with:
 *   bun run bench/ts/viem-bench.ts
 *
 * Requires RPC_URL env var (loaded from root .env automatically by Bun).
 *
 * Bench config mirrors Go's `go test -bench`:
 *   - benchTimeMs  → Go's -benchtime (target duration per run)
 *   - count        → Go's -count     (number of independent runs)
 *   - warmupTimeMs → Go's b.ResetTimer() after ramp-up
 */
import {
  type Address,
  createPublicClient,
  decodeEventLog,
  http,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import {
  factoryAbi,
  UniV2EventsListenAbi,
  uniswapV2PairAbi,
} from '../../mini-extractor-ts/lib/abi.js'

// ─── Shared Bench Config ─────────────────────────────────────────────────────
// These mirror the Go benchmark flags: -benchtime=3s -count=3
const BENCH_CONFIG = {
  benchTimeMs: 3_000, // Target time per run in ms  (Go: -benchtime=3s)
  count: 3, // Number of independent runs  (Go: -count=3)
  warmupTimeMs: 0, // No warmup — Go has none (b.ResetTimer excludes setup, not warmup)
}

// ─── RPC + Client Setup ──────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL
if (!RPC_URL) {
  console.error('RPC_URL not set — cannot run benchmarks')
  process.exit(1)
}

const FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' as const
const KNOWN_PAIR = '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc' as const // USDC-WETH

const client: PublicClient = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: { batchSize: 2048, wait: 16 } },
})

// ─── Bench Harness ───────────────────────────────────────────────────────────
//
// Mimics Go's testing.B:
//  1. Warmup: run fn() repeatedly for warmupTimeMs (like code before b.ResetTimer)
//  2. For each of `count` runs:
//     - Run fn() in a loop until benchTimeMs elapsed
//     - Record: iterations (N), total time, ns/op
//  3. Average across all runs (like Go averaging -count=N runs)

interface BenchResult {
  name: string
  runs: number
  iterations: number // total N across all runs
  avgNsPerOp: number
  avgMsPerOp: number
  minNsPerOp: number
  maxNsPerOp: number
  opsPerSec: number
  heapMB: number
}

interface SingleRun {
  iterations: number
  totalMs: number
  nsPerOp: number
}

/**
 * Time-based async benchmark (for RPC/IO-bound operations).
 * Runs fn() in a loop until benchTimeMs is reached, repeated `count` times.
 */
async function bench(
  name: string,
  fn: () => Promise<void>,
): Promise<BenchResult> {
  const { benchTimeMs, count, warmupTimeMs } = BENCH_CONFIG

  // Warmup phase — run until warmupTimeMs elapsed
  const warmupEnd = performance.now() + warmupTimeMs
  while (performance.now() < warmupEnd) {
    await fn()
  }

  // Timed runs
  const runs: SingleRun[] = []
  for (let r = 0; r < count; r++) {
    let iterations = 0
    const start = performance.now()
    const deadline = start + benchTimeMs
    while (performance.now() < deadline) {
      await fn()
      iterations++
    }
    const totalMs = performance.now() - start
    const nsPerOp = (totalMs * 1_000_000) / iterations
    runs.push({ iterations, totalMs, nsPerOp })
  }

  return finalize(name, runs)
}

/**
 * Time-based sync benchmark (for CPU-bound operations).
 * Runs fn() in a tight loop until benchTimeMs is reached, repeated `count` times.
 */
function syncBench(name: string, fn: () => void): BenchResult {
  const { benchTimeMs, count, warmupTimeMs } = BENCH_CONFIG

  // Warmup phase
  const warmupEnd = performance.now() + warmupTimeMs
  while (performance.now() < warmupEnd) {
    fn()
  }

  // Timed runs
  const runs: SingleRun[] = []
  for (let r = 0; r < count; r++) {
    let iterations = 0
    const start = performance.now()
    const deadline = start + benchTimeMs
    while (performance.now() < deadline) {
      fn()
      iterations++
    }
    const totalMs = performance.now() - start
    const nsPerOp = (totalMs * 1_000_000) / iterations
    runs.push({ iterations, totalMs, nsPerOp })
  }

  return finalize(name, runs)
}

function finalize(name: string, runs: SingleRun[]): BenchResult {
  const totalIterations = runs.reduce((s, r) => s + r.iterations, 0)
  const avgNsPerOp = runs.reduce((s, r) => s + r.nsPerOp, 0) / runs.length
  const minNsPerOp = Math.min(...runs.map((r) => r.nsPerOp))
  const maxNsPerOp = Math.max(...runs.map((r) => r.nsPerOp))
  const avgMsPerOp = avgNsPerOp / 1_000_000
  const opsPerSec = 1_000_000_000 / avgNsPerOp
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024

  const result: BenchResult = {
    name,
    runs: runs.length,
    iterations: totalIterations,
    avgNsPerOp: Math.round(avgNsPerOp * 100) / 100,
    avgMsPerOp: avgMsPerOp,
    minNsPerOp: Math.round(minNsPerOp * 100) / 100,
    maxNsPerOp: Math.round(maxNsPerOp * 100) / 100,
    opsPerSec: Math.round(opsPerSec),
    heapMB: Math.round(heapMB * 100) / 100,
  }

  // Print per-run details (matches Go's -count output style)
  for (const run of runs) {
    const fmtNs =
      run.nsPerOp >= 1_000_000
        ? `${(run.nsPerOp / 1_000_000).toFixed(2)} ms/op`
        : run.nsPerOp >= 1_000
          ? `${(run.nsPerOp / 1_000).toFixed(1)} us/op`
          : `${run.nsPerOp.toFixed(1)} ns/op`
    console.log(
      `  ${name.padEnd(45)} ${String(run.iterations).padStart(8)}    ${fmtNs}`,
    )
  }

  return result
}

// ─── Pre-fetch pair addresses (not timed — same as Go's setup in TestMain) ──

console.log('\n--- Prefetching pair addresses ---')
const pairAddresses: Address[] = []
const addrResults = await client.multicall({
  contracts: Array.from({ length: 200 }, (_, i) => ({
    address: FACTORY,
    abi: factoryAbi,
    functionName: 'allPairs' as const,
    args: [BigInt(i)] as const,
  })),
  allowFailure: true,
})
for (const r of addrResults) {
  if (r.status === 'success') pairAddresses.push(r.result as Address)
}
console.log(`  Fetched ${pairAddresses.length} pair addresses`)
console.log(
  `  Config: benchTime=${BENCH_CONFIG.benchTimeMs}ms, count=${BENCH_CONFIG.count}, warmup=${BENCH_CONFIG.warmupTimeMs}ms\n`,
)

// ─── Results collector ───────────────────────────────────────────────────────

const allResults: BenchResult[] = []

// ─── 1. Multicall Benchmarks ────────────────────────────────────────────────

console.log('=== MULTICALL BENCHMARKS ===')

allResults.push(
  await bench('multicall: single getReserves', async () => {
    await client.multicall({
      contracts: [
        {
          address: KNOWN_PAIR,
          abi: uniswapV2PairAbi,
          functionName: 'getReserves',
        },
      ],
      allowFailure: true,
    })
  }),
)

for (const size of [10, 50, 100, 200]) {
  if (size > pairAddresses.length) continue
  const contracts = pairAddresses.slice(0, size).map((addr) => ({
    address: addr,
    abi: uniswapV2PairAbi,
    functionName: 'getReserves' as const,
  }))
  allResults.push(
    await bench(`multicall: batch ${size} getReserves`, async () => {
      await client.multicall({ contracts, allowFailure: true })
    }),
  )
}

// ─── 2. Event Decoding Benchmarks ───────────────────────────────────────────

console.log('\n=== EVENT DECODING BENCHMARKS ===')

const sampleData =
  '0x00000000000000000000000000000000000000000000000000005af3107a400000000000000000000000000000000000000000000000000000000000003b9aca00' as `0x${string}`
const sampleTopics = [
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
] as [`0x${string}`]

allResults.push(
  syncBench('decodeEventLog: single Sync event', () => {
    decodeEventLog({
      abi: UniV2EventsListenAbi,
      data: sampleData,
      topics: sampleTopics,
    })
  }),
)

// Batch decode: 1000 decodes per iteration (same as Go's BenchmarkDecodeSyncEventBatch)
allResults.push(
  syncBench('decodeEventLog: batch 1000 Sync events', () => {
    for (let i = 0; i < 1000; i++) {
      decodeEventLog({
        abi: UniV2EventsListenAbi,
        data: sampleData,
        topics: sampleTopics,
      })
    }
  }),
)

// ─── 3. Factory Sync Simulation ─────────────────────────────────────────────

console.log('\n=== FACTORY SYNC THROUGHPUT ===')

for (const chunkSize of [50, 100, 500]) {
  allResults.push(
    await bench(`factory sync: chunk ${chunkSize} (addrs+info)`, async () => {
      // 1. Fetch pair addresses
      const addrContracts = Array.from({ length: chunkSize }, (_, j) => ({
        address: FACTORY,
        abi: factoryAbi,
        functionName: 'allPairs' as const,
        args: [BigInt(j)] as const,
      }))
      const addrRes = await client.multicall({
        contracts: addrContracts,
        allowFailure: true,
      })
      const addrs = addrRes
        .filter((r) => r.status === 'success')
        .map((r) => r.result as Address)

      // 2. Fetch token0 + token1 + reserves for all
      const infoContracts = addrs.flatMap((addr) => [
        {
          address: addr,
          abi: uniswapV2PairAbi,
          functionName: 'token0' as const,
        },
        {
          address: addr,
          abi: uniswapV2PairAbi,
          functionName: 'token1' as const,
        },
        {
          address: addr,
          abi: uniswapV2PairAbi,
          functionName: 'getReserves' as const,
        },
      ])
      await client.multicall({ contracts: infoContracts, allowFailure: true })
    }),
  )
}

// ─── 4. JSON Serialization Benchmark ────────────────────────────────────────

console.log('\n=== JSON SERIALIZATION BENCHMARKS ===')

for (const poolCount of [100, 1000, 5000, 10_000]) {
  // Setup data outside the timed loop (same as Go's b.ResetTimer after setup)
  const pools = Array.from({ length: poolCount }, (_, i) => ({
    address: `0x${'0'.repeat(38)}${i.toString(16).padStart(2, '0')}`,
    token0: {
      address: `0x${'0'.repeat(38)}${(i * 2).toString(16).padStart(2, '0')}`,
      symbol: 'TK0',
      name: 'Token0',
      decimals: 18,
    },
    token1: {
      address: `0x${'0'.repeat(38)}${(i * 2 + 1).toString(16).padStart(2, '0')}`,
      symbol: 'TK1',
      name: 'Token1',
      decimals: 18,
    },
    reserve0: '1000000000000000000',
    reserve1: '2000000000000000000',
    fee: 0.003,
    provider: 'UniswapV2',
  }))
  const resp = {
    blockNumber: 12345678,
    totalPools: poolCount,
    syncing: false,
    pools,
  }

  allResults.push(
    syncBench(`JSON.stringify: ${poolCount} pools`, () => {
      JSON.stringify(resp)
    }),
  )
}

// ─── 5. Memory Profile ──────────────────────────────────────────────────────

console.log('\n=== MEMORY PROFILE ===')

{
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const beforeMB = process.memoryUsage().heapUsed / 1024 / 1024

  const poolMap = new Map<
    string,
    {
      address: string
      token0: {
        address: string
        symbol: string
        name: string
        decimals: number
      }
      token1: {
        address: string
        symbol: string
        name: string
        decimals: number
      }
      reserve0: bigint
      reserve1: bigint
      fee: number
      provider: string
    }
  >()
  for (let i = 0; i < 10_000; i++) {
    const addr = `0x${i.toString(16).padStart(40, '0')}`
    poolMap.set(addr, {
      address: addr,
      token0: {
        address: `0x${(i * 2).toString(16).padStart(40, '0')}`,
        symbol: 'TK0',
        name: 'Token0',
        decimals: 18,
      },
      token1: {
        address: `0x${(i * 2 + 1).toString(16).padStart(40, '0')}`,
        symbol: 'TK1',
        name: 'Token1',
        decimals: 18,
      },
      reserve0: BigInt('1000000000000000000'),
      reserve1: BigInt('2000000000000000000'),
      fee: 0.003,
      provider: 'UniswapV2',
    })
  }

  if (typeof globalThis.gc === 'function') globalThis.gc()
  const afterMB = process.memoryUsage().heapUsed / 1024 / 1024
  console.log(
    `  Memory for 10,000 pools: ${(afterMB - beforeMB).toFixed(2)} MB  (~${(((afterMB - beforeMB) * 1024) / 10000).toFixed(2)} KB/pool)`,
  )
}

// ─── Write results ──────────────────────────────────────────────────────────

const fs = await import('node:fs')
const outDir = new URL('../results/', import.meta.url).pathname
fs.mkdirSync(outDir, { recursive: true })
const outPath = new URL('../results/ts-results.json', import.meta.url).pathname
fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2))
console.log(`\nResults written to ${outPath}`)
