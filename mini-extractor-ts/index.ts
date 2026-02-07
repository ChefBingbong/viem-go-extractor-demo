import { initApi } from './api.js'
import { PORT } from './config.js'
import { logger } from './lib/logger.js'

const app = await initApi()

app.listen(PORT)
logger.info(`Mini Extractor API started on port ${PORT}`)

process.on('SIGTERM', (code) => {
  logger.info(`About to exit with code: ${code}`)
})
