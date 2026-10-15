# VoiceStudio in Producer Studio

Producer Studio's **Voice Studio** page integrates [VoiceStudio](https://github.com/debpalash/VoiceStudio) (v0.5.6, AGPL-3.0,
by Palash Debnath and contributors): voice cloning, voice design, preset voices, multi-engine TTS, video dubbing and a
voice changer, audiobooks, vocal isolation and multilingual transcription.

The engine runs **only in the desktop edition** (it needs a local GPU/CPU and several GB of Python + models). The web
edition shows the space's cloned/designed voices and can generate with them **through a linked desktop**.

## Architecture

```
Electron main ── Producer server (Node, MODE=desktop) ──spawns──▶ VoiceStudio backend (Python, uvicorn, 127.0.0.1:<free port>)
                     │  /api/voicestudio/*   (lifecycle, voices, imports, asset-to)          ▲ loopback HTTP, no Origin header
                     │  /api/voicestudio/x/* (allow-listed proxy to VoiceStudio's own API) ──┘
                     │  /api/voice/*         (synced voice profiles + cloud relay)
Web UI (Voice Studio tabs) ── same-origin fetches only
```

- **Unmodified VoiceStudio, separate process.** We download the pinned source (`archive/<commit>.zip`, verified by a
  content hash of the runtime sources, `VS_TREE_SHA256`), never patch it, and talk to it over HTTP. This keeps Producer
  Studio's own code out of the AGPL; the Engine tab shows the AGPL notice and links the complete corresponding source.
- **Runtime** (`apps/server/src/desktop/voicestudio/runtime.ts`) mirrors VoiceStudio's own Electron setup: checksum-pinned
  uv 0.12.13 → `uv sync --frozen --no-dev --managed-python --python 3.11` (torch 2.8 cu128 on Windows) → cuDNN 8 compat
  libs on CUDA hosts → import probe → `.runtime-ready` stamp. Launch: `python -m uvicorn main:app --app-dir backend`.
- **Isolation:** everything lives under `%LOCALAPPDATA%\Producer Studio\VoiceStudio` (or `voiceStudioDir`):
  `OMNIVOICE_DATA_DIR=data`, `OMNIVOICE_CACHE_DIR=models`, `OMNIVOICE_ENV_FILE=env` (so `~/.config/omnivoice/env` is
  ignored), `OMNIVOICE_ANALYTICS_DISABLED=1`, `OMNIVOICE_DESKTOP_CONTAINED=1` (exits when our stdin closes). A random
  loopback port avoids VoiceStudio's own app adopting our backend on 3900.
- **TLS interception:** uv uses the OS certificate store (`UV_SYSTEM_CERTS`), and each start writes `ca-bundle.pem`
  (certifi + Windows ROOT/CA stores) for the backend's Python (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`).
- **Proxy allow-list** (`routes.ts`): profiles, generate, history, audio, design, gallery, archetypes, engines, models,
  dub, tasks, jobs, audiobook, stories, batch, transcribe, clean-audio, the engine-licence setting, OpenAI-style audio.
  Blocked: `/system/*`, other `/api/settings/*`, telephony, marketplace, MCP, auth.
- `PS_VOICESTUDIO_URL` attaches to an already-running backend instead of spawning one (tests use a fake backend).

## Voices

- `voice_profiles` (migration v6) holds synced metadata: name, kind (clone/design), engine, language, consent record,
  `device_id` (the desktop holding the reference audio). `vs_profile_id` is local-only and never synced.
- Voice ids are `vs:<profileId>`; they work everywhere a Kokoro voice does (Voice Studio TTS, Producer AI, the editor's
  voiceover box, the assistant's `add_voiceover`, brand kit). `GET /api/ai/voices?workspaceId=` lists them with
  `available`/`detail` for this replica.
- **Consent:** cloning requires an attestation ("It's my voice" or "Someone else's, with permission" + name) saved with the
  voice (statement, user, time). Designed and preset voices record that they aren't based on a real person.

## Cloud ↔ desktop

- Profiles sync like projects (change feed + `voice_profile` tombstones). Deleting a voice anywhere deletes the
  VoiceStudio profile on the owning desktop.
- **Relay:** on the cloud, TTS with a `vs:` voice becomes a `voice.relay` job (never claimed by the cloud worker). The
  owning desktop polls `GET /api/voice/relay/claim` every 5 s (only when it has local voices), generates, pushes the asset
  (same id, origin `tts`) through sync, then `POST /relay/:id/done`. Progress heartbeats carry cancellation back. Producer AI
  and the assistant wait on relay jobs inline. A device counts as online if it talked to the cloud in the last 2 minutes.

## Feature map (Voice Studio tabs)

| Tab | VoiceStudio API |
|---|---|
| Text to speech | `/generate` (via the `ai.tts` job for `vs:` voices) |
| My voices | `POST /profiles` (clone: `ref_audio`; design: `vd_states` + `instruct` + `seed`), `/design/describe`, `/archetypes`, `/archetypes/{id}/use`, `/profiles/{id}/audio` |
| Dubbing / voice changer | `/dub/upload` → `/tasks/stream` (prep) → `/dub/transcribe-stream` → `/dub/translate` (provider sent explicitly; Argos packs installed on demand) → `/dub/generate` → `/tasks/stream` → `/dub/download*`, `/dub/srt`, `/dub/export-stems` |
| Batch dubbing | `POST /batch/enqueue` (via `asset-to/batch` for library videos), `/batch/jobs[/{id}]`, `cancel`/`retry`/`DELETE`, `/batch/download/{id}/{lang}`; jobs queued with "add to library" are tracked in desktop_kv and a 15 s watcher imports each finished language as a `dub` asset (`desktop/voicestudio/batch.ts`) |
| Audiobooks | `/audiobook/import`, `/audiobook/plan`, `/audiobook/preview`, `POST /audiobook` (SSE), `/audio/<output>` |
| Audio tools | `/clean-audio`, `/transcribe` |
| Engine | `/engines/tts`, `/engines/select`, `/engines/sidecar/{id}/install`, `/api/settings/license`, `/models`, `/models/install[/status|/cancel]`, `DELETE /models/{repo}` |

Results come into the library with `POST /api/voicestudio/import` (server fetches a VoiceStudio output path into an asset)
and library media goes to VoiceStudio with `POST /api/voicestudio/asset-to/:target` (no browser round trip).

## Dictation

- **Stream:** the renderer records WebM/Opus (or the test harness sends `?pcm=1&sr=16000`) to `ws://127.0.0.1:<port>/api/voicestudio/ws/dictation`.
  `wsproxy.ts` handles that upgrade on the Node server (Hono middleware doesn't see upgrades), re-checks loopback peer,
  Host, same-origin `Origin` and the `ps_session` cookie, then splices TCP to VoiceStudio's
  `/v1/audio/transcriptions/stream` without Origin/Cookie (VoiceStudio refuses browser origins). Messages: `partial`,
  `final` (`final_kind` utterance/summary), `status`, `error`; finish with `{"type":"input_audio.end"}`.
- **In-app:** `Ctrl+Shift+Space` in any focused text field (DictationController in the shell); text goes in with
  `execCommand('insertText')` so React fields update and undo works. Esc cancels.
- **System-wide (Settings → Dictation):** Electron `globalShortcut` (default `Ctrl+Alt+D`; `Ctrl+Alt+Space` is often
  taken) toggles a frameless, never-focused, always-on-top widget window loading `/dictate`; the result goes to the main
  process, which copies it, pastes with `SendKeys ^v` (PowerShell) into the foreground app and restores the clipboard
  after 1.5 s. Electron allows microphone-only media for the local origin.
- **Warm-up:** with system-wide dictation on, the server pre-loads the dictation model when VoiceStudio starts or the
  setting changes (`warmDictation`); otherwise the first dictation waits ~35 s for faster-whisper large-v3 to load.
  Warm latency measured on an RTX 5090: partials every ~2.5 s (PCM) and the final ≈ 1 s after speech ends.

## Licences

VoiceStudio's code is AGPL-3.0. Model weights have their own terms: the default **OmniVoice weights are CC-BY-NC
(non-commercial)**; CosyVoice 3, VoxCPM2, MOSS-TTS, dots.tts, Confucius4-TTS are Apache-2.0; GPT-SoVITS is MIT; NLLB
(translation) is CC-BY-NC. The UI shows a licence chip per engine (`LICENSE_NOTES` in `vsApi.ts`) — informational, not legal
advice. Decision (Oct 2026): expose all engines with warnings; Producer Studio isn't used to produce videos commercially.

## Gaps / next

- Windows only (the runtime supports others in principle; untested). Not yet bundled: story/longform stems, the gallery
  import UI, MCP tools for the Claude CLI. System-wide paste uses SendKeys (Windows only).
- Cloud previews of profile voices aren't available (no sample is synced; play them on the desktop).
- If the Claude desktop app launches Producer Studio, MSIX AppData redirection can break uv's Python links; normal
  launches are unaffected.
