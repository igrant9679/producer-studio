// Journals of unsaved edits don't outlive their projects (phase 5 carry-over: orphaned local journals): a deleted
// project's go for every person, and any not offered back in a month go when the editor next opens a project.
import { createProject } from '@producer/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearJournalsFor, JOURNAL_MAX_AGE_MS, pruneJournals, readJournal, writeJournal } from '../journal'

const p = createProject({ id: 'p1', name: 'x' })

beforeEach(() => localStorage.clear())

describe('old journals', () => {
  it('a deleted project’s go, for every person, and only its own', () => {
    writeJournal({ projectId: 'p1', userId: 'u1', baseVersion: 1, project: p })
    writeJournal({ projectId: 'p1', userId: 'u2', baseVersion: 1, project: p })
    writeJournal({ projectId: 'p12', userId: 'u1', baseVersion: 1, project: p })
    clearJournalsFor('p1')
    expect(readJournal('u1', 'p1')).toBeNull()
    expect(readJournal('u2', 'p1')).toBeNull()
    expect(localStorage.getItem('ps.journal.u1.p12')).not.toBeNull()
  })

  it('ones a month old or unreadable go; recent ones and other keys stay', () => {
    const now = 1_800_000_000_000
    writeJournal({ projectId: 'old', userId: 'u1', baseVersion: 1, project: p }, now - JOURNAL_MAX_AGE_MS - 1)
    writeJournal({ projectId: 'new', userId: 'u1', baseVersion: 1, project: p }, now - 1000)
    localStorage.setItem('ps.journal.u1.broken', '{not json')
    localStorage.setItem('ps.other', 'kept')
    expect(pruneJournals(now)).toBe(2)
    expect(localStorage.getItem('ps.journal.u1.old')).toBeNull()
    expect(localStorage.getItem('ps.journal.u1.broken')).toBeNull()
    expect(localStorage.getItem('ps.journal.u1.new')).not.toBeNull()
    expect(localStorage.getItem('ps.other')).toBe('kept')
  })
})
