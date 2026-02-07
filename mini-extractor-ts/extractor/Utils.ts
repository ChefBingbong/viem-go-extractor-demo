import fs from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../lib/logger.js'
import { SyncState } from './UniV2Types.js'

export const delay = async (ms: number) =>
  new Promise((res) => setTimeout(res, ms))

export async function repeatAsync<RetType>(
  times: number,
  delayBetween: number,
  action: () => Promise<RetType>,
  failed: (e?: unknown) => void,
  print?: string,
) {
  let lastException
  for (let i = 0; i < times; ++i) {
    try {
      const ret = await action()
      if (print && i > 0) logger.info(`attemps ${print}: ${i + 1}`)
      return ret
    } catch (e) {
      lastException = e
      if (delayBetween) await delay(delayBetween)
    }
  }
  failed(lastException)
}

export async function repeat<RetType>(
  times: number,
  action: () => Promise<RetType>,
): Promise<RetType> {
  for (let i = 0; i < times - 1; ++i) {
    try {
      return await action()
    } catch (_e) {
      // skip
    }
  }
  return await action()
}

export function readSyncState(filePath: string): SyncState {
  try {
    if (!fs.existsSync(filePath)) return {}
    const data = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(data) as SyncState
  } catch {
    return {}
  }
}

export async function writeSyncState(filePath: string, state: SyncState) {
  try {
    const dirName = path.dirname(filePath)
    await mkdir(dirName, { recursive: true })
    await writeFile(filePath, JSON.stringify(state, null, 2))
  } catch (e) {
    logger.error(`Failed to write sync state to ${filePath}`, e)
  }
}

export function writeSyncStateSync(filePath: string, state: SyncState) {
  try {
    const dirName = path.dirname(filePath)
    fs.mkdirSync(dirName, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2))
  } catch (e) {
    logger.error(`Failed to write sync state to ${filePath}`, e)
  }
}
