// Start-up check of the bundled tools (D-13): the local engine checks them (GET /api/tools/health); when one is broken
// the app says which, what it's for and what to do, once per launch, instead of failing later on the first export or
// transcription. Settings → This computer shows the full list. No Electron here, so it can be tested on its own.

export interface ToolReport {
  ok: boolean
  tools: Array<{ id: string; name: string; needed: string; status: 'ok' | 'warn' | 'error'; detail: string }>
}

/** The dialog for a report with broken tools, or null when nothing is broken (warnings only show in Settings). */
export function toolsWarning(r: ToolReport | undefined): { message: string; detail: string } | null {
  const broken = r?.tools.filter((t) => t.status === 'error') ?? []
  if (!broken.length) return null
  const lines = broken.map((t) => `• ${t.name} (for ${t.needed.charAt(0).toLowerCase()}${t.needed.slice(1)}): ${t.detail}`)
  return {
    message: broken.length === 1 ? `Part of Producer Studio isn’t working: ${broken[0].name}.` : `${broken.length} parts of Producer Studio aren’t working.`,
    detail: [...lines, '', 'Everything else works. Settings → This computer lists every tool and can check again.'].join('\n'),
  }
}

/** Ask the engine for its tool report (the local session's cookie); undefined when it can't answer. */
export async function fetchToolReport(origin: string, sessionToken: string, fetchImpl: typeof fetch = fetch): Promise<ToolReport | undefined> {
  try {
    const r = await fetchImpl(`${origin}/api/tools/health`, { headers: { cookie: `ps_session=${sessionToken}` }, signal: AbortSignal.timeout(30_000) })
    if (!r.ok) return undefined
    return (await r.json()) as ToolReport
  } catch {
    return undefined
  }
}
