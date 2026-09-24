// Producer Studio desktop — Electron main process.
// Boots the local server (MODE=desktop) as a child, opens a per-launch session for the one local user, then loads
// the same web UI the cloud serves, from http://127.0.0.1:<port>. Renderers are sandboxed with context isolation;
// the preload exposes a version, the platform and three validated functions; navigation never leaves the local origin.
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { isDev } from './paths'
import { SECURE_PREFS, hardenContents, hardenSession, insideDataDir, isLocal, nativeThemeMode, openExternal, setLocalOrigin } from './security'
import { ServerProcess } from './server'

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
  // window + taskbar icon (packaged: inside app.asar next to dist/; dev: apps/desktop/assets)
  const appIcon = [path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), path.join(__dirname, '..', 'assets', 'icon.png')].find((p) => fs.existsSync(p))

  const logFile = () => path.join(app.getPath('userData'), 'logs', 'main.log')
  const logLine = (msg: string) => {
    try {
      fs.mkdirSync(path.dirname(logFile()), { recursive: true })
      fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`)
    } catch {
      /* logging must never throw */
    }
  }

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
      if (mainWin === w) mainWin = undefined
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

  async function startServer(): Promise<boolean> {
    server ??= new ServerProcess()
    for (;;) {
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
    if (quitting || restarting) return
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

  app.on('web-contents-created', (_e, wc) => hardenContents(wc))

  app.on('second-instance', () => {
    if (!mainWin) return
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
    if (!(await startServer())) return
    server!.on('crash', (code) => void onCrash(code))
    menu()
    mainWin = createMain(server!.origin)
  })
}
