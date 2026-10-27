import { cleanup, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTER_FUTURE } from './router'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const app = (
  <Routes>
    <Route path="/*" element={<span>shell</span>} />
  </Routes>
)
const futureWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((c) => String(c[0]).includes('Future Flag'))

describe('router future flags', () => {
  // React Router warns once per flag per process, so the flagged render has to come first.
  it('render without the v7 upgrade warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<MemoryRouter future={ROUTER_FUTURE}>{app}</MemoryRouter>)
    expect(futureWarnings(warn)).toEqual([])
  })

  it('(the check sees both warnings when the flags are off)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<MemoryRouter>{app}</MemoryRouter>)
    expect(futureWarnings(warn).length).toBe(2)
  })
})
