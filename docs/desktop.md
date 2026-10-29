# Producer Studio desktop (apps/desktop)

Electron shell around the same web UI and the same `apps/server` code, running locally in `MODE=desktop` for one
local user, with the user's own **Claude Code CLI** as the AI provider and two-way **sync** with a cloud account.
Architecture overview: [architecture.md](architecture.md) ("Two products, one codebase").

## Run it

| | |
|---|---|
| Dev | `npm run dev -w @producer/desktop` builds `apps/web`, builds main/preload, starts Electron, which spawns `apps/server/src/index.ts` through tsx with Electron's Node. `--no-web` skips the web build. `PS_USER_DATA=<dir>` uses a throwaway profile. |
| Installer | `npm run dist -w @producer/desktop` → `apps/desktop/release/Producer-Studio-Setup-<version>.exe` (+ `release/win-unpacked/`). `--no-web` reuses `apps/web/dist`; `--dir` builds only `win-unpacked`; `--download` fetches the bundled tools from upstream (CI). |
| Linux | On Linux (after `npm ci` there, so ffmpeg, sharp and onnxruntime are Linux builds): `npm run dist -w @producer/desktop -- --linux` → `release/Producer-Studio-<version>-x64.AppImage` and `.deb` (the deb recommends `xdotool`, `wtype` and `libappindicator3-1`). whisper.cpp has no Linux release binary: build it and set `WHISPER_DIR` to the folder holding `whisper-cli` (`--download` still fetches the model); without it the app ships without transcription and its tool check says so. Each platform is built on its own OS; dist.mjs refuses a cross build. |
| macOS (prepared) | `npm run dist -w @producer/desktop -- --mac` on a Mac → `.dmg` + `.zip`, hardened runtime with `installer/entitlements.mac.plist` (JIT, unsigned executable memory and library validation off for the native modules, microphone, Apple Events for dictation's paste). Signed with a Developer ID (`CSC_LINK` / `CSC_NAME`) and notarised when an Apple account is also set (`APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`): both owner items. Not built or run yet. |
| Silent install | `Producer-Studio-Setup-0.1.0.exe /S /D=C:\path\to\dir` (per-user, assisted NSIS; `/D=` must be last and unquoted). Uninstall: `"Uninstall Producer Studio.exe" /S`. |
| Uninstall | Apps & features → Producer Studio. After removing the app it asks two questions, both defaulting to **No** (`installer/uninstall.nsh`): remove the VoiceStudio engine (`%LOCALAPPDATA%\Producer Studio\VoiceStudio`, 10 GB or more), and delete the data on this computer (`%LOCALAPPDATA%\Producer Studio` and `%APPDATA%\Producer Studio`: projects, media, renders, voices, settings, saved keys; unsynced projects are lost). A silent uninstall (`/S`) and an update keep everything. A data folder moved elsewhere is never touched (delete it yourself). |
| Data | `%APPDATA%\Producer Studio\` — `logs\main.log`, `logs\server.log` (rotated at 10 MB while running), `settings.json`, `keystore.bin`. The data folder (PGlite, media, renders) is `%LOCALAPPDATA%\Producer Studio\data\` for new installs; an install from before keeps `%APPDATA%\Producer Studio\data\`. Its path is in `settings.json` (`dataDir`); Settings → Storage or File → Move data folder… moves it (copy, check, switch, remove the old one). A folder that can't be opened at launch (a drive that isn't connected) is reported, with the default folder offered instead. |

## Process model

```
Producer Studio.exe (main)  ── utilityProcess.fork ──▶  engine (utility process)  resources/server/server.mjs
  backup the database if this build migrates it         MODE=desktop  HOST=127.0.0.1  PORT=<free>  DATA_DIR=<dataDir>
  splash → wait /api/health                             DESKTOP_SECRET=<random per launch>  DESKTOP_SECRET_KEY=<key>
  POST /api/desktop/session (secret)                    DESKTOP_PARENT_PORT=1: stops on {type:'stop'} from main
  set ps_session cookie → load UI → tool check          (dev / fallback: a child with ELECTRON_RUN_AS_NODE=1 that
  tray icon, update check (signed builds)                exits when main closes its stdin)
```

- **Engine host (D-12).** Packaged builds fork the engine as an Electron utility process (`src/engine-host.ts`), so the
  main process never needs `ELECTRON_RUN_AS_NODE`; dev runs it as a Node child through tsx. A utility process that
  can't start the engine falls back to the child once per launch (`server.log` says so); `PS_ENGINE_HOST=child|utility`
  overrides. Inside Electron the engine's own children get `ELECTRON_RUN_AS_NODE=1` from `childEnv()` (TTS worker,
  renderer, the MCP server Claude starts), never the Claude CLI itself.
- **Fuses (D-12).** `scripts/release.mjs` `FUSES`, flipped by electron-builder at packaging: `NODE_OPTIONS` and
  `--inspect`/SIGUSR1 ignored, only `app.asar` loads and its embedded integrity hash is checked (Windows: Electron 30+),
  cookies encrypted, no extra `file://` privileges. `runAsNode` stays **on**: the engine still starts those Node children
  with the app binary; switching it off needs them moved to utility processes too (the MCP server is started by the
  Claude CLI, so it would need a separate Node). With `NODE_OPTIONS` off, the renderer's `--use-system-ca` (only used
  when HyperFrames downloads its own browser) has no effect; packaged builds ship that browser. Check a real build with
  `npx @electron/fuses read --app "release/win-unpacked/Producer Studio.exe"`.
- Quit asks the engine to stop (a stop message to the utility process, or its stdin closed; graceful PGlite shutdown),
  waits 12 s, then `taskkill /T /F` sweeps the tree.
- A server crash shows **Restart / Open logs / Quit**. "Sign out" in the web UI just opens a fresh local session.
- Packaged layout: `resources/app.asar` (main, preload, splash), `resources/server/` (esbuild bundle `server.mjs`,
  `node_modules/` with only the native/wasm-heavy externals and their closure, `scripts/tts-worker.mjs`,
  `scripts/mcp-server.mjs`, `runtime.js`, `skill/`), `resources/web/` (SPA without sourcemaps), `resources/tools/`.

## Settings → This computer

The desktop app's own settings live in `%APPDATA%\Producer Studio\shell.json` (the engine's `settings.json` keeps only
its own keys), changed from Settings → This computer through the preload's `producerDesktop.app`.

- **Tray (D-2).** A tray icon: Open / Show Producer Studio, Dictate (its shortcut), "Keep running when the window is
  closed", Settings…, Quit Producer Studio. With keep running on, closing the window hides it: the engine, the dictation
  shortcut and the voice relay keep going (a Windows balloon says so the first time). Off by default; a desktop without
  a tray (some Linux) always quits on close.
- **Look for new versions (D-4).** See "Updates".
- **Database backups (D-10).** Before the first start of a build with a newer database schema (or, schema unknown,
  another app version), the PGlite folder `<data>/pg` is copied to `<data>/backups/db-<UTC time>-from-<version>/pg`
  while nothing has it open; the newest 3 are kept, media isn't copied. A backup that fails offers Quit or "Continue
  without a backup". `build-info.json` carries the schema; `shell.json` `lastStart` the last start's. **To restore:**
  quit Producer Studio (and from the tray, if it keeps running), rename `<data>\pg` to `pg.broken`, copy
  `<data>\backups\db-…\pg` to `<data>\pg`, and start the version named in the backup (an older app can't open a newer
  database). Settings shows the backups and opens their folder. Move data folder takes them along.
- **Crash reports and Copy diagnostics (D-14).** Opt-in, off by default, applied at the next start: Electron's
  crashReporter with `uploadToServer: false`, so minidumps stay in `app.getPath('crashDumps')` and nothing is sent (an
  upload endpoint is an owner item). Renderer and child-process exits are always logged to `main.log`. Copy diagnostics
  (Settings, or Help → Copy diagnostics) puts on the clipboard: versions, build (signed, schema), engine host, paths,
  these settings, the tool check, the crash reports' names and the last lines of `main.log` and `server.log`, with
  tokens, keys, cookies, passwords and email addresses taken out (`src/diagnostics.ts` `redact`).
- **Bundled tools (D-13).** At start the engine checks ffmpeg and ffprobe (run), whisper and its model, the Kokoro
  model and the renderer (`GET /api/tools/health`, `services/tool-health.ts`); a broken one gets a dialog naming it,
  what it's for and the fix. Settings lists them all with Check again.

## Bundled tools and how CI gets them

`scripts/fetch-tools.mjs` fills `apps/desktop/build/tools/` (cached between builds):

| Tool | Local build source | CI (`--download`) |
|---|---|---|
| whisper.cpp CLI + DLLs, `ggml-small.en.bin` | `WHISPER_DIR`, else the Producer 0.1 offline bundle (`%LOCALAPPDATA%\Programs\Producer\resources\app\resources\offline\tools\whisper`) | `whisper-bin-x64.zip` from the whisper.cpp v1.7.6 GitHub release + model from `huggingface.co/ggerganov/whisper.cpp` at a pinned commit |
| Kokoro-82M ONNX (quantized) | `KOKORO_DIR`, else the Producer offline `models/onnx-community/Kokoro-82M-v1.0-ONNX` | `huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX` at a pinned commit (config, tokenizer, `onnx/model_quantized.onnx`) |
| chrome-headless-shell (win64) | `CHROME_DIR`, else newest in `%USERPROFILE%\.cache\hyperframes\chrome\chrome-headless-shell` | `npx @puppeteer/browsers@3.2.3 install chrome-headless-shell@$CHROME_HEADLESS_SHELL_VERSION` |

CI recipe (Windows runner): `npm ci` → `npm run dist -w @producer/desktop -- --download`, caching
`apps/desktop/build/tools` and electron-builder's cache (`%LOCALAPPDATA%\electron-builder\Cache`). With `--download`,
every file is checked against a sha256 pinned at the top of `fetch-tools.mjs` (the whisper zip, the whisper model and
each Kokoro file; cached copies are re-checked and fetched again on a mismatch), and Hugging Face files come from a
commit (`resolve/<sha>`), never `main`. Chrome for Testing publishes no checksums, so chrome-headless-shell is pinned by
version only. To move a pin, take the new sha256 from the GitHub release API (asset `digest`) or Hugging Face's
`paths-info` API (`lfs.oid`) — the comment in `fetch-tools.mjs` has the calls; no large download is needed.

## Code signing (ready, unsigned until the owner sets it up)

`npm run dist` reads how to sign from the environment (`scripts/release.mjs` → `releaseConfig()`, laid over
`electron-builder.yml` by `scripts/dist.mjs`) and prints what it will do (`desktop build: …`):

| Set in the environment | Result |
|---|---|
| nothing | Unsigned, exactly as before (SmartScreen warns on first run). `build-info.json` says `signed: false`. |
| **Azure Trusted Signing**: `AZURE_TRUSTED_SIGNING_ENDPOINT` (e.g. `https://weu.codesigning.azure.net`), `AZURE_TRUSTED_SIGNING_ACCOUNT` (the Trusted Signing account name), `AZURE_TRUSTED_SIGNING_PROFILE` (the certificate profile), and the Entra ID app that may sign: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Optional `AZURE_TRUSTED_SIGNING_PUBLISHER` (default `Producer Studio`): must match the certificate's subject exactly. | The app, its executables and the installer are signed through `Invoke-TrustedSigning` (electron-builder installs the PowerShell module on first use; Windows build machines only). A signing failure fails the build (`forceCodeSigning`), never an unsigned installer. Only some of these six set stops the build and names the missing ones. |
| a `.pfx`: `CSC_LINK` (path, https URL or base64) + `CSC_KEY_PASSWORD`, or `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Signed with that certificate (electron-builder's own), also required to succeed. |

Owner setup for Azure Trusted Signing: a Trusted Signing account and a public-trust certificate profile (identity
validation of the organisation), an Entra ID app registration with a client secret, given the "Trusted Signing
Certificate Profile Signer" role on the profile. Put the six values in the CI secrets. The secrets never go into
the build config; the signing module reads them from the environment.

## Updates (mechanism ready, off until builds are signed)

electron-updater isn't a dependency and Electron's built-in autoUpdater doesn't drive NSIS installs, so the app checks
a GitHub Releases feed itself (`src/updates.ts`): `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`
at start (after 30 s) and once a day, compares the tag with its version and, for a newer one, says so with
**Download** (opens that release's page on github.com, the only kind of link it accepts), **Later** and **Skip this
version**. It never downloads or installs anything itself. Help → Check for updates… and Settings → This computer →
Check now ask at any time; the setting "Look for new versions" (on by default) turns the automatic checks off.

It is offered only when the build says so in `build-info.json`: `signed: true` (signing configured, see above) and
`updateRepo`, set at build time with `PS_UPDATE_REPO=<owner>/<repo>`. Unsigned builds show the setting greyed out with
the reason. Owner items: signing, and publishing each release (tag `v<version>`, the installer attached) to that repo.

## Security

- Renderer: `sandbox: true` (also `app.enableSandbox()`), `contextIsolation`, no `nodeIntegration`, `webSecurity`,
  no webview, DevTools only in dev. Navigation is locked to `http://127.0.0.1:<port>`; other http(s) links open in the
  default browser via `shell.openExternal`; every other scheme is denied. `window.open` of local media/share pages opens
  a sandboxed viewer window; anything else local is denied. Permission requests are denied except clipboard-write,
  fullscreen and microphone-only media (Voice Studio records reference clips for voice cloning) for the local origin. Downloads always show a save dialog.
- Preload exposes only `window.producerDesktop = { version, platform, openExternal(url), showItemInFolder(path),
  setNativeTheme(mode), moveDataFolder(), app: { settings, setSettings }, dictation: { configure, result, cancel,
  toggle, onCommand } }` (system-wide dictation: global shortcut, the `/dictate` widget window, clipboard + paste:
  SendKeys on Windows, `wtype` on Wayland or `xdotool` on X11 when installed, else the text stays on the clipboard,
  System Events on macOS; see voicestudio.md). `app` is the shell's own settings (Settings → This computer), and
  `setSettings` takes only the known on/off keys.
  IPC handlers check the sender is the local origin and re-validate: `openExternal` takes http(s) URLs only (no
  credentials, ≤ 2 KB); `showItemInFolder` resolves symlinks and only accepts paths inside the data folder (the folder
  itself opens in Explorer). No generic `invoke`, no remote module.
- Server in desktop mode: binds `127.0.0.1` only; rejects non-loopback peers and any `Host` other than
  `127.0.0.1`/`localhost` (DNS-rebinding defence); every request is authenticated as usual (the only session source is
  `POST /api/desktop/session`, which needs the per-launch secret held by the main process); sign-up is disabled;
  CSP, `nosniff`, `no-referrer` on every response; `/api/system` only includes sync/account details for the session.
- The per-launch secret and the safeStorage key reach the server in its environment; it moves both into memory at
  startup (`apps/server/src/child-env.ts`) and every child environment is built without them, so ffmpeg, the renderer,
  the TTS worker, the Claude CLI, VoiceStudio and the sign-in terminal never see them.
- Claude CLI: never `--dangerously-skip-permissions`; `--permission-mode default` and `--setting-sources ""` (the
  user's own Claude Code settings, hooks and CLAUDE.md files don't apply); built-in tools disabled (`--tools ""`) except
  `Read` for contact sheets, allowed only inside the run's temp dir (`Read(//<run dir>/**)`); `--strict-mcp-config`;
  a CLI whose `--help` doesn't list `--permission-mode`, `--setting-sources` and `--strict-mcp-config` is reported as
  too old instead of being run without them (a `--help` that fails or times out is asked again, never cached);
  `--allowedTools` lists only `mcp__producer__*`;
  environment stripped of `CLAUDECODE`, `CLAUDE_CODE_*`, `ANTHROPIC_*`; per-run temp dir removed afterwards; nothing
  is written to `~/.claude`. The MCP server talks back to the Producer server over a per-run named pipe with a random token.
- Cloud device token: AES-256-GCM at rest with a per-install key protected by **Electron safeStorage** (DPAPI on
  Windows, Keychain on macOS, libsecret on Linux), passed to the server as `DESKTOP_SECRET_KEY`. **Limitation:** when
  safeStorage is unavailable (e.g. Linux without a keyring, or the server run outside Electron) the key falls back to
  `<data>/.device-key`, which protects nothing against someone who can read the data folder. Revoke the device from the
  cloud (Settings → Linked devices) if a machine is lost. If `keystore.bin` can't be decrypted (another OS user, a reset
  keychain, a locked keyring) it is **not** replaced: a byte-identical copy is kept as `keystore.bin.unreadable-<time>`,
  the launch continues without it (key-file fallback, so the device token and AI keys read as missing), and a dialog
  offers Continue / Start over with a new key / Quit. Only "Start over" writes a new keystore.
- The cloud URL must be `https://`; plain `http://` is accepted only for a cloud on this computer (`localhost`,
  `127.x.x.x`, `[::1]`), since linking sends the account password and every sync the device token.
- `PS_DESKTOP_SECRET` (≥ 16 chars) fixes the per-launch secret for UI automation in **dev builds only** (`!app.isPackaged`); packaged builds always generate a random secret.
- AI provider keys (Settings → AI: Anthropic, Gemini, OpenAI) live in the `ai` block of `settings.json`, AES-256-GCM sealed with the same safeStorage-protected key as the device token; they are never synced and never returned by the local API (only `hasKey` + last 4).

## VoiceStudio

Voice cloning, design, dubbing and audiobooks run in a separately managed, unmodified VoiceStudio backend (AGPL-3.0)
installed from Voice Studio → Engine into `%LOCALAPPDATA%\Producer Studio\VoiceStudio`. See [voicestudio.md](voicestudio.md).

## Sync behaviour (summary)

See `apps/server/src/desktop/sync.ts`. Link adopts the cloud identity, mirrors workspaces with the same ids and merges
local-only workspaces (personal → cloud personal; others are created in the cloud). Merging moves voice profiles (with
their consent records) and the brand kit with the space; when the cloud space already has a brand kit, the cloud's stays
and this computer's is kept aside in a notice with "Use this computer's kit". Pull never overwrites a dirty local
project; cloud-advanced + local-dirty ⇒ conflict, as does a 409 on push. Resolve: keep-local (force-push over the latest
cloud version), keep-cloud, keep-both (local copy becomes "… (conflicted copy)"). Assets: local uploads are pushed with
the same id + sha256 and count as uploaded only once the cloud holds the file with that hash (an upload cut short gets a
fresh ticket for the same id and is sent again); cloud assets download on demand (202 while downloading, source sha256-verified) or eagerly with
"Download all". Exports (`origin: render`) stay local. Runs at start, every 60 s, 3 s after local saves; backs off
(5 s → 5 min) while offline.

- **A change that commits late is still delivered.** `change_seq` is taken at write time, so a slow transaction can
  commit after newer changes were read. Since schema v8 every change-writing transaction registers where its changes
  start (a shared advisory lock, see `DDL_V8`), and the feed returns `safe`: the point below every transaction still
  in flight. The desktop pages with `cursor` and resumes from `safe` (what lies between is delivered again, harmlessly),
  so nothing is skipped. Against an older cloud it keeps the old 25-change lookback.
- **A delete never comes back to bite.** The change feed leaves out a tombstone whose id exists again in your spaces
  (a project kept here after a cloud delete and created anew), so a re-delivered page can't delete it a second time.
- **Trash, restore and template flags** changed in the cloud are applied here even though they don't bump the version
  (a flag toggled here since the last sync stays ours and is pushed).
- **Deletes are guarded.** A project deleted here is deleted in the cloud with `POST /api/sync/projects/:id/delete
  {baseVersion, trashed}`, which succeeds only while the cloud copy is still the version this computer last saw (and
  still in the trash, if it saw it there). Edited in the cloud since, taken out of the trash, or no longer yours to
  delete: the cloud copy is kept, comes back here, and the sync menu says so under "Kept safe" (Got it dismisses).
- **Linking a different account never merges the previous one's spaces.** They stay on this computer, untouched
  (their sync state and pull cursor are kept under `parkedAccounts`), but don't sync with the new account and are
  never merged into it, so colleagues' projects and footage can't end up in someone else's account; a notice names
  them. Linking the earlier account again syncs them from where they stopped (and sets the other account's aside).
  We chose this over deleting them (unsynced work would be lost) or asking at link time (a decision most people
  can't make well mid-link).
- **Losing a space keeps what only exists here.** When the cloud says you left a space (removed, or it was deleted),
  projects with changes that never synced (or in conflict), clips never uploaded, the clips those projects use and
  their renders when the files are here, and voices made here move to a new local-only space "Recovered from …"
  first (never synced, never merged into an account at link time), with a notice. The rest goes as before. Deleting a
  space yourself recovers nothing.
- **Slow links.** Cloud calls give up only when nothing has moved for 60 s (request body, reply or download), not
  after a fixed total time, so a 64 MB project save or a big page finishes however long it takes; a stalled transfer is
  "offline", never an empty answer. Change-feed pages end at about `maxBytes` of JSON (4 MB by default; at least one
  change), and the desktop halves that after a page that didn't arrive, growing back as pages do.
- **Tombstones can be compacted (schema v18).** `services/tombstones.ts compactTombstones(days)` deletes old tombstones
  (on a desktop never one its own push hasn't sent); deleting any raises the feed's horizon (`sync_horizon`, a
  trigger). A desktop whose cursor is below it gets `resync: true`, pulls everything again from 0 and drops what the
  cloud no longer has; a project edited here is kept and pushed again as new. Older desktops still get their pages.
- **One lock.** Link, unlink, a conflict choice, a notice's offer, space changes through the cloud and every cycle run
  one at a time (`desktop/lock.ts`). Unlinking stops the cycle under way instead of waiting for it.
- **Back online at once.** While offline, the desktop asks the cloud's `/api/health` every 5 s (a Wi-Fi sign-in page
  doesn't count) and syncs as soon as it answers; the app's `online` event (`POST /api/sync/online`) does the same.
- **Uploads.** Small clips (up to 16 MB) go first, then projects; bigger files are announced to the cloud (listed as
  uploading) and go up after the cycle, three at a time, outside the lock, with bytes in `SyncStatus.uploads`. A file
  cut short starts again from its first byte; `desktop/uploads.ts setFileSender` is where a resumable protocol
  plugs in.
- **The sync panel** (sync menu → Details): why sync is held up (`SyncStatus.blocked`: signed out, offline,
  credentials, cloud storage failing, low disk, a conflict, automatic sync off), uploads with bytes, each conflict
  side by side (`GET /api/sync/conflicts/:id`), and everything still to sync (`GET /api/sync/items`) with Retry and Skip.
- **First link.** Settings → Account shows what linking would do before anything changes
  (`POST /api/sync/link/preview`): each space here with its projects, clips and bytes to upload, where it goes (merge
  into one of your cloud spaces, create it in the cloud, or keep it on this computer only), and another account's
  spaces that would be set aside. `POST /api/sync/link {previewId, choices}` links as chosen; the preview's device
  link lapses after 10 minutes unless used, and Cancel removes it.
- **Available offline.** A project's menu → Keep available offline downloads every clip it uses (original, proxy,
  thumbnail, filmstrip, waveform) and keeps them current after each sync; the library badges it, and badges clips
  whose files are only in the cloud (`GET/PUT /api/sync/offline`). Stopping keeps what was downloaded.
- **Brand kits and fonts.** A space's other brand kits and its font files sync both ways (font files are fetched as
  they arrive). The space's own settings (pronunciations, sample project) and each member's settings (favourite voices,
  Voice Studio draft, onboarding) stay in the cloud; the media trash follows the cloud's for clips from the cloud.
- **Comments and activity** aren't copied to the desktop. For a project or space in the cloud, the desktop reads and
  writes them in the cloud and passes on the cloud's live `comment` updates while they're open; offline they say they
  need the connection (nothing is queued). Unlinked, comments stay on this computer as before.
- **An item that keeps failing never blocks the rest.** Any push error other than "offline" or "signed out" (too
  large, a role change, an id taken elsewhere, a server error) is recorded for that one item in
  `desktop_sync_failures` and the cycle carries on. The item is retried on its own backoff (1, 2, 4 … min, at most
  hourly). The sync menu lists it under "Couldn’t sync" with the reason, **Retry** (now) and **Skip** (stop trying;
  it stays on this computer and no longer counts as pending, until Retry).

## Known gaps

- Builds are unsigned until the owner sets up signing (see "Code signing"). Linux packages are configured but not yet
  built on Linux; macOS is prepared (config, entitlements, notarisation switch) but needs a Mac and an Apple account.
  On Linux the AppImage relies on unprivileged user namespaces for Chromium's sandbox (Ubuntu 24.04+ restricts them
  through AppArmor); the .deb installs Electron's chrome-sandbox helper instead. A real build must check both.
- Moving the data folder on macOS/Linux also moves VoiceStudio (it lives inside the data folder there), whose Python
  environment may need reinstalling afterwards. On Windows VoiceStudio has its own folder in Local AppData.
- Brand-kit conflicts are last-writer-wins (local edits since the last sync win until pushed).
- Assets are uploaded in one request per file: a big file cut short starts again from its first byte (the resumable
  multipart protocol plugs in at `desktop/uploads.ts`).
- The Kokoro model is the quantized ONNX only; whisper is `small.en` (English).
