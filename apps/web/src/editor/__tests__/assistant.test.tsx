// The AI assistant's edit lands on the project as it is when the answer comes back, never on the old snapshot.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addItem, createProject, createTextItem, updateItem, updateProject, type AssistantResult, type Project } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { systemApi } from '../../shell/system'
import { AssistantPanel } from '../panels/AssistantPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()
const item = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

let n = 0
beforeEach(() => {
  Element.prototype.scrollTo ??= () => undefined
  vi.spyOn(systemApi, 'aiSettings').mockRejectedValue(new Error('no settings in tests'))
  // a fresh project id per test: the panel keeps each project's chat
  const id = `p${++n}`
  const p = addItem(createProject({ id, name: 'Talk' }), createTextItem(0, 'heading', { id: 'title', duration: 2 }))
  S().load({ project: p, version: 3, projectId: id, demo: false, workspaceId: 'w1' })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Ask the assistant; the answer stays out until the test resolves it. */
async function ask(text: string) {
  const answer = deferred<AssistantResult>()
  const call = vi.spyOn(api, 'assistant').mockReturnValueOnce(answer.promise)
  render(<AssistantPanel />)
  fireEvent.change(screen.getByPlaceholderText(/Split at the playhead/), { target: { value: text } })
  await act(async () => fireEvent.submit(screen.getByPlaceholderText(/Split at the playhead/).closest('form')!))
  const sent = call.mock.calls[0][0].project
  return { sent, answer, call }
}

describe('AI assistant results after a wait', { timeout: 20_000 }, () => {
  it('applies the AI edit on top of what you changed while it worked', async () => {
    const { sent, answer } = await ask('Add an outro title')
    // you keep editing while the assistant works
    S().commit(updateProject(S().project, { background: '#223344' }), 'Background')
    const theirs = addItem(sent, createTextItem(5, 'heading', { id: 'outro', duration: 2 }))
    await act(async () => answer.resolve({ text: 'Added an outro.', project: theirs, changes: ['Added a title at 5 s'] }))
    expect(S().project.background).toBe('#223344')
    expect(item(S().project, 'outro')).toBeTruthy()
    expect(S().history.past.map((h) => h.label)).toEqual(['Background', 'AI edit'])
  })

  it('warns instead of overwriting when you changed the same thing, and can run again on the current edit', async () => {
    const { sent, answer, call } = await ask('Make the title longer')
    S().commit(updateItem(S().project, 'title', { duration: 4 }), 'Trim')
    const mine = S().project
    await act(async () => answer.resolve({ text: 'Made it 3 s.', project: updateItem(sent, 'title', { duration: 3 }), changes: ['Title is 3 s'] }))
    expect(S().project).toBe(mine)
    expect(item(S().project, 'title')?.duration).toBe(4)
    expect(screen.getByText(/didn.t apply/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()

    const again = deferred<AssistantResult>()
    call.mockReturnValueOnce(again.promise)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Run again on the current edit/ })))
    expect(call).toHaveBeenCalledTimes(2)
    const second = call.mock.calls[1][0]
    expect(second.project).toBe(mine)
    // the same request, once: not a second copy of your message, nor the reply that wasn't applied
    expect(second.messages).toEqual([{ role: 'user', text: 'Make the title longer' }])
    await act(async () => again.resolve({ text: 'Made it 5 s.', project: updateItem(mine, 'title', { duration: 5 }), changes: ['Title is 5 s'] }))
    expect(item(S().project, 'title')?.duration).toBe(5)
  })
})
