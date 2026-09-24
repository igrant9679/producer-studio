// Editor assistant orchestration (provider-agnostic): prompt + tool specs + tool execution against the posted
// project. The provider (Anthropic API now, Claude Code CLI on desktop later) owns the model loop.
import * as z from 'zod/v4'
import type { AssistantRequest, AssistantResult } from '@producer/core'
import { HttpError } from '../http'
import type { ClaudeProvider, ToolSpec } from './provider'
import { TOOL_SCHEMAS, ToolError, type ToolEnv, type ToolState, runTool } from './tools'

export const MAX_ITERATIONS = 12

export const ASSISTANT_SYSTEM = `You are the editing assistant inside Producer Studio, a browser video editor. You change the user's edit by calling tools; the server applies them to the project and returns the new document.

How the project works:
- Times are seconds (floats). Item start/end are TIMELINE times. Video/audio items also have "in" (seconds into the source asset) and "speed".
- Canvas coordinates are pixels relative to the canvas CENTRE: x grows right, y grows down. A 1920×1080 canvas spans x −960..960, y −540..540.
- Tracks are listed bottom to top (later tracks draw on top). The main track (main: true) is magnetic: its items are always packed edge to edge from 0, so trimming or deleting there ripples everything after it.
- Caption tracks hold caption items generated from speech; their look is set with set_caption_style.
- "Here" / "now" means the playhead; "this" / "it" means the selected item(s) unless the user says otherwise.

How to work:
- Call get_timeline first unless the summary you already have is enough. Use real ids from it; never invent ids.
- Prefer small, precise edits that do exactly what was asked. Do not restyle, move or delete things the user didn't mention.
- For transcript-based cuts, call get_transcript and cut the exact word times.
- If a request is ambiguous or impossible with the tools, ask a short question instead of guessing.
- When you are done, reply in one to three short sentences saying what you changed (or why you changed nothing). No markdown headings.`

/** Tools as plain data (name, description, JSON Schema) — the same list a CLI provider can serve over MCP. */
export function toolSpecs(): ToolSpec[] {
  return Object.entries(TOOL_SCHEMAS).map(([name, schema]) => {
    const json = z.toJSONSchema(schema as z.ZodType, { target: 'draft-7' }) as Record<string, unknown>
    delete json.$schema
    delete json.description
    return { name, description: (schema as z.ZodType).description ?? name, inputSchema: { type: 'object', ...json } }
  })
}

export interface AssistantEvents {
  text(delta: string): void
  tool(name: string, summary: string): void
}

export async function runAssistant(provider: ClaudeProvider, req: AssistantRequest, env: ToolEnv, ev: AssistantEvents, signal?: AbortSignal): Promise<AssistantResult> {
  const state: ToolState = { project: req.project, playhead: req.playhead ?? 0, selection: req.selection ?? [], changes: [] }
  const history = req.messages.filter((m) => m.text.trim()).map((m) => ({ role: m.role, text: m.text }))
  if (!history.length || history[history.length - 1].role !== 'user') throw new HttpError(400, 'invalid', 'The last message must be from the user')
  const last = history[history.length - 1]
  last.text = `${last.text}\n\n[Editor context: playhead ${state.playhead.toFixed(2)}s; selected item ids: ${state.selection.length ? state.selection.join(', ') : 'none'}]`
  const { text } = await provider.runAgent({
    system: ASSISTANT_SYSTEM,
    messages: history,
    tools: toolSpecs(),
    maxIterations: MAX_ITERATIONS,
    onText: ev.text,
    signal,
    runTool: async (name, input) => {
      try {
        const r = await runTool(state, name, input, env)
        ev.tool(name, r.summary)
        return { content: r.result, isError: false }
      } catch (err) {
        if (err instanceof ToolError) {
          ev.tool(name, `Could not ${name.replace(/_/g, ' ')}: ${err.message}`)
          return { content: err.message, isError: true }
        }
        throw err
      }
    },
  })
  return { text: text.trim() || (state.changes.length ? state.changes.join('. ') : 'No changes.'), project: state.changes.length ? state.project : undefined, changes: state.changes }
}
