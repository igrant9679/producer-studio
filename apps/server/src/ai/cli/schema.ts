// zod → JSON Schema (draft-7) for `--json-schema` and MCP tool inputSchemas; same conversion as the API provider.
import * as z from 'zod/v4'

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete json.$schema
  return json
}

/** Pull the first JSON object out of free text (fallback when a CLI build doesn't return structured_output). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const src = fenced ? fenced[1] : text
  const a = src.indexOf('{')
  const b = src.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  try {
    return JSON.parse(src.slice(a, b + 1))
  } catch {
    return undefined
  }
}
