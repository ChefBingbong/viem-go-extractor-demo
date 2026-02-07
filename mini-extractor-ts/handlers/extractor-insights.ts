import { Elysia } from 'elysia'
import { extractor } from '../extractor-instance.js'

export const extractorInsights = new Elysia().get('/extractor-insights', () => {
  const pools = extractor.getPools()
  const blockNumber = extractor.logFilter.lastProcessedBlock
  return {
    blockNumber,
    totalPools: pools.length,
    syncing: extractor.isSyncing(),
    pools,
  }
})
