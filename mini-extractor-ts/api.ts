import { Elysia } from 'elysia'
import { extractor } from './extractor-instance.js'
import { extractorInsights } from './handlers/extractor-insights.js'
import { logger } from './lib/logger.js'

declare global {
  interface BigInt {
    toJSON(): string
  }
}
BigInt.prototype.toJSON = function () {
  return this.toString()
}

export const initApi = async () => {
  extractor.start().catch((err: Error) => {
    logger.error('Failed to start extractor', err)
    return process.exit(1)
  })

  return new Elysia()
    .get('/health', () => {
      const started = extractor.isStarted()
      if (!started) {
        return new Response('not ready', { status: 503 })
      }
      return {
        status: 'ok',
        pools: extractor.getPools().length,
        syncing: extractor.isSyncing(),
      }
    })
    .use(extractorInsights)
}
