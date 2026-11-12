// Blender scenes on a graphics card rented from RunPod (runpod.io) with the space's own key: the web edition's way to
// render them (the server has no graphics card). One pod per video: started on the first Blender scene, deleted when
// the video is done.
//
// The server never connects to the pod, and the pod gets no key of ours. It gets one link (a presigned download of a
// manifest in this server's storage) holding the boot script, the job loop, the harness, Blender's download link and
// checksum, and presigned links for job slots 0, 1, 2 ... The server writes each job (the scene script, its settings,
// presigned upload links for the results) to the next slot; the pod fetches it, runs Blender (blender/harness.py, the
// same checks as on a desktop), uploads the results and result.json last. Everything for the pod lives under one
// storage prefix, deleted with the pod.
//
// Money: the pod is deleted when the video is done, failed or was cancelled (close()). If this server goes away
// mid-video, the pod deletes itself after IDLE_SECONDS without a job, and in any case MAX_SECONDS after it started.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { ctx } from '../context'
import { HttpError } from '../http'
import { CancelledError } from '../jobs/worker'
import { log } from '../log'
import type { Storage } from '../storage'
import { BLENDER_DIR, BLENDER_RENDER_TIMEOUT_MS, BlenderUnavailableError, BLENDER_TEST_TIMEOUT_MS, type BlenderResult, type BlenderRunner, blenderError, blenderSpec } from './blender'
import type { DrawingEnv } from './drawing'

export const RUNPOD_API = 'https://rest.runpod.io/v1'
/** Asked for in this order (RunPod rents the first it has): fast at Blender, a few dollars an hour at most. */
export const RUNPOD_GPUS = ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5090', 'NVIDIA L40S', 'NVIDIA RTX 6000 Ada Generation', 'NVIDIA L40', 'NVIDIA RTX A6000', 'NVIDIA A40', 'NVIDIA GeForce RTX 3090']
/** RunPod's own CUDA image (cached on its machines, so it starts quickly); Blender brings its own GPU code. */
export const RUNPOD_IMAGE = process.env.RUNPOD_BLENDER_IMAGE || 'runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04'
/** Blender 5.2 LTS for Linux, from blender.org, checked against its published SHA-256. */
export const BLENDER_LINUX = {
  url: 'https://download.blender.org/release/Blender5.2/blender-5.2.4-linux-x64.tar.xz',
  sha256: '2fd14c50987426897ba60237ee996edf2b4151f4b1a72a460ca20be58c1d2d86',
  version: 'Blender 5.2.4',
}
/** Jobs one pod takes (per scene: a first try, up to 2 fixes, 3 looks and the render; 6 drawn scenes a video). */
export const SLOTS = 48
const BOOT_TIMEOUT_MS = 20 * 60_000
/** The pod deletes itself after this long without a job (the AI writing a scene can take several minutes). */
export const IDLE_SECONDS = 30 * 60
export const MAX_SECONDS = 4 * 3600

export interface RunpodDeps {
  fetch: typeof fetch
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  now: () => number
  storage: () => Storage
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new CancelledError())
      },
      { once: true },
    )
  })

let deps: RunpodDeps = { fetch: (...a) => fetch(...a), sleep, now: () => Date.now(), storage: () => ctx().storage }
export const runpodDeps = () => deps
/** Tests swap the network, clock and storage. */
export function setRunpodDeps(d: Partial<RunpodDeps> | null) {
  deps = d ? { ...deps, ...d } : { fetch: (...a) => fetch(...a), sleep, now: () => Date.now(), storage: () => ctx().storage }
}

export class RunpodError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function api(key: string, method: string, p: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await deps.fetch(`${RUNPOD_API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 300)
    try {
      const j = JSON.parse(text) as { error?: string; message?: string }
      msg = j.error || j.message || msg
    } catch {
      // not JSON
    }
    throw new RunpodError(res.status, msg)
  }
  return text ? JSON.parse(text) : null
}

/** A key test: list the account's pods (needs nothing rented). */
export async function testRunpodKey(key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await api(key, 'GET', '/pods')
    return { ok: true, detail: '✓ valid · Blender scenes render on a rented graphics card' }
  } catch (err) {
    if (err instanceof RunpodError) {
      if (err.status === 401 || err.status === 403) return { ok: false, detail: 'RunPod didn’t accept this key. Create one with read and write access in RunPod → Settings → API Keys.' }
      if (err.status === 429) return { ok: false, detail: 'RunPod’s rate limit was reached. Test the key again in a moment.' }
      return { ok: false, detail: `Couldn’t check the RunPod key (HTTP ${err.status}). Try again.` }
    }
    return { ok: false, detail: 'Couldn’t reach RunPod to check the key. Try again.' }
  }
}

async function scopeOf(workspaceId: string) {
  const { LOCAL_SCOPE } = await import('../ai/provider')
  return ctx().config.mode === 'desktop' ? LOCAL_SCOPE : workspaceId
}

/** The space's RunPod key, unless its last test failed. */
export async function runpodKey(workspaceId: string): Promise<string | undefined> {
  const { loadDoc, readKey } = await import('../ai/store')
  const scope = await scopeOf(workspaceId)
  const doc = await loadDoc(scope)
  if (doc.media?.runpod?.valid === false) return undefined
  return readKey(scope, 'runpod')
}

/** Blender scenes can render on RunPod here: a working key, and storage the pod can reach (S3). */
export async function runpodReady(workspaceId: string): Promise<boolean> {
  const st = deps.storage()
  if (!st.presignGet || !st.presignPut) return false
  const { keyMeta, loadDoc } = await import('../ai/store')
  const scope = await scopeOf(workspaceId)
  const [meta, doc] = await Promise.all([keyMeta(scope), loadDoc(scope)])
  return Boolean(meta.runpod) && doc.media?.runpod?.valid !== false
}

async function readObject(st: Storage, key: string): Promise<Buffer> {
  const s: Readable = await st.getStream(key)
  const parts: Buffer[] = []
  for await (const c of s) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(parts)
}

/** The pod's start command: fetch the manifest, write its files, boot. */
export const START_COMMAND = [
  'set -e',
  'mkdir -p /ps',
  'curl -fsSL -m 120 "$PS_MANIFEST" -o /ps/manifest.json',
  `python3 -c "import json; m=json.load(open('/ps/manifest.json')); [open('/ps/'+n,'w').write(m[k]) for n,k in (('boot.sh','boot'),('pod.py','pod'),('harness.py','harness'))]; json.dump(m['config'], open('/ps/config.json','w'))"`,
  'rm -f /ps/manifest.json',
  'exec bash /ps/boot.sh',
].join('; ')

interface Pod {
  id: string
  prefix: string
  next: number
  gpu?: string
  costPerHr?: number
}

export class RunpodBlender implements BlenderRunner {
  readonly where = 'runpod' as const
  private pod?: Promise<Pod>
  private started?: Pod
  /** The card rented and its price, for the video's notes. */
  info?: { gpu?: string; costPerHr?: number }

  constructor(private readonly key: string) {}

  private start(signal?: AbortSignal): Promise<Pod> {
    // one try per video: a pod that couldn't start isn't asked for again for every scene
    this.pod ??= this.boot(signal)
    return this.pod
  }

  private async boot(signal?: AbortSignal): Promise<Pod> {
    const st = deps.storage()
    if (!st.presignGet || !st.presignPut) throw new BlenderUnavailableError('Blender on RunPod needs this server’s storage to be S3', 409)
    const prefix = `blender-jobs/${crypto.randomBytes(9).toString('hex')}`
    const expiresSec = MAX_SECONDS + 600
    const slots = await Promise.all(Array.from({ length: SLOTS }, (_, n) => st.presignGet!(`${prefix}/job-${n}.json`, { expiresSec })))
    const bootUrl = await st.presignPut(`${prefix}/boot.json`, 'application/json', { expiresSec })
    const read = (f: string) => fs.readFileSync(path.join(BLENDER_DIR(), f), 'utf8')
    const manifest = {
      config: { slots, bootUrl, blenderUrl: BLENDER_LINUX.url, blenderSha256: BLENDER_LINUX.sha256, idleSeconds: IDLE_SECONDS, maxSeconds: MAX_SECONDS },
      boot: read('boot.sh'),
      pod: read('pod.py'),
      harness: read('harness.py'),
    }
    await st.put(`${prefix}/manifest.json`, Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' })
    const manifestUrl = await st.presignGet(`${prefix}/manifest.json`, { expiresSec: 3600 })
    let created: { id?: string; costPerHr?: number; gpu?: { displayName?: string; id?: string } } | undefined
    let lastErr: unknown
    for (const cloudType of ['SECURE', 'COMMUNITY']) {
      try {
        created = (await api(
          this.key,
          'POST',
          '/pods',
          {
            name: `producer-blender-${prefix.slice(-8)}`,
            imageName: RUNPOD_IMAGE,
            gpuTypeIds: RUNPOD_GPUS,
            gpuCount: 1,
            cloudType,
            computeType: 'GPU',
            containerDiskInGb: 30,
            volumeInGb: 0,
            env: { PS_MANIFEST: manifestUrl },
            dockerStartCmd: ['bash', '-c', START_COMMAND],
            ports: [],
            interruptible: false,
          },
          signal,
        )) as typeof created
        break
      } catch (err) {
        lastErr = err
        // a key problem won't be better in the community cloud
        if (err instanceof RunpodError && (err.status === 401 || err.status === 403)) break
      }
    }
    if (!created?.id) {
      await st.deletePrefix(prefix).catch(() => undefined)
      const why = lastErr instanceof RunpodError ? (lastErr.status === 401 || lastErr.status === 403 ? 'RunPod didn’t accept the key' : lastErr.message.slice(0, 160)) : 'RunPod couldn’t be reached'
      throw new BlenderUnavailableError(`no graphics card could be rented on RunPod (${why})`)
    }
    const pod: Pod = { id: created.id, prefix, next: 0, gpu: created.gpu?.displayName || created.gpu?.id, costPerHr: created.costPerHr }
    this.started = pod
    this.info = { gpu: pod.gpu, costPerHr: pod.costPerHr }
    log.info('runpod pod started for blender scenes', { pod: pod.id, gpu: pod.gpu, costPerHr: pod.costPerHr })
    // ready when the pod says so (boot.json); a pod RunPod stopped, or one that never says, is given up on
    const deadline = deps.now() + BOOT_TIMEOUT_MS
    let checked = deps.now()
    for (;;) {
      if (await st.stat(`${prefix}/boot.json`)) break
      if (deps.now() > deadline) throw new BlenderUnavailableError('the rented graphics card didn’t start within 20 minutes', 504)
      if (deps.now() - checked > 30_000) {
        checked = deps.now()
        await this.alive(signal)
      }
      await deps.sleep(5_000, signal)
    }
    const boot = JSON.parse((await readObject(st, `${prefix}/boot.json`)).toString('utf8')) as { ok?: boolean; error?: string; gpu?: string; version?: string }
    if (!boot.ok) throw new BlenderUnavailableError(boot.error || 'the rented graphics card couldn’t be set up')
    if (boot.gpu) this.info.gpu = pod.gpu = boot.gpu
    return pod
  }

  /** Throws when RunPod has stopped the pod. */
  private async alive(signal?: AbortSignal) {
    if (!this.started) return
    try {
      const p = (await api(this.key, 'GET', `/pods/${encodeURIComponent(this.started.id)}`, undefined, signal)) as { desiredStatus?: string }
      if (p?.desiredStatus === 'TERMINATED' || p?.desiredStatus === 'EXITED') throw new BlenderUnavailableError('RunPod stopped the rented graphics card')
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (err instanceof RunpodError && err.status === 404) throw new BlenderUnavailableError('the rented graphics card is gone')
      // a failed check isn't a failed pod
    }
  }

  private async job(code: string, spec: ReturnType<typeof blenderSpec>, outputs: Array<{ name: string; type: string }>, timeoutMs: number, signal?: AbortSignal): Promise<{ result: BlenderResult; base: string }> {
    const pod = await this.start(signal)
    const st = deps.storage()
    const n = pod.next++
    if (n >= SLOTS) throw new HttpError(502, 'server', 'too many Blender jobs for one video')
    const base = `${pod.prefix}/out-${n}`
    const uploads: Record<string, string> = { 'result.json': await st.presignPut!(`${base}/result.json`, 'application/json', { expiresSec: Math.round(timeoutMs / 1000) + 3600 }) }
    for (const o of outputs) uploads[o.name] = await st.presignPut!(`${base}/${o.name}`, o.type, { expiresSec: Math.round(timeoutMs / 1000) + 3600 })
    await st.put(`${pod.prefix}/job-${n}.json`, Buffer.from(JSON.stringify({ code, spec, uploads, timeout: Math.round(timeoutMs / 1000) })), { contentType: 'application/json' })
    const deadline = deps.now() + timeoutMs + 5 * 60_000
    let checked = deps.now()
    for (;;) {
      if (await st.stat(`${base}/result.json`)) break
      if (deps.now() > deadline) throw new BlenderUnavailableError('the rented graphics card stopped answering', 504)
      if (deps.now() - checked > 60_000) {
        checked = deps.now()
        await this.alive(signal)
      }
      await deps.sleep(3_000, signal)
    }
    return { result: JSON.parse((await readObject(st, `${base}/result.json`)).toString('utf8')) as BlenderResult, base }
  }

  async test(code: string, env: DrawingEnv, times: number[], signal?: AbortSignal): Promise<Buffer[]> {
    const outputs = times.map((_, i) => ({ name: `test-${i}.jpg`, type: 'image/jpeg' }))
    const { result, base } = await this.job(code, blenderSpec(env, 'test', times), outputs, BLENDER_TEST_TIMEOUT_MS, signal)
    if (!result.ok || !result.frames?.length) throw blenderError(result, this.where)
    const st = deps.storage()
    return Promise.all(result.frames.map((f) => readObject(st, `${base}/${path.basename(f)}`)))
  }

  async render(code: string, env: DrawingEnv, outFile: string, opts: { signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<void> {
    opts.onProgress?.(0.05)
    const { result, base } = await this.job(code, blenderSpec(env, 'render'), [{ name: 'video.mp4', type: 'video/mp4' }], BLENDER_RENDER_TIMEOUT_MS, opts.signal)
    if (!result.ok || !result.video) throw blenderError({ ...result, render: true }, this.where)
    await deps.storage().download(`${base}/video.mp4`, outFile)
    opts.onProgress?.(1)
  }

  /** Stop and delete the pod (if one was started) and everything it was sent. Never throws. */
  async close(): Promise<void> {
    const pod = this.started
    if (!pod) return
    this.started = undefined
    const st = deps.storage()
    await st.put(`${pod.prefix}/job-${Math.min(pod.next, SLOTS - 1)}.json`, Buffer.from('{"stop":true}'), { contentType: 'application/json' }).catch(() => undefined)
    let deleted = false
    for (let attempt = 0; attempt < 4 && !deleted; attempt++) {
      try {
        await api(this.key, 'DELETE', `/pods/${encodeURIComponent(pod.id)}`)
        deleted = true
      } catch (err) {
        if (err instanceof RunpodError && err.status === 404) deleted = true
        else await deps.sleep(2_000 * (attempt + 1)).catch(() => undefined)
      }
    }
    if (!deleted) log.error('a runpod pod could not be deleted (it deletes itself when idle)', { pod: pod.id })
    else log.info('runpod pod deleted', { pod: pod.id })
    await st.deletePrefix(pod.prefix).catch(() => undefined)
  }
}
