import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_PREFERENCES } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppearance } from '../../lib/appearance'
import { AppearanceSettings, ThemeSwitcher } from '../pages/AppearanceSettings'

const html = () => document.documentElement

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ media: q, matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  localStorage.clear()
  useAppearance.getState().reset()
})
afterEach(cleanup)

describe('<AppearanceSettings>', () => {
  it('renders every control with the current values', () => {
    render(<AppearanceSettings />)
    expect(screen.getAllByRole('radio', { name: /system|dark|light/i }).map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Coral' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: 'Comfortable' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Reduce motion' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('text-sample')).toBeTruthy()
    expect((screen.getByRole('button', { name: /reset to defaults/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('applies each change instantly to <html>', () => {
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('radio', { name: /^light/i }))
    expect(html().dataset.theme).toBe('light')
    fireEvent.click(screen.getByRole('button', { name: 'Extra large' }))
    expect(html().style.getPropertyValue('--ui-scale')).toBe('1.25')
    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }))
    expect(html().dataset.accent).toBe('teal')
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
    expect(html().dataset.density).toBe('compact')
    fireEvent.click(screen.getByRole('switch', { name: 'Reduce motion' }))
    expect(html().dataset.reduceMotion).toBe('true')
    expect(screen.getByRole('radio', { name: /^light/i }).getAttribute('aria-checked')).toBe('true')

    const reset = screen.getByRole('button', { name: /reset to defaults/i }) as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    fireEvent.click(reset)
    expect(useAppearance.getState().prefs).toEqual(DEFAULT_PREFERENCES)
    expect(html().dataset.accent).toBe('coral')
    expect(html().style.getPropertyValue('--ui-scale')).toBe('1')
  })
})

describe('<ThemeSwitcher>', () => {
  it('switches the theme from the menu control', () => {
    render(<ThemeSwitcher />)
    fireEvent.click(screen.getByRole('radio', { name: 'Dark theme' }))
    expect(useAppearance.getState().prefs.theme).toBe('dark')
    expect(html().dataset.theme).toBe('dark')
    expect(screen.getByRole('radio', { name: 'Dark theme' }).getAttribute('aria-checked')).toBe('true')
  })
})
