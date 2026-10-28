// Job kind -> handler wiring.
import { produceAssemble, produceScript } from '../ai/produce'
import { synthesizeToAsset, transcribeAsset } from '../ai/speech'
import { processAsset } from '../media/process'
import { detectScenes } from '../media/scenes'
import { removeBackground } from '../media/bgremove'
import { denoiseClip } from '../media/denoise'
import { stabiliseClip } from '../media/stabilise'
import { makeSmoothCopy } from '../media/smooth'
import { assetRecord } from '../dto'
import { exportRender } from '../render/export'
import { failAsset, reopenAsset } from '../services/asset-recovery'
import { limitMessage, registerHandler, stopReason } from './worker'

let done = false

export function registerHandlers() {
  if (done) return
  done = true
  registerHandler('asset.process', async (jc) => {
    const { assetId } = jc.job.input as { assetId: string }
    try {
      const row = await processAsset(assetId, jc)
      return { asset: assetRecord(row) }
    } catch (err) {
      // stopped for running too long: the clip says so, not "cancelled"
      const why = limitMessage(jc.signal)
      if (why) await failAsset(assetId, ['processing', 'error'], why).catch(() => undefined)
      // stopped for a restart: the job is queued again, so the clip is still on its way
      if (stopReason(jc.signal)?.kind === 'shutdown') await reopenAsset(assetId).catch(() => undefined)
      throw err
    }
  })
  registerHandler('ai.transcribe', async (jc) => {
    const { assetId, language } = jc.job.input as { assetId: string; language?: string }
    const r = await transcribeAsset(assetId, language, jc)
    return { assetId, transcript: r.transcript }
  })
  registerHandler('ai.tts', async (jc) => {
    const i = jc.job.input as { workspaceId: string; projectId?: string; text: string; voice: string; speed?: number; name?: string }
    const r = await synthesizeToAsset({ ...i, userId: jc.job.userId, jobId: jc.job.id }, jc)
    return { asset: r.asset, duration: r.duration }
  })
  registerHandler('ai.produce.script', produceScript)
  registerHandler('ai.produce.assemble', produceAssemble)
  registerHandler('export.render', exportRender)
  registerHandler('media.scenes', detectScenes)
  registerHandler('media.stabilise', stabiliseClip)
  registerHandler('media.denoise', denoiseClip)
  registerHandler('media.bgremove', removeBackground)
  registerHandler('media.smooth', makeSmoothCopy)
}
