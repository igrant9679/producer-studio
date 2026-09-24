import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthPage, safeNext, validateAuth } from '../AuthPage'

afterEach(cleanup)

describe('validateAuth', () => {
  it('requires name, valid email and an 8+ char password on signup', () => {
    expect(validateAuth('signup', { name: '', email: 'nope', password: 'short' })).toEqual({
      name: expect.any(String),
      email: expect.stringContaining('email'),
      password: expect.stringContaining('8'),
    })
    expect(validateAuth('signup', { name: 'Jo', email: 'jo@example.com', password: '12345678' })).toEqual({})
  })

  it('does not enforce length or name on login', () => {
    expect(validateAuth('login', { name: '', email: 'jo@example.com', password: 'x' })).toEqual({})
    expect(validateAuth('login', { name: '', email: '', password: '' })).toEqual({ email: expect.any(String), password: expect.any(String) })
  })
})

describe('safeNext', () => {
  it('only allows same-origin relative paths', () => {
    expect(safeNext('/library?q=a')).toBe('/library?q=a')
    expect(safeNext(null)).toBe('/')
    expect(safeNext('https://evil.test')).toBe('/')
    expect(safeNext('//evil.test/x')).toBe('/')
    expect(safeNext('/login')).toBe('/')
  })
})

describe('<AuthPage>', () => {
  it('shows field errors instead of submitting an invalid signup', () => {
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <AuthPage mode="signup" />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jo@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))
    expect(screen.getByText('Use at least 8 characters')).toBeTruthy()
    expect(screen.getByText('Tell us what to call you')).toBeTruthy()
  })

  it('links between sign in and sign up, preserving ?next', () => {
    render(
      <MemoryRouter initialEntries={['/login?next=%2Fvoice']}>
        <AuthPage mode="login" />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: /create an account/i })
    expect(link.getAttribute('href')).toBe('/signup?next=%2Fvoice')
  })
})
