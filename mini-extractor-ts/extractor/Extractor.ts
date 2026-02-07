import EventEmitter from 'node:events'
import type { PublicClient } from 'viem'
import { logger } from '../lib/logger.js'
import { LogFilter2, LogFilterType } from './LogFilter2.js'
import { TokenManager } from './TokenManager.js'
import { UniV2Extractor } from './UniV2Extractor.js'
import type { FactoryV2, PoolState } from './UniV2Types.js'

export class BlockEmitter extends EventEmitter {}

export type ExtractorConfig = {
  client: PublicClient
  factoriesV2: FactoryV2[]
  cacheDir: string
  logType?: LogFilterType
  logDepth: number
  maxPools?: number // 0 or undefined = unlimited; >0 = stop background sync after this many pools
  logging?: boolean
  debug?: boolean
}

export class Extractor {
  client: PublicClient
  extractorV2: UniV2Extractor
  tokenManager: TokenManager
  readonly logFilter: LogFilter2
  blockEmitter: EventEmitter
  config: ExtractorConfig

  constructor(args: ExtractorConfig) {
    this.config = args
    this.client = args.client
    this.blockEmitter = new BlockEmitter()

    const chainId = args.client.chain?.id as number

    this.tokenManager = new TokenManager(
      args.client,
      args.cacheDir,
      `tokens-${chainId}`,
    )

    this.logFilter = new LogFilter2(
      this.client,
      args.logDepth,
      args.logType ?? LogFilterType.OneCall,
      this.blockEmitter,
      args.logging,
    )

    this.extractorV2 = new UniV2Extractor(
      this.client,
      args.factoriesV2,
      args.cacheDir,
      this.logFilter,
      this.tokenManager,
      args.maxPools ?? 0,
    )
  }

  async start() {
    this.logFilter.start()
    await this.extractorV2.start()
    logger.info('Extractor started successfully')
  }

  getPools(): PoolState[] {
    return this.extractorV2.getPools()
  }

  getPoolMap(): Map<string, PoolState> {
    return this.extractorV2.getPoolMap()
  }

  isStarted(): boolean {
    return this.extractorV2.isStarted()
  }

  isSyncing(): boolean {
    return this.extractorV2.isSyncing()
  }
}
