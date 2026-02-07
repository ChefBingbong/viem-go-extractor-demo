import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../lib/logger.js'

export class PermanentCache<CacheRecord> {
  filePath?: string
  /** In-memory set of serialized records to prevent duplicates */
  private knownEntries: Set<string> = new Set()

  constructor(...paths: string[]) {
    if (paths.length > 0 && paths[0] !== '') {
      const filePath = path.resolve(...paths)
      this.filePath = filePath
    }
  }

  async getAllRecords(): Promise<CacheRecord[]> {
    if (this.filePath === undefined) return []

    let records: CacheRecord[] = []
    try {
      const file = Bun.file(this.filePath)
      if (!(await file.exists())) {
        return []
      }
      const data = await file.text()
      const lines = data.split('\n').filter((r) => r !== '')
      records = lines.map((s) => JSON.parse(s) as CacheRecord)
      // Populate the known entries set from what's on disk
      for (const line of lines) {
        this.knownEntries.add(line)
      }
    } catch (_e) {
      throw new Error(
        `Cache ${this.filePath} in incorrect! Please fix it or remove file`,
      )
    }
    return records
  }

  async add(record: CacheRecord) {
    if (this.filePath === undefined) return
    const line = JSON.stringify(record)
    if (this.knownEntries.has(line)) return // already in cache
    this.knownEntries.add(line)
    try {
      const dirName = path.dirname(this.filePath)
      await mkdir(dirName, { recursive: true })
      await appendFile(this.filePath, `${line}\n`)
    } catch (_e) {
      logger.error('Error adding CacheRecord', _e)
    }
  }
}
