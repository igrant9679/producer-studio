// AI stills for videos made without recordings, billed to the workspace's own key (capabilities.ts picks which).
//   OpenAI – images.generate with a GPT Image model, base64 JPEG back. 16:9 → 1536×864 and 9:16 → 864×1536 on models
//            with custom sizes, else the nearest standard size (1536×1024 / 1024×1536); 1:1 → 1024×1024. Quality
//            medium (GPT Image 2 lists $0.041–0.053 an image at medium).
//   Gemini – generateContent with imageConfig.aspectRatio (+ imageSize where the model has one); the picture comes back
//            as an inlineData part. That call shape (no responseModalities) is the one proven on a live key with
//            gemini-3.1-flash-image (16:9 → 1376×768) in the owner's other app.
// A refusal (content policy / safety filters) is a 422 with a plain sentence: the provider's wording never reaches people.
import fs from 'node:fs'
import OpenAI from 'openai'
import type { GenerateContentResponse } from '@google/genai'
import { HttpError, invalid } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { mapGeminiError } from '../gemini'
import { mapOpenAiError } from '../openai'
import {
  accountProblem,
  type GenKey,
  GEMINI_IMAGE_MODELS,
  type GeminiImageModel,
  OPENAI_IMAGE_MODELS,
  type OpenAiImageModel,
  describeFile,
  genDeps,
  outFile,
  requireKey,
  tryModels,
  withoutKey,
} from './capabilities'
import type { GenAspect, GeneratedFile } from './index'

const OPENAI_QUALITY = 'medium' as const
const OPENAI_CUSTOM_SIZE: Record<GenAspect, string> = { '16:9': '1536x864', '9:16': '864x1536', '1:1': '1024x1024' }
const OPENAI_STANDARD_SIZE: Record<GenAspect, string> = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' }

/** Finish / block reasons that mean the provider refused the picture. */
const GEMINI_REFUSED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'MODEL_ARMOR', 'JAILBREAK'])

const refused = (provider: string) =>
  new HttpError(422, 'invalid', `${provider} declined to make this image (its content rules). Try describing the scene differently.`)

interface Picture {
  bytes: Buffer
  mime: string
}

export async function generateImage(opts: { workspaceId: string; prompt: string; aspect: GenAspect; outDir: string; signal?: AbortSignal }): Promise<GeneratedFile> {
  if (opts.signal?.aborted) throw new CancelledError()
  const prompt = opts.prompt.trim()
  if (!prompt) throw invalid('Describe the image to generate.')
  const k = await requireKey(opts.workspaceId, 'image')
  let pic: { value: Picture; model: { id: string } }
  try {
    pic = k.provider === 'openai' ? await openAiImage(k, prompt, opts.aspect, opts.signal) : await geminiImage(k, prompt, opts.aspect, opts.signal)
  } catch (err) {
    if (opts.signal?.aborted) throw new CancelledError()
    throw withoutKey(err, k.key)
  }
  const ext = pic.value.mime === 'image/png' ? 'png' : pic.value.mime === 'image/webp' ? 'webp' : 'jpg'
  const file = outFile(opts.outDir, 'ai-image', ext)
  await fs.promises.writeFile(file, pic.value.bytes)
  const info = await describeFile(file, opts.signal)
  return { file, mime: pic.value.mime, provider: k.provider, model: pic.model.id, ...(info.width ? { width: info.width, height: info.height } : {}) }
}

/** The image type from its first bytes (providers don't always say). */
export function sniffImage(b: Buffer): string | undefined {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

function picture(b64: string, said?: string): Picture {
  const bytes = Buffer.from(b64, 'base64')
  const mime = sniffImage(bytes) ?? (said?.startsWith('image/') ? said : undefined)
  if (!mime) throw new HttpError(502, 'server', 'The AI returned something that isn’t an image. Try again.')
  return { bytes, mime }
}

// ---------------- OpenAI ----------------

function mapOpenAiImageError(err: unknown): never {
  const account = accountProblem('openai', err)
  if (account) throw account
  if (err instanceof OpenAI.BadRequestError && (err.code === 'moderation_blocked' || err.code === 'content_policy_violation' || /safety system|content polic|moderation/i.test(err.message)))
    throw refused('OpenAI')
  mapOpenAiError(err)
}

async function openAiImage(k: GenKey, prompt: string, aspect: GenAspect, signal?: AbortSignal) {
  const client = genDeps().openai(k.key)
  try {
    return await tryModels(k, 'image', OPENAI_IMAGE_MODELS, async (m: OpenAiImageModel) => {
      const size = (m.sizes === 'custom' ? OPENAI_CUSTOM_SIZE : OPENAI_STANDARD_SIZE)[aspect]
      const res = await client.images.generate({ model: m.id, prompt, n: 1, size, quality: OPENAI_QUALITY, output_format: 'jpeg', output_compression: 90 }, { signal })
      const b64 = res.data?.[0]?.b64_json
      if (!b64) throw new HttpError(502, 'server', 'OpenAI returned no image. Try again.')
      return picture(b64, `image/${res.output_format ?? 'jpeg'}`)
    })
  } catch (err) {
    mapOpenAiImageError(err)
  }
}

// ---------------- Gemini ----------------

function mapGeminiImageError(err: unknown, model?: string): never {
  const account = accountProblem('gemini', err)
  if (account) throw account
  const status = (err as { status?: unknown }).status
  if (status === 400 && /(safety|blocked|prohibited|policy)/i.test(err instanceof Error ? err.message : '')) throw refused('Gemini')
  mapGeminiError(err, model)
}

/** The picture in a generateContent response, or a 422 when the model refused / answered without one. */
function geminiPicture(res: GenerateContentResponse): Picture {
  if (res.promptFeedback?.blockReason) throw refused('Gemini')
  const cand = res.candidates?.[0]
  const reason = cand?.finishReason ? String(cand.finishReason) : undefined
  if (reason && GEMINI_REFUSED.has(reason)) throw refused('Gemini')
  // thinking models can send draft images first (thought parts); the last plain image part is the answer
  const parts = (cand?.content?.parts ?? []).filter((p) => !p.thought && p.inlineData?.data && (p.inlineData.mimeType ?? 'image/').startsWith('image/'))
  const last = parts[parts.length - 1]
  if (!last) throw new HttpError(422, 'invalid', 'Gemini answered without an image. Try describing the scene differently.')
  return picture(last.inlineData!.data!, last.inlineData!.mimeType)
}

async function geminiImage(k: GenKey, prompt: string, aspect: GenAspect, signal?: AbortSignal) {
  const client = genDeps().gemini(k.key)
  let current: string | undefined
  try {
    return await tryModels(k, 'image', GEMINI_IMAGE_MODELS, async (m: GeminiImageModel) => {
      current = m.id
      const res = await client.models.generateContent({
        model: m.id,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { imageConfig: { aspectRatio: aspect, ...(m.imageSize ? { imageSize: m.imageSize } : {}) }, abortSignal: signal },
      })
      return geminiPicture(res)
    })
  } catch (err) {
    mapGeminiImageError(err, current)
  }
}
