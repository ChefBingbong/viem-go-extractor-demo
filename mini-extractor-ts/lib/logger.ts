import pino from 'pino'

const pinoLogger = pino({
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
})

export const logger = {
  info: (...args: unknown[]) =>
    pinoLogger.info(args.length === 1 ? args[0] : args),
  error: (...args: unknown[]) =>
    pinoLogger.error(args.length === 1 ? args[0] : args),
  warning: (...args: unknown[]) =>
    pinoLogger.warn(args.length === 1 ? args[0] : args),
  warn: (...args: unknown[]) =>
    pinoLogger.warn(args.length === 1 ? args[0] : args),
  debug: (...args: unknown[]) =>
    pinoLogger.debug(args.length === 1 ? args[0] : args),
  extractorInfo: (...args: unknown[]) =>
    pinoLogger.info(args.length === 1 ? args[0] : args),
  extractorError: (...args: unknown[]) =>
    pinoLogger.error(args.length === 1 ? args[0] : args),
  extractorWarning: (...args: unknown[]) =>
    pinoLogger.warn(args.length === 1 ? args[0] : args),
}
