import type { AbiEvent, Address } from 'abitype'
import {
  type Block,
  encodeEventTopics,
  type Filter,
  type Log,
  type PublicClient,
  type WatchBlocksReturnType,
} from 'viem'
import { logger } from '../lib/logger.js'
import type { BlockEmitter } from './Extractor.js'
import { repeatAsync } from './Utils.js'

export enum LogFilterType {
  Native = 0, // getFilterChanges - is not supported widely
  OneCall = 1, // one eth_getLogs call for all topics - the most preferrable
  MultiCall = 2, // separate eth_getLogs call for each topic
  SelfFilter = 3, // Topic filtering doesn't support for provider. Filtering on the client
}

class BlockFrame {
  firstNumber?: number
  lastNumber?: number
  hashNumerMap: Map<number, string[]> = new Map()

  // return deleted block hashes
  setFrame(from: number, to: number): string[] {
    let deletedHashes: string[] = []
    if (this.firstNumber !== undefined && this.lastNumber !== undefined) {
      for (let i = this.firstNumber; i < from; ++i) {
        const hashes = this.hashNumerMap.get(i)
        if (hashes !== undefined) {
          deletedHashes = deletedHashes.concat(hashes)
          this.hashNumerMap.delete(i)
        }
      }
      for (let i = to; i < this.lastNumber; ++i) {
        const hashes = this.hashNumerMap.get(i)
        if (hashes !== undefined) {
          deletedHashes = deletedHashes.concat(hashes)
          this.hashNumerMap.delete(i)
        }
      }
    }
    this.firstNumber = from
    this.lastNumber = to
    return deletedHashes
  }

  add(blockNumber: number, blockHash: string): boolean {
    if (this.firstNumber === undefined || this.lastNumber === undefined)
      return false
    if (blockNumber < this.firstNumber) return false
    if (blockNumber >= this.lastNumber) return false
    const hashes = this.hashNumerMap.get(blockNumber)
    if (hashes) hashes.push(blockHash)
    else this.hashNumerMap.set(blockNumber, [blockHash])
    return true
  }

  deleteFrame() {
    this.firstNumber = undefined
    this.lastNumber = undefined
  }
}

interface FilterMy {
  topics: string[]
  onNewLogs: (arg?: Log[]) => void
}

class BlockParams {
  hash: Address | null
  number: number | null
  parentHash: Address
  timestamp: number

  constructor(block: Block) {
    this.hash = block.hash
    this.number = block.number === null ? null : Number(block.number)
    this.parentHash = block.parentHash
    this.timestamp = Number(block.timestamp)
  }
}

export class LogFilter2 {
  readonly client: PublicClient
  readonly depth: number
  readonly logType: LogFilterType
  eventsAll: AbiEvent[] = []
  topicsAll: string[] = []
  filters: FilterMy[] = []
  blockProcessing = false
  filter: Filter | undefined
  readonly blockEmitter: BlockEmitter
  debug: boolean

  unWatchBlocks?: WatchBlocksReturnType

  lastProcessedBlock?: BlockParams
  processedBlockHash: Set<string> = new Set()
  nextGoalBlock?: BlockParams

  blockHashMap: Map<string, BlockParams> = new Map()
  logHashMap: Map<string, Log[]> = new Map()
  blockFrame: BlockFrame = new BlockFrame()

  constructor(
    client: PublicClient,
    depth: number,
    logType: LogFilterType,
    blockEmitter: BlockEmitter,
    debug = false,
  ) {
    this.client = client
    this.depth = depth
    this.logType = logType
    this.blockEmitter = blockEmitter
    this.debug = debug === true
  }

  addFilter(events: AbiEvent[], onNewLogs: (arg?: Log[]) => void) {
    this.eventsAll = this.eventsAll.concat(events)
    const topics = events.map((e) => encodeEventTopics({ abi: [e] })[0])
    this.topicsAll = this.topicsAll.concat(topics)
    this.filters.push({ topics, onNewLogs })
  }

  start() {
    if (this.unWatchBlocks) return
    if (this.logType === LogFilterType.Native) {
      this.client.createEventFilter({ events: this.eventsAll }).then(
        (filtr) => {
          this.consoleLog(`LogFilter ${filtr.id} was created`)
          this.filter = filtr as unknown as Filter
          this.unWatchBlocks = this.client.watchBlockNumber({
            onBlockNumber: async () => {
              if (this.filter === undefined) return
              if (this.blockProcessing) return
              this.blockProcessing = true
              try {
                const logs = await this.client.getFilterChanges({
                  filter: this.filter,
                })
                this.filters.forEach((f) => {
                  const logsFiltered = logs.filter((l) =>
                    f.topics.includes(l.topics[0] ?? ''),
                  )
                  if (logsFiltered.length > 0) f.onNewLogs(logsFiltered)
                })
              } catch (e) {
                logger.extractorError(`LogFilter ${this.filter.id} error`, e)
                this.restart()
              }
              this.blockProcessing = false
            },
          })
        },
        (e) => {
          logger.extractorError(`LogFilter creation error`, e)
          this.start()
        },
      )
    } else {
      this.unWatchBlocks = this.client.watchBlockNumber({
        onBlockNumber: async (blockNumber) => {
          try {
            const block = await this.client.getBlock({ blockNumber })

            this.addBlock(block, true).then(() => {
              this.blockEmitter.emit('new-block', Number(block.number))
            })
          } catch (e) {}
        },
        onError: (e) => {
          logger.extractorError('watchBlocks error', e)
          this.restart()
        },
      })
    }
  }

  stop(signalStopping = true) {
    if (!this.unWatchBlocks) return
    this.unWatchBlocks()
    this.unWatchBlocks = undefined
    this.lastProcessedBlock = undefined
    this.processedBlockHash = new Set()
    this.nextGoalBlock = undefined
    this.blockHashMap = new Map()
    this.logHashMap = new Map()
    this.blockFrame.deleteFrame()
    this.filter = undefined
    if (signalStopping)
      this.filters.forEach((f) => {
        f.onNewLogs()
      })
  }

  restart(signalStopping = true) {
    this.stop(signalStopping)
    this.start()
  }

  setNewGoal(block: BlockParams): boolean {
    const blockNumber = block.number as number
    const deletedHashes = this.blockFrame.setFrame(
      blockNumber - this.depth,
      blockNumber + this.depth,
    )
    const initProcessedBlocksNumber = this.processedBlockHash.size
    deletedHashes.forEach((hash) => {
      this.blockHashMap.delete(hash)
      this.logHashMap.set(hash, undefined as unknown as Log[])
      this.logHashMap.delete(hash)
      this.processedBlockHash.delete(hash)
    })
    if (initProcessedBlocksNumber > 0 && this.processedBlockHash.size === 0) {
      this.restart()
      return false
    }
    this.nextGoalBlock = block
    return true
  }

  sortAndProcessLogs(blockHash: string | null, logs: Log[]) {
    const logsSorted = logs.sort(
      (a, b) => Number(a.logIndex || 0) - Number(b.logIndex || 0),
    )
    this.logHashMap.set(blockHash || '', logsSorted)
    this.processNewLogs()
  }

  async addBlock(_block: Block, isGoal: boolean): Promise<void> {
    const start = performance.now()
    const block = new BlockParams(_block)

    if (block.number === null || block.hash === null) {
      logger.extractorError(
        `Incorrect block: number=${block.number} hash=${block.hash}`,
      )
      return
    }
    if (isGoal) if (!this.setNewGoal(block)) return
    if (this.blockHashMap.has(block.hash)) return
    if (!this.blockFrame.add(block.number, block.hash)) return
    this.blockHashMap.set(block.hash, block)

    const backupPlan = (context?: unknown) => {
      logger.warning(`getLog failed for block ${block.hash}`, context)
      this.restart()
    }

    let promiseGetLogs: Promise<void> | undefined
    let promiseSyncUp: Promise<void> | undefined

    switch (this.logType) {
      case LogFilterType.OneCall:
        promiseGetLogs = repeatAsync(
          10,
          1000,
          async () => {
            try {
              const logs = await this.client.transport.request({
                method: 'eth_getLogs',
                params: [{ blockHash: block.hash, topics: [this.topicsAll] }],
              })
              this.sortAndProcessLogs(block.hash, logs as Log[])
              logger.info(
                `Processed block [${block.number}] (${Math.round(performance.now() - start)}ms)`,
              )
            } catch (e) {
              if (this.debug)
                logger.info('logs transport report fetch issues', e)
              throw e
            }
          },
          backupPlan,
        )
        break
      case LogFilterType.MultiCall:
        promiseGetLogs = Promise.all(
          this.eventsAll.map((event) =>
            this.client.getLogs({
              blockHash: block.hash as `0x${string}`,
              event,
            }),
          ),
        ).then(
          (logss) => this.sortAndProcessLogs(block.hash, logss.flat()),
          backupPlan,
        )
        break
      case LogFilterType.SelfFilter:
        promiseGetLogs = this.client
          .getLogs({ blockHash: block.hash as `0x${string}` })
          .then(
            (logs) =>
              this.sortAndProcessLogs(
                block.hash,
                logs.filter((l) => this.topicsAll.includes(l.topics[0] ?? '')),
              ),
            backupPlan,
          )
        break
      default:
        logger.extractorError(
          `Internal errror: Unknown Log Type: ${this.logType}`,
        )
    }
    if (this.lastProcessedBlock && !this.blockHashMap.has(block.parentHash))
      promiseSyncUp = repeatAsync(
        10,
        1000,
        async () => {
          logger.info('Adding blocks backwards', block.number, block.parentHash)
          return this.client
            .getBlock({ blockHash: block.parentHash })
            .then((b) => this.addBlock(b, false))
        },
        (e) =>
          logger.extractorError('getBlock failed !!!!!!!!!!!!!!!!!!!!!!', e),
      )

    await Promise.all([promiseGetLogs, promiseSyncUp])
  }

  processNewLogs() {
    if (!this.unWatchBlocks) return
    const upLine: BlockParams[] = []
    let cornerBlock: BlockParams | undefined = this.nextGoalBlock
    for (;;) {
      if (cornerBlock === undefined)
        if (this.lastProcessedBlock) return
        else break
      if (this.processedBlockHash.has(cornerBlock.hash || '')) break
      upLine.push(cornerBlock)
      cornerBlock = this.blockHashMap.get(cornerBlock.parentHash)
    }

    const downLine: BlockParams[] = []
    if (cornerBlock) {
      let b: BlockParams | undefined = this.lastProcessedBlock
      for (;;) {
        if (b === undefined) return
        if (b.hash === cornerBlock.hash) break
        downLine.push(b)
        b = this.blockHashMap.get(b.parentHash)
      }
    }

    let logs: Log[] = []
    for (let i = 0; i < downLine.length; ++i) {
      const l = this.logHashMap.get(downLine[i].hash || '')
      if (l === undefined) {
        logger.extractorError('Unexpected Error in LogFilter')
        this.restart()
        return
      }
      logs = logs.concat(
        l.reverse().map((l) => {
          l.removed = true
          return l
        }),
      )
      this.processedBlockHash.delete(downLine[i].hash || '')
    }
    this.lastProcessedBlock = cornerBlock
    for (let i = upLine.length - 1; i >= 0; --i) {
      const l = this.logHashMap.get(upLine[i].hash || '')
      if (l === undefined) break
      logs = logs.concat(
        l.map((l) => {
          l.removed = false
          return l
        }),
      )
      this.processedBlockHash.add(upLine[i].hash || '')
      this.lastProcessedBlock = upLine[i]
    }

    this.filters.forEach((f) => {
      const logsFiltered = logs.filter((l) =>
        f.topics.includes(l.topics[0] ?? ''),
      )
      if (logsFiltered.length > 0) f.onNewLogs(logsFiltered)
    })
  }

  consoleLog(log: string) {
    logger.extractorInfo(`LogFilter-${this.client.chain?.id}: ${log}`)
  }

  getBlockTimestamp(blockHash: string): number | undefined {
    return this.blockHashMap.get(blockHash)?.timestamp
  }
}
