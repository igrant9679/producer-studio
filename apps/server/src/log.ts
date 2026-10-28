// Structured JSON-lines logger (one object per line on stdout/stderr). A line written while a request or a job is
// being handled carries its id (`reqId`, `jobId`): see `withLogContext` (request-id.ts, the worker).
import { AsyncLocalStorage } from 'node:async_hooks'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20
const pretty = process.env.LOG_PRETTY === '1'

export interface LogContext {
  reqId?: string
  jobId?: string
}

const context = new AsyncLocalStorage<LogContext>()

/** Run `fn` with these ids on every log line it (and whatever it awaits) writes. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return context.run({ ...context.getStore(), ...ctx }, fn)
}

/** The ids of the request or job being handled now, if any. */
export function logContext(): LogContext | undefined {
  return context.getStore()
}

/** Tests: the lines written, instead of stdout/stderr. */
let sink: ((rec: Record<string, unknown>) => void) | undefined
export function captureLogs(fn: ((rec: Record<string, unknown>) => void) | undefined) {
  sink = fn
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (!sink && (ORDER[level] < min || process.env.LOG_SILENT === '1')) return
  const rec: Record<string, unknown> = { t: new Date().toISOString(), level, msg, ...context.getStore(), ...fields }
  if (fields?.err instanceof Error) rec.err = { message: fields.err.message, stack: fields.err.stack }
  if (sink) return sink(rec)
  const line = pretty ? `${rec.t} ${level.toUpperCase()} ${msg} ${JSON.stringify({ ...context.getStore(), ...fields, err: rec.err })}` : JSON.stringify(rec)
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
}
