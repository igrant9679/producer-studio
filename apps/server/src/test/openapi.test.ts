// P-24: GET /api/openapi.json describes every route, with the request body schemas generated from the routes' own zod
// schemas, and lists the routes it can't describe with their path and method.
import { beforeAll, describe, expect, it } from 'vitest'
import type { OpenApiDoc } from '../openapi'
import { setup, type TestEnv } from './helpers'

let t: TestEnv
let doc: OpenApiDoc
beforeAll(async () => {
  t = await setup()
  const r = await t.app.request('/api/openapi.json')
  expect(r.status).toBe(200)
  doc = await r.json()
}, 180_000)

const op = (method: string, p: string) => doc.paths[p]?.[method] as { requestBody?: { content: { 'application/json': { schema: any } } }; parameters: Array<{ name: string; in: string }>; 'x-request-schema'?: string } | undefined
const body = (method: string, p: string) => op(method, p)?.requestBody?.content['application/json'].schema

describe('the OpenAPI document (P-24)', () => {
  it('is OpenAPI 3.1 and lists every API route the app has, in OpenAPI path form', () => {
    expect(doc.openapi).toBe('3.1.0')
    const listed = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)))
    const routes = t.app.routes.filter((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path.startsWith('/api/') && !r.path.includes('*'))
    const missing = routes.filter((r) => !listed.has(`${r.method} ${r.path.replace(/:(\w+)(\{[^}]*\})?/g, '{$1}')}`)).map((r) => `${r.method} ${r.path}`)
    expect(missing).toEqual([])
    expect(op('get', '/api/projects/{id}')!.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }])
  })

  it('takes request bodies from the zod schemas: inline ones, file consts and imported ones', () => {
    // inline in the handler
    expect(body('post', '/api/auth/signup')).toMatchObject({ type: 'object', properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 }, name: { type: 'string' } }, required: expect.arrayContaining(['email', 'password', 'name']) })
    // a const of the same file (NotifyPatch)
    expect(body('put', '/api/account/notifications')).toMatchObject({ type: 'object', properties: { browser: { type: 'boolean' }, emailJobs: { type: 'boolean' } } })
    // imported from another route file (BrandSchema), with a const of that file inside it
    expect(body('put', '/api/workspaces/{id}/brand').properties.colors).toMatchObject({ type: 'array', maxItems: 12 })
    // a TypeScript cast inside the schema (AVATAR_COLORS as [string, ...string[]])
    expect(body('patch', '/api/account').properties.avatarColor.enum.length).toBeGreaterThan(3)
    // R4-A's own routes
    expect(body('post', '/api/operator/users/{id}/reset')).toMatchObject({ properties: { mode: { enum: ['mail', 'link'] } } })
    const described = Object.values(doc.paths).flatMap((ops) => Object.values(ops)).filter((o) => o.requestBody).length
    expect(described).toBeGreaterThanOrEqual(50)
  })

  it('lists a route without a schema with its path and method, and says why', () => {
    expect(op('get', '/api/health')).toBeDefined()
    expect(op('get', '/api/health')!['x-request-schema']).toMatch(/^none/)
    // a schema chosen at run time (the smart tools pick one per tool)
    const smart = Object.entries(doc.paths).find(([p]) => p.startsWith('/api/assets/{id}/smart'))
    if (smart) expect(Object.values(smart[1])[0]['x-request-schema']).toMatch(/built at run time|^none/)
  })
})
