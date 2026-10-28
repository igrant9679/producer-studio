// APP-17: one tooltip per control. A sidebar link showing its label gets no tip repeating it (the collapsed sidebar
// does), but a tip that says something else (a viewer's "Only owners and editors…") still shows.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipLayer } from './tooltip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function hover(el: Element) {
  fireEvent.pointerOver(el)
  act(() => void vi.advanceTimersByTime(400))
}

describe('the tooltip layer', () => {
  it('skips a tip that only repeats the label on show, and shows one that adds something', () => {
    vi.useFakeTimers()
    render(
      <>
        <TooltipLayer />
        <a href="/library" data-tip="Library" aria-label="Library">
          <span className="ps-nav-text">Library</span>
        </a>
        <button data-tip="Only owners and editors can do this." aria-label="Create new">
          <span className="ps-nav-text">Create new</span>
        </button>
        <a href="/brand" data-tip="Brand kit" aria-label="Brand kit">
          <span className="ps-nav-text" style={{ display: 'none' }}>Brand kit</span>
        </a>
      </>,
    )
    hover(screen.getByRole('link', { name: 'Library' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
    hover(screen.getByRole('button', { name: 'Create new' }))
    expect(screen.getByRole('tooltip').textContent).toBe('Only owners and editors can do this.')
    // the collapsed sidebar hides the label: then the tip is the label
    hover(screen.getByRole('link', { name: 'Brand kit' }))
    expect(screen.getByRole('tooltip').textContent).toBe('Brand kit')
  })
})
