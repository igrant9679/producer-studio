// Structured JSON-lines logger (one object per line on stdout/stderr).
type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20
const pretty = process.env.LOG_PRETTY === '1'

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < min || process.env.LOG_SILENT === '1') return
  const rec: Record<string, unknown> = { t: new Date().toISOString(), level, msg, ...fields }
  if (fields?.err instanceof Error) rec.err = { message: fields.err.message, stack: fields.err.stack }
  const line = pretty ? `${rec.t} ${level.toUpperCase()} ${msg} ${fields ? JSON.stringify({ ...fields, err: rec.err }) : ''}` : JSON.stringify(rec)
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
}
