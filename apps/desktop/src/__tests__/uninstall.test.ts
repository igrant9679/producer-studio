// The uninstaller offers to remove the VoiceStudio runtime and the app's data, safely (D-15). NSIS can't run here, so
// this checks the script electron-builder includes says what it must.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const nsh = fs.readFileSync(path.join(root, 'installer', 'uninstall.nsh'), 'utf8').replace(/\r\n/g, '\n')
const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
const code = nsh
  .split('\n')
  .filter((l) => !/^\s*;/.test(l))
  .join('\n')

describe('the uninstaller’s clean-up choices (D-15)', () => {
  it('is included in the NSIS build as electron-builder’s customUnInstall hook', () => {
    expect(yml).toMatch(/^nsis:\n(?: {2}.*\n)*? {2}include: installer\/uninstall\.nsh$/m)
    expect(yml).toMatch(/deleteAppDataOnUninstall: false/)
    expect(code).toMatch(/^!macro customUnInstall\n[\s\S]*\n!macroend\n?$/)
  })

  it('never runs during an update, and every question answers No in a silent uninstall and by default', () => {
    expect(code.trim().split('\n')[1].trim()).toBe('${ifNot} ${isUpdated}')
    const asks = code.split('\n').filter((l) => l.includes('MessageBox'))
    expect(asks).toHaveLength(2)
    for (const a of asks) {
      expect(a).toContain('MB_YESNO')
      expect(a).toContain('MB_DEFBUTTON2')
      expect(a).toMatch(/\/SD IDNO IDNO \w+$/)
    }
  })

  it('removes VoiceStudio only if it is there, and data only after a warning about unsynced projects', () => {
    expect(code).toMatch(/IfFileExists "\$LOCALAPPDATA\\Producer Studio\\VoiceStudio\\\*\.\*" 0 ps_skip_voicestudio/)
    expect(code).toMatch(/RMDir \/r "\$LOCALAPPDATA\\Producer Studio\\VoiceStudio"/)
    expect(code).toMatch(/aren't synced to your cloud account are lost for good/)
    // every removal sits after its question: a No jumps past it
    const lines = code.split('\n').map((l) => l.trim())
    const rm = lines.map((l, i) => (l.startsWith('RMDir') ? i : -1)).filter((i) => i >= 0)
    expect(rm).toHaveLength(3)
    const ask = lines.findIndex((l) => l.includes('delete your Producer Studio data'))
    expect(rm.slice(1).every((i) => i > ask && i < lines.indexOf('ps_keep_data:'))).toBe(true)
    // nothing outside these folders
    for (const i of rm) expect(lines[i]).toMatch(/^RMDir \/r "\$(LOCALAPPDATA|APPDATA)\\Producer Studio(\\VoiceStudio)?"$/)
  })
})
