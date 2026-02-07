/**
 * Viem (TypeScript) microbenchmarks using vitest bench.
 *
 * Run with:  vitest bench
 *
 * Each benchmark mirrors its Go counterpart in bench/go/viem_bench_test.go.
 * Every bench() gets its own describe() so it runs as an independent 3s test,
 * exactly like Go's b.Run() sub-benchmarks which each get their own -benchtime.
 */

import {
  type Address,
  createPublicClient,
  decodeEventLog,
  http,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { beforeAll, bench, describe } from 'vitest'
import {
  factoryAbi,
  uniswapV2PairAbi,
  UniV2EventsListenAbi,
} from '../../mini-extractor-ts/lib/abi.js'

// ─── Shared Config ───────────────────────────────────────────────────────────
// Mirrors Go: -benchtime=3s, no warmup

const BENCH_OPTIONS = {
  time: 3_000, // 3s per benchmark (Go: -benchtime=3s)
  warmupTime: 0, // No warmup (Go has none)
  warmupIterations: 0, // No warmup iterations
} as const

// ─── Constants (same as Go) ──────────────────────────────────────────────────

const FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' as const
const KNOWN_PAIR = '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc' as const // USDC-WETH

// ─── Client + Setup (mirrors Go's setupClient + fetchPairAddresses) ──────────

let client: PublicClient
const pairAddresses: Address[] = []

beforeAll(async () => {
  const RPC_URL = process.env.RPC_URL
  if (!RPC_URL) throw new Error('RPC_URL not set — cannot run benchmarks')

  client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
    batch: { multicall: { batchSize: 8196, wait: 16 } },
  })

  // Pre-fetch 200 pair addresses (same as Go's fetchPairAddresses(b, c, 200))
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
})

// ─── 1. Multicall Benchmarks ────────────────────────────────────────────────
// Go: BenchmarkMulticallSingle

describe('BenchmarkMulticallSingle', () => {
  bench(
    'single getReserves',
    async () => {
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
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkMulticallBatch/batch_10
describe('BenchmarkMulticallBatch/batch_10', () => {
  bench(
    'batch_10',
    async () => {
      const contracts = pairAddresses.slice(0, 10).map((addr) => ({
        address: addr,
        abi: uniswapV2PairAbi,
        functionName: 'getReserves' as const,
      }))
      await client.multicall({ contracts, allowFailure: true })
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkMulticallBatch/batch_50
describe('BenchmarkMulticallBatch/batch_50', () => {
  bench(
    'batch_50',
    async () => {
      const contracts = pairAddresses.slice(0, 50).map((addr) => ({
        address: addr,
        abi: uniswapV2PairAbi,
        functionName: 'getReserves' as const,
      }))
      await client.multicall({ contracts, allowFailure: true })
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkMulticallBatch/batch_100
describe('BenchmarkMulticallBatch/batch_100', () => {
  bench(
    'batch_100',
    async () => {
      const contracts = pairAddresses.slice(0, 100).map((addr) => ({
        address: addr,
        abi: uniswapV2PairAbi,
        functionName: 'getReserves' as const,
      }))
      await client.multicall({ contracts, allowFailure: true })
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkMulticallBatch/batch_200
describe('BenchmarkMulticallBatch/batch_200', () => {
  bench(
    'batch_200',
    async () => {
      const contracts = pairAddresses.slice(0, 200).map((addr) => ({
        address: addr,
        abi: uniswapV2PairAbi,
        functionName: 'getReserves' as const,
      }))
      await client.multicall({ contracts, allowFailure: true })
    },
    BENCH_OPTIONS,
  )
})

// ─── 2. Event Decoding Benchmarks ───────────────────────────────────────────

const sampleData =
  '0x00000000000000000000000000000000000000000000000000005af3107a400000000000000000000000000000000000000000000000000000000000003b9aca00' as `0x${string}`
const sampleTopics = [
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
] as [`0x${string}`]

// Go: BenchmarkDecodeSyncEvent
describe('BenchmarkDecodeSyncEvent', () => {
  bench(
    'single decode',
    () => {
      decodeEventLog({
        abi: UniV2EventsListenAbi,
        data: sampleData,
        topics: sampleTopics,
      })
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkDecodeSyncEventBatch
describe('BenchmarkDecodeSyncEventBatch', () => {
  bench(
    'batch 1000 decodes',
    () => {
      for (let i = 0; i < 1000; i++) {
        decodeEventLog({
          abi: UniV2EventsListenAbi,
          data: sampleData,
          topics: sampleTopics,
        })
      }
    },
    BENCH_OPTIONS,
  )
})

// ─── 3. Factory Sync Throughput ─────────────────────────────────────────────

// Go: BenchmarkFactorySyncChunks/chunk_50
describe('BenchmarkFactorySyncChunks/chunk_50', () => {
  bench(
    'chunk_50',
    async () => {
      const addrContracts = Array.from({ length: 50 }, (_, j) => ({
        address: FACTORY,
        abi: factoryAbi,
        functionName: 'allPairs' as const,
        args: [BigInt(j)] as const,
      }))
      const addrResults = await client.multicall({
        contracts: addrContracts,
        allowFailure: true,
      })
      const addrs = addrResults
        .filter((r) => r.status === 'success')
        .map((r) => r.result as Address)
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
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkFactorySyncChunks/chunk_100
describe('BenchmarkFactorySyncChunks/chunk_100', () => {
  bench(
    'chunk_100',
    async () => {
      const addrContracts = Array.from({ length: 100 }, (_, j) => ({
        address: FACTORY,
        abi: factoryAbi,
        functionName: 'allPairs' as const,
        args: [BigInt(j)] as const,
      }))
      const addrResults = await client.multicall({
        contracts: addrContracts,
        allowFailure: true,
      })
      const addrs = addrResults
        .filter((r) => r.status === 'success')
        .map((r) => r.result as Address)
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
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkFactorySyncChunks/chunk_500
describe('BenchmarkFactorySyncChunks/chunk_500', () => {
  bench(
    'chunk_500',
    async () => {
      const addrContracts = Array.from({ length: 500 }, (_, j) => ({
        address: FACTORY,
        abi: factoryAbi,
        functionName: 'allPairs' as const,
        args: [BigInt(j)] as const,
      }))
      const addrResults = await client.multicall({
        contracts: addrContracts,
        allowFailure: true,
      })
      const addrs = addrResults
        .filter((r) => r.status === 'success')
        .map((r) => r.result as Address)
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
    },
    BENCH_OPTIONS,
  )
})

// ─── 4. JSON Serialization Benchmark ────────────────────────────────────────

// Go: BenchmarkPoolSerializationJSON/pools_100
describe('BenchmarkPoolSerializationJSON/pools_100', () => {
  const pools = Array.from({ length: 100 }, (_, i) => makePool(i))
  const resp = { blockNumber: 12345678, totalPools: 100, syncing: false, pools }
  bench(
    'pools_100',
    () => {
      JSON.stringify(resp)
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkPoolSerializationJSON/pools_1000
describe('BenchmarkPoolSerializationJSON/pools_1000', () => {
  const pools = Array.from({ length: 1000 }, (_, i) => makePool(i))
  const resp = {
    blockNumber: 12345678,
    totalPools: 1000,
    syncing: false,
    pools,
  }
  bench(
    'pools_1000',
    () => {
      JSON.stringify(resp)
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkPoolSerializationJSON/pools_5000
describe('BenchmarkPoolSerializationJSON/pools_5000', () => {
  const pools = Array.from({ length: 5000 }, (_, i) => makePool(i))
  const resp = {
    blockNumber: 12345678,
    totalPools: 5000,
    syncing: false,
    pools,
  }
  bench(
    'pools_5000',
    () => {
      JSON.stringify(resp)
    },
    BENCH_OPTIONS,
  )
})

// Go: BenchmarkPoolSerializationJSON/pools_10000
describe('BenchmarkPoolSerializationJSON/pools_10000', () => {
  const pools = Array.from({ length: 10000 }, (_, i) => makePool(i))
  const resp = {
    blockNumber: 12345678,
    totalPools: 10000,
    syncing: false,
    pools,
  }
  bench(
    'pools_10000',
    () => {
      JSON.stringify(resp)
    },
    BENCH_OPTIONS,
  )
})

// ─── 5. Memory Profile ──────────────────────────────────────────────────────
// Go: TestPoolMapMemoryProfile

describe('PoolMapMemoryProfile', () => {
  bench(
    '10000 pools allocation',
    () => {
      const poolMap = new Map<string, ReturnType<typeof makePool>>()
      for (let i = 0; i < 10_000; i++) {
        const addr = `0x${i.toString(16).padStart(40, '0')}`
        poolMap.set(addr, {
          ...makePool(i),
          reserve0: '1000000000000000000',
          reserve1: '2000000000000000000',
        })
      }
    },
    { ...BENCH_OPTIONS, time: 1_000 },
  )
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePool(i: number) {
  return {
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
  }
}
