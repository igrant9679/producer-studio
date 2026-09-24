# Producer Studio desktop (apps/desktop)

Electron shell around the same web UI and the same `apps/server` code, running locally in `MODE=desktop` for one
local user, with the user's own **Claude Code CLI** as the AI provider and two-way **sync** with a cloud account.
Architecture overview: [architecture.md](architecture.md) ("Two products, one codebase").

## Run it

| | |
|---|---|
| Dev | `npm run dev -w @producer/desktop` builds `apps/web`, builds main/preload, starts Electron, which spawns `apps/server/src/index.ts` through tsx with Electron's Node. `--no-web` skips the web build. `PS_USER_DATA=<dir>` uses a throwaway profile. |
| Installer | `npm run dist -w @producer/desktop` → `apps/desktop/release/Producer-Studio-Setup-<version>.exe` (+ `release/win-unpacked/`). `--no-web` reuses `apps/web/dist`; `--dir` builds only `win-unpacked`; `--download` fetches the bundled tools from upstream (CI). |
| Silent install | `Producer-Studio-Setup-0.1.0.exe /S /D=C:\path\to\dir` (per-user, assisted NSIS; `/D=` must be last and unquoted). Uninstall: `"Uninstall Producer Studio.exe" /S`. |
| Data | `%APPDATA%\Producer Studio\` — `data\` (PGlite, media, renders), `logs\main.log`, `logs\server.log`, `settings.json`, `keystore.bin`. |

## Process model

```
Producer Studio.exe (main)  ── spawns ──▶  Producer Studio.exe  (ELECTRON_RUN_AS_NODE=1)  resources/server/server.mjs
  splash → wait /api/health                  MODE=desktop  HOST=127.0.0.1  PORT=<free>  DATA_DIR=<userData>/data
  POST /api/desktop/session (secret)         DESKTOP_SECRET=<random per launch>  DESKTOP_SECRET_KEY=<safeStorage key>
  set ps_session cookie → load UI            stdin held by main: server exits when main goes away
```

- Quit closes the server's stdin (graceful PGlite shutdown), waits 5 s, then `taskkill /T /F` sweeps the tree.
- A server crash shows **Restart / Open logs / Quit**. "Sign out" in the web UI just opens a fresh local session.
- Packaged layout: `resources/app.asar` (main, preload, splash), `resources/server/` (esbuild bundle `server.mjs`,
  `node_modules/` with only the native/wasm-heavy externals and their closure, `scripts/tts-worker.mjs`,
  `scripts/mcp-server.mjs`, `runtime.js`, `skill/`), `resources/web/` (SPA without sourcemaps), `resources/tools/`.

## Bundled tools and how CI gets them

`scripts/fetch-tools.mjs` fills `apps/desktop/build/tools/` (cached between builds):

| Tool | Local build source | CI (`--download`) |
|---|---|---|
| whisper.cpp CLI + DLLs, `ggml-small.en.bin` | `WHISPER_DIR`, else the Producer 0.1 offline bundle (`%LOCALAPPDATA%\Programs\Producer\resources\app\resources\offline\tools\whisper`) | `whisper-bin-x64.zip` from the pinned whisper.cpp GitHub release + model from `huggingface.co/ggerganov/whisper.cpp` |
| Kokoro-82M ONNX (quantized) | `KOKORO_DIR`, else the Producer offline `models/onnx-community/Kokoro-82M-v1.0-ONNX` | `huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX` (config, tokenizer, `onnx/model_quantized.onnx`) |
| chrome-headless-shell (win64) | `CHROME_DIR`, else newest in `%USERPROFILE%\.cache\hyperframes\chrome\chrome-headless-shell` | `npx @puppeteer/browsers install chrome-headless-shell@$CHROME_HEADLESS_SHELL_VERSION` |

CI recipe (Windows runner): `npm ci` → `npm run dist -w @producer/desktop -- --download`, caching
`apps/desktop/build/tools` and electron-builder's cache (`%LOCALAPPDATA%\electron-builder\Cache`). Pin versions via the
constants at the top of `fetch-tools.mjs` and verify checksums in CI before trusting new releases.

## Code signing (hooks in place, unsigned today)

electron-builder signs automatically when these are present in the environment:

- `CSC_LINK` (path, https URL or base64 of a `.pfx`) + `CSC_KEY_PASSWORD` — or `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`.
- Azure Trusted Signing: add `win.azureSignOptions` (endpoint, certificate profile, account) to `electron-builder.yml`
  and provide `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`.

Without them the build logs "signing" steps but produces unsigned binaries (SmartScreen will warn on first run).

## Security

- Renderer: `sandbox: true` (also `app.enableSandbox()`), `contextIsolation`, no `nodeIntegration`, `webSecurity`,
  no webview, DevTools only in dev. Navigation is locked to `http://127.0.0.1:<port>`; other http(s) links open in the
  default browser via `shell.openExternal`; every other scheme is denied. `window.open` of local media/share pages opens
  a sandboxed viewer window; anything else local is denied. Permission requests are denied except clipboard-write and
  fullscreen for the local origin. Downloads always show a save dialog.
- Preload exposes only `window.producerDesktop = { version, platform, openExternal(url), showItemInFolder(path) }`.
  IPC handlers check the sender is the local origin and re-validate: `openExternal` takes http(s) URLs only (no
  credentials, ≤ 2 KB); `showItemInFolder` resolves symlinks and only accepts paths inside the data folder (the folder
  itself opens in Explorer). No generic `invoke`, no remote module.
- Server in desktop mode: binds `127.0.0.1` only; rejects non-loopback peers and any `Host` other than
  `127.0.0.1`/`localhost` (DNS-rebinding defence); every request is authenticated as usual (the only session source is
  `POST /api/desktop/session`, which needs the per-launch secret held by the main process); sign-up is disabled;
  CSP, `nosniff`, `no-referrer` on every response; `/api/system` only includes sync/account details for the session.
- Claude CLI: never `--dangerously-skip-permissions`; built-in tools disabled (`--tools ""`) except `Read` for
  contact sheets in the run's temp dir; `--strict-mcp-config`; `--allowedTools` lists only `mcp__producer__*`;
  environment stripped of `CLAUDECODE`, `CLAUDE_CODE_*`, `ANTHROPIC_*`; per-run temp dir removed afterwards; nothing
  is written to `~/.claude`. The MCP server talks back to the Producer server over a per-run named pipe with a random token.
- Cloud device token: AES-256-GCM at rest with a per-install key protected by **Electron safeStorage** (DPAPI on
  Windows, Keychain on macOS, libsecret on Linux), passed to the server as `DESKTOP_SECRET_KEY`. **Limitation:** when
  safeStorage is unavailable (e.g. Linux without a keyring, or the server run outside Electron) the key falls back to
  `<data>/.device-key`, which protects nothing against someone who can read the data folder. Revoke the device from the
  cloud (Settings → Linked devices) if a machine is lost.
- `PS_DESKTOP_SECRET` (≥ 16 chars) fixes the per-launch secret for UI automation; only whoever launches the app can set it.

## Sync behaviour (summary)

See `apps/server/src/desktop/sync.ts`. Link adopts the cloud identity, mirrors workspaces with the same ids and merges
local-only workspaces (personal → cloud personal; others are created in the cloud). Pull never overwrites a dirty local
project; cloud-advanced + local-dirty ⇒ conflict, as does a 409 on push. Resolve: keep-local (force-push over the latest
cloud version), keep-cloud, keep-both (local copy becomes "… (conflicted copy)"). Assets: local uploads are pushed with
the same id + sha256; cloud assets download on demand (202 while downloading, source sha256-verified) or eagerly with
"Download all". Exports (`origin: render`) stay local. Runs at start, every 60 s, 3 s after local saves; backs off
(5 s → 5 min) while offline.

## Known gaps

- Builds are unsigned; Windows only (macOS/Linux targets not configured).
- Changing the data folder in Settings takes effect at the next launch and does not move existing data.
- Removal from a cloud workspace (membership revoked) isn't mirrored locally: the workspace stays on this computer and pushes to it fail with an error in the sync status.
- Brand-kit conflicts are last-writer-wins (local edits since the last sync win until pushed).
- Assets are uploaded in one request per file (no resumable/multipart upload for very large sources yet).
- The Kokoro model is the quantized ONNX only; whisper is `small.en` (English).
