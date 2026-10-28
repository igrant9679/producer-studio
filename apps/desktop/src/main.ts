// Producer Studio desktop — Electron main process.
// Boots the local server (MODE=desktop) as a child, opens a per-launch session for the one local user, then loads
// the same web UI the cloud serves, from http://127.0.0.1:<port>. Renderers are sandboxed with context isolation;
// the preload exposes a version, the platform and three validated functions; navigation never leaves the local origin.
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { isDev } from './paths'
import { dataDirProblem, defaultDataDir, moveDataDir, moveProblem, writeSettings } from './datadir'
import { setupDictation } from './dictation'
import { deviceKey, keystoreProblem, resetDeviceKey } from './keystore'
import { RotatingLog } from './logs'
import { SECURE_PREFS, hardenContents, hardenSession, insideDataDir, isLocal, nativeThemeMode, openExternal, setLocalOrigin } from './security'
import { ServerProcess, dataDirEnv, desktopPaths } from './server'

app.enableSandbox()
app.setAppUserModelId('studio.producer.desktop')
// throwaway profiles for testing (dev and packaged): PS_USER_DATA=<dir>
if (process.env.PS_USER_DATA) app.setPath('userData', path.resolve(process.env.PS_USER_DATA))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let server: ServerProcess | undefined
  let mainWin: BrowserWindow | undefined
  let splash: BrowserWindow | undefined
  let quitting = false
  let serverStopped = false
  let restarting = false
  /** The data folder is being moved: the engine is stopped on purpose. */
  let moving = false
  // window + taskbar icon (packaged: inside app.asar next to dist/; dev: apps/desktop/assets)
  const appIcon = [path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), path.join(__dirname, '..', 'assets', 'icon.png')].find((p) => fs.existsSync(p))

  // rotated by size while the app runs, not only at launch
  const mainLog = new RotatingLog(path.join(app.getPath('userData'), 'logs', 'main.log'))
  const logLine = (msg: string) => mainLog.write(`${new Date().toISOString()} ${msg}\n`)

  function createSplash() {
    const w = new BrowserWindow({
      width: 420,
      height: 260,
      frame: false,
      resizable: false,
      movable: true,
      show: false,
      center: true,
      backgroundColor: '#0c0e14',
      skipTaskbar: false,
      title: 'Producer Studio',
      ...(appIcon ? { icon: appIcon } : {}),
      webPreferences: { ...SECURE_PREFS },
    })
    w.once('ready-to-show', () => w.show())
    void w.loadFile(path.join(__dirname, 'splash.html'))
    return w
  }

  function createMain(origin: string) {
    const w = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 640,
      show: false,
      backgroundColor: '#0c0e14',
      title: 'Producer Studio',
      ...(appIcon ? { icon: appIcon } : {}),
      webPreferences: {
        ...SECURE_PREFS,
        preload: path.join(__dirname, 'preload.cjs'),
        additionalArguments: [`--ps-version=${app.getVersion()}`],
        devTools: isDev || process.env.PS_DEVTOOLS === '1',
        spellcheck: true,
      },
    })
    w.once('ready-to-show', () => {
      w.show()
      splash?.close()
      splash = undefined
    })
    // "Sign out" in the web UI lands on /login; the desktop has one local user, so just open a fresh session
    const onNav = (_e: unknown, url: string) => {
      if (isLocal(url) && new URL(url).pathname === '/login') void reconnect('/')
    }
    w.webContents.on('did-navigate', onNav)
    w.webContents.on('did-navigate-in-page', onNav)
    w.on('closed', () => {
      if (mainWin !== w) return
      mainWin = undefined
      // the app has no tray: closing its window quits it, even when the dictation widget (a window of its own) is
      // still around; otherwise the engine, VoiceStudio and the shortcut would keep running unseen
      if (!quitting) app.quit()
    })
    void w.loadURL(`${origin}/`)
    return w
  }

  const messageBox = (o: Electron.MessageBoxOptions) => (mainWin ? dialog.showMessageBox(mainWin, o) : dialog.showMessageBox(o))

  async function setSessionCookie() {
    const s = await server!.session()
    await session.defaultSession.cookies.set({ url: server!.origin, name: 'ps_session', value: s.token, httpOnly: true, secure: false, sameSite: 'lax', expirationDate: Math.floor(s.expiresAt / 1000) })
  }

  async function reconnect(route = '/') {
    if (!server) return
    await setSessionCookie()
    await mainWin?.loadURL(`${server.origin}${route}`)
  }

  /**
   * The saved keys (cloud device token, AI keys) can't be unlocked: say so instead of quietly replacing them. Returns
   * false when the person chose Quit. "Start over" makes a new key; the old keystore stays in its backup copy.
   */
  async function checkKeystore(): Promise<boolean> {
    deviceKey()
    const p = keystoreProblem()
    if (!p) return true
    logLine(`keystore could not be read: ${p.error} (file ${p.file}, copy ${p.backup ?? 'not made'})`)
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: 'Producer Studio',
      message: 'Producer Studio couldn’t unlock its saved keys.',
      detail: [
        `The system key store couldn’t decrypt ${p.file} (${p.error}).`,
        'Until it can, your cloud link and saved AI keys can’t be read: sync will ask you to link again, and AI keys need entering again.',
        p.backup ? `Nothing has been deleted. A copy is kept at ${p.backup}.` : 'Nothing has been deleted.',
        'If this is temporary (for example a locked keychain), quit and open Producer Studio again. “Start over” makes a new key.',
      ].join('\n\n'),
      buttons: ['Continue', 'Start over with a new key', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    })
    if (r.response === 2) {
      quitting = true
      app.quit()
      return false
    }
    if (r.response === 1) {
      try {
        resetDeviceKey()
        logLine('keystore: started over with a new key')
      } catch (err) {
        logLine(`keystore: could not start over: ${(err as Error).message}`)
        dialog.showErrorBox('Producer Studio', `Couldn’t start over with a new key: ${(err as Error).message}`)
      }
    }
    return true
  }

  /**
   * The data folder must be reachable before the engine starts. When it isn't (a drive that isn't connected), say so
   * and offer the default folder instead of failing to start. False when the person chose Quit.
   */
  async function checkDataDir(): Promise<boolean> {
    for (;;) {
      const p = desktopPaths()
      const problem = dataDirProblem(p.dataDir)
      if (!problem) return true
      logLine(`data folder unavailable: ${p.dataDir} (${problem})`)
      const fallback = defaultDataDir(dataDirEnv())
      const other = path.resolve(fallback) !== path.resolve(p.dataDir)
      const r = await dialog.showMessageBox({
        type: 'warning',
        title: 'Producer Studio',
        message: 'Producer Studio can’t open its data folder.',
        detail: [
          `${p.dataDir}: ${problem}.`,
          'If it’s on a drive that isn’t connected, connect it and choose Try again.',
          other ? `“Use the default data folder” starts with ${fallback} instead. Nothing in the other folder is touched, and you can switch back in Settings.` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        buttons: other ? ['Try again', 'Use the default data folder', 'Quit'] : ['Try again', 'Quit'],
        defaultId: 0,
        cancelId: other ? 2 : 1,
      })
      if (r.response === (other ? 2 : 1)) {
        quitting = true
        app.quit()
        return false
      }
      if (other && r.response === 1) {
        writeSettings(p.settingsFile, { dataDir: fallback })
        logLine(`data folder switched to the default: ${fallback}`)
      }
    }
  }

  async function startServer(): Promise<boolean> {
    for (;;) {
      if (!(await checkDataDir())) return false
      server ??= new ServerProcess()
      server.refreshPaths()
      try {
        await server.start()
        setLocalOrigin(server.origin)
        await setSessionCookie()
        logLine(`server ready at ${server.origin}`)
        return true
      } catch (err) {
        logLine(`server failed to start: ${(err as Error).message}`)
        const r = await dialog.showMessageBox({
          type: 'error',
          title: 'Producer Studio',
          message: 'Producer Studio couldn’t start its local engine.',
          detail: `${(err as Error).message}\n\nLogs: ${server.paths.logsDir}`,
          buttons: ['Try again', 'Open logs', 'Quit'],
          defaultId: 0,
          cancelId: 2,
        })
        if (r.response === 1) void shell.openPath(server.paths.logsDir)
        if (r.response !== 0) {
          quitting = true
          app.quit()
          return false
        }
        await server.stop()
      }
    }
  }

  async function onCrash(code: unknown) {
    if (quitting || restarting || moving) return
    restarting = true
    logLine(`server crashed (${String(code)})`)
    try {
      const r = await messageBox({
        type: 'error',
        title: 'Producer Studio',
        message: 'The Producer Studio engine stopped unexpectedly.',
        detail: 'Your projects are saved locally. Restart the engine to keep working.',
        buttons: ['Restart', 'Open logs', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      })
      if (r.response === 1) void shell.openPath(server!.paths.logsDir)
      if (r.response === 2) {
        quitting = true
        app.quit()
        return
      }
      if (await startServer()) await mainWin?.loadURL(`${server!.origin}/`)
    } finally {
      restarting = false
    }
  }

  async function about() {
    let sys: { version?: string; ai?: { detail?: string } } = {}
    try {
      sys = await (await fetch(`${server!.origin}/api/system`)).json()
    } catch {
      /* engine down */
    }
    await messageBox({
      type: 'info',
      title: 'About Producer Studio',
      message: `Producer Studio ${app.getVersion()}`,
      detail: [
        `Local engine ${sys.version ?? 'not running'}`,
        `AI: ${sys.ai?.detail ?? 'unknown'}`,
        `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
        `Data: ${server?.paths.dataDir ?? ''}`,
      ].join('\n'),
      buttons: ['OK'],
    })
  }

  /**
   * Settings or File → Move data folder: pick a folder, stop the engine, copy everything there, check the copy, switch
   * to it, remove the old folder, start again. On any failure the old folder stays in use, untouched.
   */
  async function moveDataFolder(): Promise<{ ok: boolean; dataDir?: string; error?: string }> {
    if (!server || moving || restarting) return { ok: false, error: 'Producer Studio is busy; try again in a moment.' }
    const from = server.paths.dataDir
    const opts: Electron.OpenDialogOptions = { title: 'Move the data folder to…', properties: ['openDirectory', 'createDirectory'], defaultPath: path.dirname(from) }
    const pick = await (mainWin ? dialog.showOpenDialog(mainWin, opts) : dialog.showOpenDialog(opts))
    if (pick.canceled || !pick.filePaths[0]) return { ok: false }
    let to = pick.filePaths[0]
    // a folder with things in it already: the data goes in a new folder inside it
    if (fs.existsSync(to) && fs.readdirSync(to).length) to = path.join(to, 'Producer Studio data')
    const problem = moveProblem(from, to)
    if (problem) {
      await messageBox({ type: 'warning', title: 'Producer Studio', message: 'The data folder can’t move there.', detail: problem, buttons: ['OK'] })
      return { ok: false, error: problem }
    }
    const sure = await messageBox({
      type: 'question',
      title: 'Producer Studio',
      message: 'Move the data folder?',
      detail: `From ${from}\nto ${to}\n\nProducer Studio stops its engine, copies your projects, media and renders, checks the copy, switches to it and then removes the old folder. A large library takes a while: keep the app open until it’s done.`,
      buttons: ['Move', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    })
    if (sure.response !== 0) return { ok: false }
    moving = true
    let error: string | undefined
    let removedOld = true
    try {
      logLine(`moving the data folder: ${from} -> ${to}`)
      await server.stop()
      await mainWin?.loadFile(path.join(__dirname, 'splash.html'))
      const r = await moveDataDir(server.paths.settingsFile, from, to, (done, total) => mainWin?.setProgressBar(total ? done / total : 2))
      removedOld = r.removedOld
      logLine(`data folder moved${removedOld ? '' : ` (the old folder couldn’t be removed: ${from})`}`)
    } catch (err) {
      error = (err as Error).message
      logLine(`moving the data folder failed: ${error}`)
    } finally {
      mainWin?.setProgressBar(-1)
      moving = false
    }
    // on the new folder, or on the old one when the move failed
    if (await startServer()) await mainWin?.loadURL(`${server.origin}/settings`)
    if (error) {
      await messageBox({ type: 'error', title: 'Producer Studio', message: 'The data folder wasn’t moved.', detail: `${error}\n\nProducer Studio carries on with ${from}; nothing in it was changed.`, buttons: ['OK'] })
      return { ok: false, error }
    }
    if (!removedOld) await messageBox({ type: 'info', title: 'Producer Studio', message: 'The data folder was moved.', detail: `The old folder couldn’t be removed; you can delete it yourself: ${from}`, buttons: ['OK'] })
    return { ok: true, dataDir: to }
  }

  function menu() {
    const go = (route: string) => () => void mainWin?.loadURL(`${server!.origin}${route}`)
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'File',
        submenu: [
          { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: go('/') },
          { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: go('/settings') },
          { type: 'separator' },
          { label: 'Open data folder', click: () => void shell.openPath(server!.paths.dataDir) },
          { label: 'Move data folder…', click: () => void moveDataFolder() },
          { label: 'Open logs folder', click: () => void shell.openPath(server!.paths.logsDir) },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, ...(isDev ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'Check Claude sign-in', click: go('/settings#ai') },
          { label: 'Cloud sync', click: go('/settings#account') },
          { type: 'separator' },
          { label: 'About Producer Studio', click: () => void about() },
        ],
      },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  // ---- IPC: one validated handler per preload function, only for our own local pages ----
  ipcMain.handle('desktop:open-external', (e, url: unknown) => {
    if (!isLocal(e.senderFrame?.url ?? '')) return false
    return openExternal(url)
  })
  ipcMain.handle('desktop:show-item', (e, p: unknown) => {
    if (!isLocal(e.senderFrame?.url ?? '') || !server) return false
    const target = insideDataDir(p, server.paths.dataDir)
    if (!target) return false
    if (fs.statSync(target).isDirectory()) void shell.openPath(target)
    else shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle('desktop:move-data-folder', (e) => {
    if (!isLocal(e.senderFrame?.url ?? '')) return { ok: false, error: 'refused' }
    return moveDataFolder()
  })

  ipcMain.handle('desktop:set-native-theme', (e, mode: unknown) => {
    if (!isLocal(e.senderFrame?.url ?? '')) return false
    const m = nativeThemeMode(mode)
    if (!m) return false
    nativeTheme.themeSource = m
    // keep the window ground in step so resizes don't flash the other theme
    const w = BrowserWindow.fromWebContents(e.sender)
    w?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0c0e14' : '#f3f5f8')
    return true
  })

  const dictation = setupDictation({
    origin: () => server?.origin,
    isLocal,
    preload: path.join(__dirname, 'preload.cjs'),
    secure: { ...SECURE_PREFS, additionalArguments: [`--ps-version=${app.getVersion()}`] },
    log: logLine,
  })
  app.on('will-quit', () => dictation.dispose())

  app.on('web-contents-created', (_e, wc) => hardenContents(wc))

  app.on('second-instance', () => {
    // launched again while running: show the window, or open one if it was closed (never "nothing happens")
    if (!mainWin) {
      if (server?.running && !quitting) mainWin = createMain(server.origin)
      return
    }
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.focus()
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', (e) => {
    quitting = true
    if (serverStopped || !server) return
    e.preventDefault()
    void server.stop().finally(() => {
      serverStopped = true
      logLine('server stopped; quitting')
      app.quit()
    })
  })

  app.whenReady().then(async () => {
    hardenSession(session.defaultSession)
    splash = createSplash()
    if (!(await checkKeystore())) return
    if (!(await startServer())) return
    server!.on('crash', (code) => void onCrash(code))
    menu()
    mainWin = createMain(server!.origin)
  })
}
