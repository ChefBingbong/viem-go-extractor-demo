import path from 'node:path'
import { type Address, decodeEventLog, type Log, type PublicClient } from 'viem'
import {
  factoryAbi,
  uniswapV2PairAbi,
  UniV2EventsListenAbi,
} from '../lib/abi.js'
import { logger } from '../lib/logger.js'
import type { Token } from '../lib/token.js'
import type { LogFilter2 } from './LogFilter2.js'
import { PermanentCache } from './PermanentCache.js'
import type { TokenManager } from './TokenManager.js'
import type {
  FactoryV2,
  PoolCacheRecord,
  PoolState,
  SyncState,
} from './UniV2Types.js'
import {
  readSyncState,
  repeat,
  writeSyncState,
  writeSyncStateSync,
} from './Utils.js'

const MULTICALL_BATCH_SIZE = 1048

export class UniV2Extractor {
  readonly client: PublicClient
  readonly tokenManager: TokenManager

  readonly factories: FactoryV2[]
  readonly factoryMap: Map<string, FactoryV2> = new Map()
  readonly poolMap: Map<string, PoolState> = new Map()

  readonly logFilter: LogFilter2
  readonly poolPermanentCache: PermanentCache<PoolCacheRecord>
  readonly syncStatePath: string

  private readonly pendingLogDiscovery: Set<string> = new Set()

  started = false
  syncing = false

  constructor(
    client: PublicClient,
    factories: FactoryV2[],
    cacheDir: string,
    logFilter: LogFilter2,
    tokenManager: TokenManager,
  ) {
    this.client = client
    this.factories = factories
    this.tokenManager = tokenManager
    this.logFilter = logFilter
    this.syncStatePath = path.resolve(cacheDir, `uniV2SyncState.json`)

    this.poolPermanentCache = new PermanentCache(cacheDir, `uniV2Pools`)

    factories.forEach((f) => {
      this.factoryMap.set(f.address.toLowerCase(), f)
    })

    logFilter.addFilter(UniV2EventsListenAbi, (logs?: Log[]) => {
      if (logs) {
        let eventKnown = 0
        let eventUnknown = 0
        logs.forEach((l) => {
          const {
            args: { reserve0, reserve1 },
          } = decodeEventLog({
            abi: UniV2EventsListenAbi,
            data: l.data,
            topics: l.topics,
          })
          const addrL = l.address.toLowerCase()
          const pool = this.poolMap.get(addrL)
          if (pool) {
            if (
              reserve0 !== undefined &&
              reserve1 !== undefined &&
              !l.removed
            ) {
              pool.reserve0 = reserve0
              pool.reserve1 = reserve1
            }
            ++eventKnown
          } else {
            ++eventUnknown
            if (reserve0 !== undefined && reserve1 !== undefined)
              this.addPoolByLog(l.address, reserve0, reserve1)
          }
        })
        const blockNumber =
          logs.length > 0
            ? Number(logs[logs.length - 1].blockNumber || 0)
            : '<undefined>'
        this.consoleLog(
          `Block ${blockNumber} ${logs.length} logs (${eventKnown} known, ${eventUnknown} unknown), pools: ${this.poolMap.size}`,
        )
      } else {
        logger.extractorError('UniV2: Log collecting failed')
      }
    })
  }

  // ---- Batched multicall helpers ----

  private async batchGetReserves(
    addresses: Address[],
  ): Promise<Map<string, [bigint, bigint] | undefined>> {
    const results = new Map<string, [bigint, bigint] | undefined>()
    for (let i = 0; i < addresses.length; i += MULTICALL_BATCH_SIZE) {
      const chunk = addresses.slice(i, i + MULTICALL_BATCH_SIZE)
      const contracts = chunk.map((address) => ({
        address,
        abi: uniswapV2PairAbi,
        functionName: 'getReserves' as const,
      }))
      const mcResults = await this.client.multicall({
        contracts,
        allowFailure: true,
      })
      for (let j = 0; j < chunk.length; j++) {
        const r = mcResults[j]
        if (r.status === 'success') {
          const [r0, r1] = r.result as [bigint, bigint, number]
          results.set(chunk[j].toLowerCase(), [r0, r1])
        } else {
          results.set(chunk[j].toLowerCase(), undefined)
        }
      }
    }
    return results
  }

  private tokenToInfo(token: Token) {
    return {
      address: token.address,
      symbol: token.symbol ?? '',
      name: token.name ?? '',
      decimals: token.decimals,
    }
  }

  private addPool(
    address: Address,
    token0: Token,
    token1: Token,
    reserve0: bigint,
    reserve1: bigint,
    factory: FactoryV2,
    log: boolean,
  ): PoolState {
    const [t0, t1] = token0.sortsBefore(token1)
      ? [token0, token1]
      : [token1, token0]

    const state: PoolState = {
      address,
      token0: this.tokenToInfo(t0),
      token1: this.tokenToInfo(t1),
      reserve0,
      reserve1,
      fee: factory.fee,
      provider: factory.provider,
    }
    this.poolMap.set(address.toLowerCase(), state)
    if (log) {
      this.consoleLog(
        `add pool ${address} ${t0.symbol}-${t1.symbol}, total: ${this.poolMap.size}`,
      )
    }
    return state
  }

  async start() {
    const startTime = performance.now()
    if (this.tokenManager.tokens.size === 0)
      await this.tokenManager.addCachedTokens()

    const syncState = readSyncState(this.syncStatePath)

    let needsBackgroundSync = false
    for (const factory of this.factories) {
      const factoryKey = factory.address.toLowerCase()
      const [lenResult] = await this.client.multicall({
        contracts: [
          {
            address: factory.address,
            abi: factoryAbi,
            functionName: 'allPairsLength',
          },
        ],
        allowFailure: true,
      })
      if (lenResult.status === 'failure') continue
      const onChainCount = Number(lenResult.result as bigint)
      const lastSynced = syncState[factoryKey] ?? 0
      this.consoleLog(
        `${factory.provider}: on-chain=${onChainCount}, synced=${lastSynced}`,
      )
      if (lastSynced < onChainCount) needsBackgroundSync = true
    }

    await this.loadCachedPools(startTime)

    this.consoleLog(
      `ExtractorV2 ready (${Math.round(performance.now() - startTime)}ms), ${this.poolMap.size} pools from cache`,
    )
    this.started = true

    if (needsBackgroundSync) {
      this.syncing = true
      this.backgroundSync(syncState).catch((e) => {
        logger.extractorError('Background sync failed', e)
        this.syncing = false
      })
    }
  }

  private async backgroundSync(syncState: SyncState) {
    await writeSyncState(this.syncStatePath, syncState)

    for (const factory of this.factories) {
      await this.syncFactoryStreaming(factory, syncState)
    }
    writeSyncStateSync(this.syncStatePath, syncState)

    this.syncing = false
    this.consoleLog(
      `Background sync complete. ${this.poolMap.size} total pools.`,
    )
  }

  private async syncFactoryStreaming(factory: FactoryV2, syncState: SyncState) {
    const factoryKey = factory.address.toLowerCase()

    const [lenResult] = await this.client.multicall({
      contracts: [
        {
          address: factory.address,
          abi: factoryAbi,
          functionName: 'allPairsLength',
        },
      ],
      allowFailure: true,
    })
    if (lenResult.status === 'failure') {
      logger.extractorError(
        `Failed to get allPairsLength for ${factory.provider}`,
      )
      return
    }
    const onChainCount = Number(lenResult.result as bigint)
    const lastSynced = syncState[factoryKey] ?? 0

    if (lastSynced >= onChainCount) return

    const total = onChainCount - lastSynced
    this.consoleLog(
      `${factory.provider}: syncing ${total} new pools in background (${lastSynced}→${onChainCount})...`,
    )

    let synced = 0
    let lastSyncWrite = Date.now()
    const SYNC_WRITE_INTERVAL = 10_000 // flush sync state every 10s

    for (let i = lastSynced; i < onChainCount; i += MULTICALL_BATCH_SIZE) {
      const end = Math.min(i + MULTICALL_BATCH_SIZE, onChainCount)
      const chunkSize = end - i

      // 1. Fetch addresses
      const addrContracts = []
      for (let j = i; j < end; j++) {
        addrContracts.push({
          address: factory.address,
          abi: factoryAbi,
          functionName: 'allPairs' as const,
          args: [BigInt(j)] as const,
        })
      }
      const addrResults = await this.client.multicall({
        contracts: addrContracts,
        allowFailure: true,
      })
      const addresses: Address[] = []
      for (const r of addrResults) {
        if (r.status === 'success') addresses.push(r.result as Address)
      }

      const newAddresses = addresses.filter(
        (a) => !this.poolMap.has(a.toLowerCase()),
      )
      if (newAddresses.length === 0) {
        synced += chunkSize
        // Update index even when skipping — these were fetched
        syncState[factoryKey] = end
        if (Date.now() - lastSyncWrite >= SYNC_WRITE_INTERVAL) {
          await writeSyncState(this.syncStatePath, syncState)
          lastSyncWrite = Date.now()
        }
        continue
      }

      const infoContracts: {
        address: Address
        abi: typeof uniswapV2PairAbi
        functionName: 'token0' | 'token1' | 'getReserves'
      }[] = []
      for (const addr of newAddresses) {
        infoContracts.push({
          address: addr,
          abi: uniswapV2PairAbi,
          functionName: 'token0',
        })
        infoContracts.push({
          address: addr,
          abi: uniswapV2PairAbi,
          functionName: 'token1',
        })
        infoContracts.push({
          address: addr,
          abi: uniswapV2PairAbi,
          functionName: 'getReserves',
        })
      }
      const infoResults = await this.client.multicall({
        contracts: infoContracts,
        allowFailure: true,
      })

      // 3. Parse + resolve tokens
      const tokenAddrs = new Set<Address>()
      type PoolInfo = {
        address: Address
        token0Addr: Address
        token1Addr: Address
        reserve0: bigint
        reserve1: bigint
      }
      const pools: PoolInfo[] = []

      for (let j = 0; j < newAddresses.length; j++) {
        const t0R = infoResults[j * 3]
        const t1R = infoResults[j * 3 + 1]
        const resR = infoResults[j * 3 + 2]
        if (
          t0R.status === 'success' &&
          t1R.status === 'success' &&
          resR.status === 'success'
        ) {
          const t0 = t0R.result as Address
          const t1 = t1R.result as Address
          const [r0, r1] = resR.result as [bigint, bigint, number]
          tokenAddrs.add(t0)
          tokenAddrs.add(t1)
          pools.push({
            address: newAddresses[j],
            token0Addr: t0,
            token1Addr: t1,
            reserve0: r0,
            reserve1: r1,
          })
        }
      }

      const unknownTokens = Array.from(tokenAddrs).filter(
        (a) => !this.tokenManager.getKnownToken(a),
      )
      if (unknownTokens.length > 0) {
        await Promise.allSettled(
          unknownTokens.map((a) => this.tokenManager.findToken(a)),
        )
      }

      // 4. Add pools
      let chunkAdded = 0
      for (const p of pools) {
        if (this.poolMap.has(p.address.toLowerCase())) continue
        let token0 = this.tokenManager.getKnownToken(p.token0Addr)
        let token1 = this.tokenManager.getKnownToken(p.token1Addr)
        if (!token0) token0 = await this.tokenManager.findToken(p.token0Addr)
        if (!token1) token1 = await this.tokenManager.findToken(p.token1Addr)
        if (!token0 || !token1) continue

        this.addPool(
          p.address,
          token0,
          token1,
          p.reserve0,
          p.reserve1,
          factory,
          false,
        )
        this.poolPermanentCache.add({
          address: p.address,
          token0: p.token0Addr,
          token1: p.token1Addr,
          factory: factory.address,
        })
        ++chunkAdded
      }

      synced += chunkSize
      syncState[factoryKey] = end
      this.consoleLog(
        `  ${factory.provider}: ${synced}/${total} (+${chunkAdded} pools), total map: ${this.poolMap.size}`,
      )

      // Periodic sync state flush
      if (Date.now() - lastSyncWrite >= SYNC_WRITE_INTERVAL) {
        await writeSyncState(this.syncStatePath, syncState)
        lastSyncWrite = Date.now()
      }
    }

    // Final flush
    syncState[factoryKey] = onChainCount
    await writeSyncState(this.syncStatePath, syncState)
    this.consoleLog(
      `  ${factory.provider}: sync complete (index=${onChainCount})`,
    )
  }

  private async loadCachedPools(startTime: number) {
    const cachedRecords = await this.poolPermanentCache.getAllRecords()
    const seen = new Set<string>()

    type RawEntry = {
      address: Address
      token0Addr: Address
      token1Addr: Address
      factoryAddr: string
    }
    const rawEntries: RawEntry[] = []

    for (const r of cachedRecords) {
      const addrL = r.address.toLowerCase()
      if (seen.has(addrL) || this.poolMap.has(addrL)) continue
      seen.add(addrL)
      if (!this.factoryMap.has(r.factory.toLowerCase())) continue
      rawEntries.push({
        address: r.address,
        token0Addr: r.token0,
        token1Addr: r.token1,
        factoryAddr: r.factory,
      })
    }

    if (rawEntries.length === 0) {
      this.consoleLog('No cached pools to load')
      return
    }

    const allTokenAddrs = new Set<Address>()
    for (const r of rawEntries) {
      allTokenAddrs.add(r.token0Addr)
      allTokenAddrs.add(r.token1Addr)
    }
    const missingTokens = Array.from(allTokenAddrs).filter(
      (a) => !this.tokenManager.getKnownToken(a),
    )
    if (missingTokens.length > 0) {
      this.consoleLog(`Resolving ${missingTokens.length} missing tokens...`)
      for (let i = 0; i < missingTokens.length; i += MULTICALL_BATCH_SIZE) {
        const chunk = missingTokens.slice(i, i + MULTICALL_BATCH_SIZE)
        await Promise.allSettled(
          chunk.map((a) => this.tokenManager.findToken(a)),
        )
      }
    }

    type Entry = {
      address: Address
      token0: Token
      token1: Token
      factory: FactoryV2
    }
    const entries: Entry[] = []
    let skipped = 0
    for (const r of rawEntries) {
      const token0 = this.tokenManager.getKnownToken(r.token0Addr)
      const token1 = this.tokenManager.getKnownToken(r.token1Addr)
      const factory = this.factoryMap.get(r.factoryAddr.toLowerCase())!
      if (token0 && token1) {
        entries.push({ address: r.address, token0, token1, factory })
      } else {
        ++skipped
      }
    }

    if (skipped > 0)
      this.consoleLog(`Skipped ${skipped} pools (unresolvable tokens)`)
    if (entries.length === 0) return

    this.consoleLog(`Loading ${entries.length} pools from cache...`)

    const reservesMap = await this.batchGetReserves(
      entries.map((e) => e.address),
    )

    let loaded = 0
    for (const entry of entries) {
      const reserves = reservesMap.get(entry.address.toLowerCase())
      const [reserve0, reserve1] = reserves ?? [0n, 0n]
      this.addPool(
        entry.address,
        entry.token0,
        entry.token1,
        reserve0,
        reserve1,
        entry.factory,
        false,
      )
      ++loaded
    }

    this.consoleLog(`Loaded ${loaded} pools from cache`)
  }

  // ---- Event-driven pool discovery ----

  async addPoolByLog(
    addr: Address,
    reserve0: bigint,
    reserve1: bigint,
  ): Promise<void> {
    const addrL = addr.toLowerCase()
    if (this.poolMap.has(addrL) || this.pendingLogDiscovery.has(addrL)) return
    this.pendingLogDiscovery.add(addrL)

    try {
      const results = await repeat(2, () =>
        this.client.multicall({
          contracts: [
            { address: addr, abi: uniswapV2PairAbi, functionName: 'factory' },
            { address: addr, abi: uniswapV2PairAbi, functionName: 'token0' },
            { address: addr, abi: uniswapV2PairAbi, functionName: 'token1' },
          ],
          allowFailure: true,
        }),
      )
      const [factoryR, token0R, token1R] = results

      if (
        factoryR.status === 'failure' ||
        token0R.status === 'failure' ||
        token1R.status === 'failure'
      ) {
        this.pendingLogDiscovery.delete(addrL)
        return
      }

      const factory = this.factoryMap.get(
        (factoryR.result as string).toLowerCase(),
      )
      if (!factory) {
        this.pendingLogDiscovery.delete(addrL)
        return
      }

      const [token0, token1] = await Promise.all([
        this.tokenManager.findToken(token0R.result as Address),
        this.tokenManager.findToken(token1R.result as Address),
      ])

      if (!token0 || !token1) {
        this.pendingLogDiscovery.delete(addrL)
        return
      }

      if (!this.poolMap.has(addrL)) {
        this.addPool(addr, token0, token1, reserve0, reserve1, factory, true)
        this.poolPermanentCache.add({
          address: addr,
          token0: token0R.result as Address,
          token1: token1R.result as Address,
          factory: factory.address,
        })
      }
    } catch (e) {
      logger.extractorError(`Ext2 add pool ${addr} by log failed`, e)
    }
    this.pendingLogDiscovery.delete(addrL)
  }

  // ---- Getters ----

  getPools(): PoolState[] {
    return Array.from(this.poolMap.values())
  }

  getPoolMap(): Map<string, PoolState> {
    return this.poolMap
  }

  consoleLog(log: string) {
    logger.extractorInfo(`V2 ${log}`)
  }

  isStarted() {
    return this.started
  }
  isSyncing() {
    return this.syncing
  }
}
