// APP-16: modals are real dialogs. Focus moves in, stays in, and comes back; they have a name; Escape closes only
// the topmost one; a destructive confirmation opens on Cancel.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog, MenuList, Modal, Popover } from '../ui'

afterEach(cleanup)

function Opener({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open it</button>
      <button>Something behind</button>
      {open && children(() => setOpen(false))}
    </>
  )
}

const escape = (el: Element = document.activeElement ?? document.body) => fireEvent.keyDown(el, { key: 'Escape' })

describe('<Modal>', () => {
  it('is named by its title and described by its subtitle', () => {
    render(<Modal title="Rename space" subtitle="Everyone sees the new name." onClose={() => undefined}><input aria-label="Name" /></Modal>)
    const dialog = screen.getByRole('dialog', { name: 'Rename space' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-describedby') && document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('Everyone sees the new name.')
  })

  it('takes a label when it has no title', () => {
    render(<Modal label="Video preview" onClose={() => undefined}><video /></Modal>)
    expect(screen.getByRole('dialog', { name: 'Video preview' })).toBeTruthy()
  })

  it('moves focus in on open, to the first control of its body', () => {
    render(<Opener>{(close) => <Modal title="Invite" onClose={close} footer={<button>Done</button>}><input aria-label="Email" /></Modal>}</Opener>)
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Email'))
  })

  it('keeps Tab and Shift+Tab inside', () => {
    render(<Opener>{(close) => <Modal title="Invite" onClose={close} footer={<button>Done</button>}><input aria-label="Email" /></Modal>}</Opener>)
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    const close = screen.getByRole('button', { name: 'Close' })
    const done = screen.getByRole('button', { name: 'Done' })
    done.focus()
    fireEvent.keyDown(done, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(done)
  })

  it('pulls focus back when it wanders behind the dialog', () => {
    render(<Opener>{(close) => <Modal title="Invite" onClose={close}><input aria-label="Email" /></Modal>}</Opener>)
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    act(() => screen.getByRole('button', { name: 'Something behind' }).focus())
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('gives focus back to what opened it', () => {
    render(<Opener>{(close) => <Modal title="Invite" onClose={close}><input aria-label="Email" /></Modal>}</Opener>)
    const opener = screen.getByRole('button', { name: 'Open it' })
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).not.toBe(opener)
    escape()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('closes only the topmost dialog on Escape', () => {
    const outerClose = vi.fn()
    function Nested() {
      const [inner, setInner] = useState(true)
      return (
        <Modal title="Outer" onClose={outerClose}>
          <button>Outer button</button>
          {inner && (
            <Modal title="Inner" onClose={() => setInner(false)}>
              <button>Inner button</button>
            </Modal>
          )}
        </Modal>
      )
    }
    render(<Nested />)
    escape()
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy()
    expect(outerClose).not.toHaveBeenCalled()
    escape()
    expect(outerClose).toHaveBeenCalledTimes(1)
  })

  it('lets a menu inside it close first', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Members" onClose={onClose}>
        <Popover trigger={({ toggle, open }) => <button onClick={toggle} aria-expanded={open}>Role</button>}>
          {(close) => <MenuList close={close} items={[{ label: 'Editor' }, { label: 'Viewer' }]} />}
        </Popover>
      </Modal>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Role' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    escape()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Role' }))
  })
})

describe('<ConfirmDialog>', () => {
  it('opens a destructive confirmation on Cancel, so Enter cancels', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<ConfirmDialog title="Delete this project forever?" body="This can’t be undone." confirmLabel="Delete forever" onConfirm={onConfirm} onClose={onClose} />)
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this project forever?' })
    expect(dialog).toBeTruthy()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(document.activeElement).toBe(cancel)
    // Enter on a focused button clicks it
    fireEvent.click(document.activeElement!)
    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('opens a harmless one on its confirm button', () => {
    render(<ConfirmDialog danger={false} title="Use this template?" confirmLabel="Use it" onConfirm={() => undefined} onClose={() => undefined} />)
    expect(screen.getByRole('dialog', { name: 'Use this template?' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Use it' }))
  })
})
