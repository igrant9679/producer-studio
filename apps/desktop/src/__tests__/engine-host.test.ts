// The engine in a utility process so the build's fuses can turn off the Node-mode switches (D-12).
import { describe, expect, it } from 'vitest'
import { STOP_MESSAGE, engineEnv, engineHost, utilityLaunch } from '../engine-host'

describe('how the engine is hosted (D-12)', () => {
  it('packaged builds use a utility process, dev a Node child; PS_ENGINE_HOST overrides', () => {
    expect(engineHost({ packaged: true, env: {} })).toBe('utility')
    expect(engineHost({ packaged: false, env: {} })).toBe('child')
    expect(engineHost({ packaged: true, env: { PS_ENGINE_HOST: 'child' } })).toBe('child')
    expect(engineHost({ packaged: false, env: { PS_ENGINE_HOST: 'utility' } })).toBe('utility')
    expect(engineHost({ packaged: true, env: { PS_ENGINE_HOST: 'node' } })).toBe('utility')
  })

  it('a utility process never gets ELECTRON_RUN_AS_NODE and learns of its parent through the port', () => {
    const base = { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', DESKTOP_PARENT_STDIN: '1', MODE: 'desktop' }
    expect(engineEnv(base, 'utility')).toEqual({ PATH: 'p', MODE: 'desktop', DESKTOP_PARENT_PORT: '1' })
    expect(engineEnv(base, 'child')).toEqual({ PATH: 'p', MODE: 'desktop', ELECTRON_RUN_AS_NODE: '1', DESKTOP_PARENT_STDIN: '1' })
    // the caller's object is left as it was
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('splits a Node command line into the script, its arguments and Node options', () => {
    expect(utilityLaunch(['C:\\app\\resources\\server\\server.mjs'])).toEqual({ modulePath: 'C:\\app\\resources\\server\\server.mjs', args: [], execArgv: [] })
    expect(utilityLaunch(['--import', 'file:///tsx/esm.mjs', 'src/index.ts', '--flag'])).toEqual({ modulePath: 'src/index.ts', args: ['--flag'], execArgv: ['--import', 'file:///tsx/esm.mjs'] })
    expect(utilityLaunch(['--import=file:///x.mjs', 'main.mjs'])).toEqual({ modulePath: 'main.mjs', args: [], execArgv: ['--import=file:///x.mjs'] })
    expect(() => utilityLaunch(['--import', 'x'])).toThrow(/No engine script/)
  })

  it('asks the engine to stop with the message the server listens for', () => {
    expect(STOP_MESSAGE).toEqual({ type: 'stop' })
  })
})
