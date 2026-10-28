// A big library's grid (A-15) draws only the rows in view, and keeps Home / End / arrow keys moving between cards.
// jsdom has no layout: the sizes a browser would measure are given here.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VirtualGrid } from '../library/VirtualGrid'

const items = Array.from({ length: 1000 }, (_, i) => `card ${i}`)
const saved: Record<string, PropertyDescriptor | undefined> = {}
const fake = (name: 'clientWidth' | 'clientHeight' | 'offsetHeight', value: number) => {
  saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value })
}

beforeEach(() => {
  // a 1,000 px wide grid (4 columns), 800 px in view, cards 182 px tall (+ 18 px gap = a 200 px row)
  fake('clientWidth', 1000)
  fake('clientHeight', 800)
  fake('offsetHeight', 182)
})
afterEach(() => {
  cleanup()
  for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(HTMLElement.prototype, k, d)
})

function grid() {
  return render(
    <div className="ps-content" data-testid="scroller" style={{ overflowY: 'auto' }}>
      <VirtualGrid items={items} keyOf={(t) => t} label="Cards" render={(t) => <div role="button" tabIndex={0} data-card={t}>{t}</div>} />
    </div>,
  )
}

describe('<VirtualGrid> (A-15)', () => {
  it('draws the rows in view and leaves room for the rest; scrolling moves the window', () => {
    grid()
    const cells = () => screen.getAllByRole('listitem')
    expect(cells().length).toBeLessThan(60)
    expect(cells()[0].textContent).toBe('card 0')
    const list = screen.getByRole('list', { name: 'Cards' })
    expect(list.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))')
    expect(parseFloat(list.style.paddingBottom)).toBeGreaterThan(40_000)
    const scroller = screen.getByTestId('scroller')
    // the grid moves up the page as the area scrolls
    list.getBoundingClientRect = () => ({ top: -scroller.scrollTop }) as DOMRect
    act(() => {
      scroller.scrollTop = 100 * 200
      fireEvent.scroll(scroller)
    })
    expect(cells()[0].textContent).toBe(`card ${98 * 4}`)
    expect(cells().some((c) => c.textContent === 'card 0')).toBe(false)
    expect(parseFloat(list.style.paddingTop)).toBe(98 * 200)
  })

  it('a small list is a plain grid with every card', () => {
    render(
      <div className="ps-content">
        <VirtualGrid items={items.slice(0, 30)} keyOf={(t) => t} render={(t) => <div data-card={t} tabIndex={0}>{t}</div>} />
      </div>,
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(30)
    expect(screen.getByRole('list').getAttribute('style')).toBeNull()
  })

  it('arrow keys move by a card or a row, Home and End to the ends', () => {
    grid()
    const first = screen.getByText('card 0')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('card 4')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement?.textContent).toBe('card 5')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement?.textContent).toBe('card 1')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement?.textContent).toBe('card 0')
  })
})
