// Job kind -> handler wiring.
import { produceAssemble, produceScript } from '../ai/produce'
import { synthesizeToAsset, transcribeAsset } from '../ai/speech'
import { processAsset } from '../media/process'
import { assetRecord } from '../dto'
import { exportRender } from '../render/export'
import { registerHandler } from './worker'

let done = false

export function registerHandlers() {
  if (done) return
  done = true
  registerHandler('asset.process', async (jc) => {
    const { assetId } = jc.job.input as { assetId: string }
    const row = await processAsset(assetId, jc)
    return { asset: assetRecord(row) }
  })
  registerHandler('ai.transcribe', async (jc) => {
    const { assetId, language } = jc.job.input as { assetId: string; language?: string }
    const r = await transcribeAsset(assetId, language, jc)
    return { assetId, transcript: r.transcript }
  })
  registerHandler('ai.tts', async (jc) => {
    const i = jc.job.input as { workspaceId: string; projectId?: string; text: string; voice: string; speed?: number; name?: string }
    const r = await synthesizeToAsset({ ...i, userId: jc.job.userId }, jc)
    return { asset: r.asset, duration: r.duration }
  })
  registerHandler('ai.produce.script', produceScript)
  registerHandler('ai.produce.assemble', produceAssemble)
  registerHandler('export.render', exportRender)
}
