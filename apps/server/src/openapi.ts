// The API as an OpenAPI 3.1 document (P-24), served at GET /api/openapi.json. Every route the app has is listed (from
// Hono's own route table); a route's request body schema comes from the zod schema its handler passes to body(): the
// route files are read, each handler's `body(c, <schema>)` found, and that schema expression evaluated with `z`, the
// file's own top-level consts and its imports in scope, then turned into JSON Schema by zod. A route whose schema
// can't be worked out this way (built at run time, or no body) is listed with its path and method only, and says why
// in `x-request-schema`. Responses aren't described: their shapes are the types in packages/core/src/api.ts.
// Built once per process on first request (it reads source, which ships with the server: it runs through tsx).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as z from 'zod/v4'
import { ctx } from './context'
import { log } from './log'

/** What the document is built from: Hono's route table (app.routes). */
export interface RouteTable {
  routes: ReadonlyArray<{ method: string; path: string }>
}

const SRC = path.dirname(fileURLToPath(import.meta.url))
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/** From `start` (an opening bracket), the index just past its matching close; strings and comments are skipped. */
function matchClose(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i)
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) return src.length
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return src.length
}

function skipString(src: string, i: number): number {
  const q = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (q === '`' && src[j] === '$' && src[j + 1] === '{') j = matchClose(src, j + 1) - 1
    else if (src[j] === q) return j
  }
  return src.length
}

/** The text of a top-level `const NAME = …` initializer: up to the first line break outside brackets that ends it. */
function initializer(src: string, from: number): string {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === '\n' && depth === 0) {
      const rest = src.slice(i + 1).trimStart()
      if (!/^[.?:|&+]/.test(rest)) return src.slice(from, i).trim().replace(/;$/, '')
    }
  }
  return src.slice(from).trim()
}

interface SourceFile {
  file: string
  src: string
  consts: Map<string, string>
  imports: Map<string, { from: string; name: string }>
}

const files = new Map<string, SourceFile>()

function readSource(file: string): SourceFile {
  const hit = files.get(file)
  if (hit) return hit
  const src = fs.readFileSync(file, 'utf8')
  const consts = new Map<string, string>()
  for (const m of src.matchAll(/^(?:export )?const ([A-Za-z_$][\w$]*)(?::[^=\n]+)? = /gm)) consts.set(m[1], initializer(src, m.index! + m[0].length))
  const imports = new Map<string, { from: string; name: string }>()
  for (const m of src.matchAll(/^import (?:type )?\{([^}]+)\} from '([^']+)'/gm))
    for (const part of m[1].split(',')) {
      const [name, alias] = part.replace(/\btype\b/, '').trim().split(/\s+as\s+/)
      if (name) imports.set((alias ?? name).trim(), { from: m[2], name: name.trim() })
    }
  const sf = { file, src, consts, imports }
  files.set(file, sf)
  return sf
}

type Transpile = (code: string) => string
let transpiler: Promise<Transpile | null> | undefined

/** TypeScript → JavaScript for one expression (casts such as `as [string, ...string[]]` go). */
function getTranspiler(): Promise<Transpile | null> {
  transpiler ??= import('typescript')
    .then((mod) => {
      const ts = ((mod as { default?: typeof import('typescript') }).default ?? mod) as typeof import('typescript')
      return (code: string) => ts.transpileModule(`(${code})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, '')
    })
    .catch(() => null)
  return transpiler
}

const IDENT = /(?<![\w$.'"`])([A-Za-z_$][\w$]*)(?![\w$])/g
const IGNORE = new Set(['z', 'true', 'false', 'null', 'undefined', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Math', 'Date', 'JSON', 'Infinity', 'as', 'const', 'string', 'number', 'boolean', 'unknown', 'typeof', 'keyof', 'new', 'RegExp'])

/** Evaluate an expression from `sf` with z, the file's consts and its imports in scope; undefined when that fails. */
async function evaluate(sf: SourceFile, expr: string, transpile: Transpile, seen = new Set<string>()): Promise<unknown> {
  const scope: Record<string, unknown> = { z }
  const names = new Set([...expr.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').matchAll(IDENT)].map((m) => m[1]).filter((n) => !IGNORE.has(n)))
  // a name that can't be had (an object key that happens to match, a value made at run time) is left out: if the
  // expression needs it, evaluating it fails below and the route is listed without a schema
  for (const name of names) {
    const key = `${sf.file}#${name}`
    if (seen.has(key)) continue
    if (sf.consts.has(name)) {
      const v = await evaluate(sf, sf.consts.get(name)!, transpile, new Set([...seen, key]))
      if (v !== undefined) scope[name] = v
    } else if (sf.imports.has(name)) {
      const imp = sf.imports.get(name)!
      if (imp.from === 'zod/v4') continue
      try {
        const mod = imp.from.startsWith('.') ? await import(pathToFileURL(path.resolve(path.dirname(sf.file), `${imp.from}.ts`)).href) : await import(imp.from)
        if (imp.name in mod) scope[name] = (mod as Record<string, unknown>)[imp.name]
      } catch {
        /* left out */
      }
    }
  }
  try {
    const keys = Object.keys(scope)
    return new Function(...keys, `return ${transpile(expr)}`)(...keys.map((k) => scope[k]))
  } catch {
    return undefined
  }
}

interface FoundRoute {
  method: string
  /** As written on its router (`/:id/brand`). */
  path: string
  router: string
  file: string
  /** The body(c, …) argument, if the handler reads one. */
  schema?: string
}

/** Every `<router>.<method>('<path>', …)` in a route file, with the schema its handler passes to body(). */
function routesIn(file: string): FoundRoute[] {
  const { src } = readSource(file)
  const defs = [...src.matchAll(new RegExp(String.raw`^[ 	]*([A-Za-z_$][\w$]*)\.(${METHODS.join('|')})\('([^']*)'`, 'gm'))]
  return defs.map((m, i) => {
    const end = i + 1 < defs.length ? defs[i + 1].index! : src.length
    const seg = src.slice(m.index!, end)
    const call = seg.search(/\bbody\(c, /)
    let schema: string | undefined
    if (call >= 0) {
      const open = m.index! + call + 'body'.length
      schema = src.slice(open + 1, matchClose(src, open) - 1).replace(/^c,\s*/, '').trim()
    }
    return { method: m[2].toUpperCase(), path: m[3], router: m[1], file, schema }
  })
}

/** Where each router is mounted, from app.ts (and the desktop's own sub-router). */
function mounts(routeFiles: string[], desktop: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (router: string, prefix: string) => out.set(router, [...(out.get(router) ?? []), prefix])
  const app = readSource(path.join(SRC, 'app.ts')).src
  for (const m of app.matchAll(/app\.route\('([^']+)', ([A-Za-z_$][\w$]*)\)/g)) add(m[2], m[1])
  // a router made by a function (`app.route('/api/health', healthRoutes())`): the router variable inside it
  for (const m of app.matchAll(/app\.route\('([^']+)', ([A-Za-z_$][\w$]*)\(\)\)/g))
    for (const f of routeFiles) {
      const inner = readSource(f).src.match(new RegExp(String.raw`function ${m[2]}\(\)[^{]*\{\s*const ([A-Za-z_$][\w$]*) = new Hono`))
      if (inner) add(inner[1], m[1])
    }
  add('app', '')
  if (desktop) {
    const desk = path.join(SRC, 'desktop', 'index.ts')
    if (fs.existsSync(desk)) for (const m of readSource(desk).src.matchAll(/desktopRoutes\.route\('([^']+)', ([A-Za-z_$][\w$]*)\)/g)) add(m[2], `/api${m[1]}`)
    add('desktopRoutes', '/api')
  }
  return out
}

const join = (prefix: string, p: string) => (`${prefix}${p === '/' ? '' : p}` || '/').replace(/\/+$/, '') || '/'
const openApiPath = (p: string) => p.replace(/:([A-Za-z_]\w*)(\{[^}]*\})?/g, '{$1}')

export interface OpenApiDoc {
  openapi: string
  info: Record<string, unknown>
  paths: Record<string, Record<string, Record<string, unknown>>>
  components: Record<string, unknown>
}

/** Build the document for this app's routes. */
export async function buildOpenApi(app: RouteTable): Promise<OpenApiDoc> {
  const transpile = await getTranspiler()
  // the desktop's routes exist (and shadow some cloud ones) only in the desktop app
  const desktop = ctx().config.mode === 'desktop'
  const dirs = [path.join(SRC, 'routes'), ...(desktop ? [path.join(SRC, 'desktop'), path.join(SRC, 'desktop', 'voicestudio')] : [])]
  const routeFiles = [path.join(SRC, 'app.ts'), ...dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => path.join(d, f)) : []))]
  const where = mounts(routeFiles, desktop)
  const found = new Map<string, FoundRoute>()
  for (const f of routeFiles) for (const r of routesIn(f)) for (const prefix of where.get(r.router) ?? []) found.set(`${r.method} ${join(prefix, r.path)}`, r)

  const paths: OpenApiDoc['paths'] = {}
  const seen = new Set<string>()
  let described = 0
  for (const r of app.routes) {
    const method = r.method.toUpperCase()
    if (!(METHODS as readonly string[]).includes(method.toLowerCase()) || !r.path.startsWith('/api/') || r.path.includes('*')) continue
    const key = `${method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    const src = found.get(key)
    const op: Record<string, unknown> = {
      operationId: `${method.toLowerCase()}${r.path.replace(/^\/api/, '').replace(/[/:{}-]+(\w)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))}`,
      tags: [r.path.split('/')[2] ?? 'api'],
      parameters: [...r.path.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      responses: { default: { description: 'JSON (shapes: packages/core/src/api.ts); errors are ApiError { error, code, details?, requestId }' } },
    }
    if (!src) op['x-request-schema'] = 'not found in the route files'
    else if (!src.schema) op['x-request-schema'] = 'none (no JSON body read through body())'
    else {
      const schema = transpile ? await evaluate(readSource(src.file), src.schema, transpile) : undefined
      let json: unknown
      if (schema instanceof z.ZodType) {
        try {
          json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' })
        } catch {
          json = undefined
        }
      }
      if (json) {
        op.requestBody = { required: true, content: { 'application/json': { schema: json } } }
        described++
      } else op['x-request-schema'] = `built at run time: ${src.schema.slice(0, 120)}`
    }
    const p = openApiPath(r.path)
    paths[p] = { ...(paths[p] ?? {}), [method.toLowerCase()]: op }
  }
  log.debug('openapi built', { routes: seen.size, described })
  return {
    openapi: '3.1.0',
    info: {
      title: 'Producer Studio API',
      version: ctx().config.version,
      description: 'Generated from the server’s routes and their zod request schemas (apps/server/src/openapi.ts). Signed-in calls use the ps_session cookie; a linked desktop app sends its device token as a bearer token and may call only the sync routes.',
    },
    paths,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'ps_session' },
        deviceToken: { type: 'http', scheme: 'bearer', description: 'A desktop app link (POST /api/devices).' },
      },
    },
  }
}

let cached: Promise<OpenApiDoc> | undefined

/** The document for `app`, built on first use. */
export function openApiFor(app: RouteTable): Promise<OpenApiDoc> {
  cached ??= buildOpenApi(app).catch((err) => {
    cached = undefined
    throw err
  })
  return cached
}
