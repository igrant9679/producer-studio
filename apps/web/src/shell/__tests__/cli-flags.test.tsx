// Settings → AI on the desktop lists the Claude Code CLI's options: which it detected and which it passes (D-16).
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ClaudeCliInfo } from '@producer/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCliFlags } from '../pages/ClaudeCliFlags'

afterEach(cleanup)

const flag = (flag: string, detected: boolean, used: boolean, required = false, when: ClaudeCliInfo['flags'][number]['when'] = 'every run') => ({ flag, detected, used, required, when, purpose: `What ${flag} does for you.` })

const current: ClaudeCliInfo = {
  path: 'C:\\Users\\sam\\.local\\bin\\claude.exe',
  source: 'local-bin',
  version: '2.1.280',
  flags: [flag('--permission-mode', true, true, true), flag('--setting-sources', true, true, true), flag('--no-session-persistence', true, true), flag('--json-schema', false, false, false, 'Producer script')],
}

describe('Claude Code options in Settings → AI (D-16)', () => {
  it('summarises how many are used and lists each with detected, used and what it does', () => {
    render(<ClaudeCliFlags cli={current} />)
    const summary = screen.getByText(/Claude Code options · 3 of 4 used/)
    // a disclosure: opens from the keyboard like any <details>
    expect(summary.tagName).toBe('SUMMARY')
    fireEvent.click(summary)
    const table = screen.getByRole('table', { name: 'Claude Code options detected and used' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Option', 'Detected', 'Used', 'On', 'What it does'])
    const row = within(table).getByRole('row', { name: /--json-schema/ })
    expect(within(row).getAllByRole('cell').map((c) => c.textContent?.trim())).toEqual(['no', 'no', 'Producer script', 'What --json-schema does for you.'])
    expect(within(within(table).getByRole('row', { name: /--permission-mode/ })).getByText(/required/)).toBeTruthy()
    // where it was found, and which version
    expect(screen.getByText(/Claude Code 2\.1\.280 at/)).toBeTruthy()
    expect(screen.getByText(current.path)).toBeTruthy()
    expect(screen.getByText(/found through ~\/\.local\/bin/)).toBeTruthy()
  })

  it('an old CLI says which required options are missing', () => {
    render(<ClaudeCliFlags cli={{ ...current, flags: [flag('--permission-mode', false, false, true), flag('--setting-sources', false, false, true), flag('--json-schema', true, false, false, 'Producer script')] }} />)
    expect(screen.getByText(/0 of 3 used · 2 required missing/)).toBeTruthy()
  })

  it('a CLI that did not list its options in time says the options are not known yet', () => {
    render(<ClaudeCliFlags cli={{ ...current, optionsUnknown: true, flags: current.flags.map((f) => ({ ...f, detected: false, used: false })) }} />)
    expect(screen.getByText(/Claude Code options · not known yet/)).toBeTruthy()
    expect(screen.getByText(/checked again next time/)).toBeTruthy()
    expect(screen.getAllByText('unknown')).toHaveLength(current.flags.length)
  })
})
