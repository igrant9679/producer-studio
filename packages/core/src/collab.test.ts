import { describe, expect, it } from 'vitest'
import { activitySentence, commentMarks, threadsOf, type ActivityEntry, type ReviewComment } from './collab'

const c = (id: string, at: number | undefined, createdAt: number, more: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  projectId: 'p',
  author: { name: 'A', guest: false },
  body: id,
  ...(at !== undefined ? { at } : {}),
  createdAt,
  updatedAt: createdAt,
  ...more,
})

describe('review comment threads (E-22)', () => {
  it('orders threads by time (timeless last) with their replies oldest first', () => {
    const list = [c('late', 9, 1), c('r2', undefined, 5, { parentId: 'early' }), c('none', undefined, 2), c('early', 3, 3), c('r1', undefined, 4, { parentId: 'early' }), c('orphan', undefined, 6, { parentId: 'gone' })]
    const t = threadsOf(list)
    expect(t.map((x) => x.id)).toEqual(['early', 'late', 'none'])
    expect(t[0].replies.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('marks open threads on the ruler, with how many comments each holds', () => {
    const list = [c('a', 2, 1), c('b', 5, 2, { resolved: { at: 3 } }), c('r', undefined, 3, { parentId: 'a' }), c('n', undefined, 4)]
    expect(commentMarks(list)).toEqual([{ id: 'a', at: 2, resolved: false, count: 2 }])
    expect(commentMarks(list, { resolved: true }).map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('activity sentences (A-23)', () => {
  const e = (kind: ActivityEntry['kind'], data: Record<string, unknown> = {}): ActivityEntry => ({ id: 'x', workspaceId: 'w', actor: { name: 'Ada' }, kind, data, createdAt: 0 })
  it('says what happened in plain words', () => {
    expect(activitySentence(e('project.renamed', { from: 'Cut', to: 'Cut v2' }))).toBe('Ada renamed “Cut” to “Cut v2”')
    expect(activitySentence(e('project.exported', { project: 'Cut', resolution: '1080p', format: 'mp4' }))).toBe('Ada exported “Cut” (1080p MP4)')
    expect(activitySentence(e('share.changed', { project: 'Cut', changes: ['password set'] }))).toBe('Ada changed a share link of “Cut”: password set')
    expect(activitySentence(e('comment.added', { project: 'Cut', guest: true }))).toBe('Ada (guest) commented on “Cut”')
    expect(activitySentence(e('member.role', { member: 'Bo', role: 'editor' }))).toBe('Ada made Bo an editor')
    expect(activitySentence(e('member.role', { member: 'Bo', role: 'owner' }))).toBe('Ada made Bo an owner')
    expect(activitySentence(e('member.left'))).toBe('Ada left the space')
  })
})
