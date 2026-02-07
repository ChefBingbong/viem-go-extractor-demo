import { Elysia } from 'elysia'
import { extractor } from '../extractor-instance.js'

// Supports optional ?limit=N query param to cap the number of pools returned.
export const extractorInsights = new Elysia().get(
  '/extractor-insights',
  ({ query }) => {
    let pools = extractor.getPools()

    // Apply optional limit
    const limit = query.limit ? Number(query.limit) : undefined
    if (limit !== undefined && limit >= 0 && limit < pools.length) {
      pools = pools.slice(0, limit)
    }

    const blockNumber = extractor.logFilter.lastProcessedBlock
    return {
      blockNumber,
      totalPools: pools.length,
      syncing: extractor.isSyncing(),
      pools,
    }
  },
)
