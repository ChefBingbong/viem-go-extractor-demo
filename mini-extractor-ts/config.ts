import { createPublicClient, http, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import type { ExtractorConfig } from './extractor/Extractor.js'
import type { FactoryV2 } from './extractor/UniV2Types.js'

const RPC_URL = process.env.RPC_URL
if (!RPC_URL) throw new Error('RPC_URL env var is required')

export const PORT = Number(process.env.PORT ?? 3000)

const uniswapV2Factory: FactoryV2 = {
  address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  fee: 0.003,
  initCodeHash:
    '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
  provider: 'UniswapV2',
}

export const client: PublicClient = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: { batchSize: 2048, wait: 16 } },
  pollingInterval: Number(process.env.POLLING_INTERVAL ?? 200),
})

export const EXTRACTOR_CONFIG: ExtractorConfig = {
  client,
  factoriesV2: [uniswapV2Factory],
  cacheDir: process.env.CACHE_DIR ?? './cache/ts-cache',
  logDepth: Number(process.env.LOG_DEPTH ?? 50),
}
