import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  IGraphCommit,
  layoutGraph,
  parseDecorations,
  parseGraphLog,
} from '../../src/lib/commit-graph'

const c = (sha: string, parents: Array<string> = []): IGraphCommit => ({
  sha,
  parents,
  author: 'A',
  email: 'a@example.com',
  timestamp: 0,
  subject: sha,
  refs: [],
})

describe('commit graph', () => {
  it('keeps a linear history in one lane', () => {
    const rows = layoutGraph([c('c3', ['c2']), c('c2', ['c1']), c('c1')], 'c3')
    assert.deepEqual(
      rows.map(r => r.lane),
      [0, 0, 0]
    )
    assert.ok(rows.every(r => r.isInHead))
    assert.equal(rows[0].incoming.length, 0)
    assert.equal(rows[1].incoming.length, 1)
    assert.equal(rows[2].outgoing.length, 0)
  })

  it('draws a branch and its merge in separate lanes', () => {
    //   m  (merge of a2 and b1)
    //   |\
    //   a2 b1
    //   |/
    //   a1
    const rows = layoutGraph(
      [c('m', ['a2', 'b1']), c('b1', ['a1']), c('a2', ['a1']), c('a1')],
      'm'
    )
    const [m, b1, a2, a1] = rows

    assert.equal(m.isMerge, true)
    assert.equal(m.lane, 0)
    assert.deepEqual(
      m.outgoing.map(e => e.to),
      [0, 1]
    )
    assert.equal(b1.lane, 1)
    // While b1 is drawn, lane 0 (waiting for a2) passes straight through.
    assert.deepEqual(
      b1.through.map(t => t.lane),
      [0]
    )
    assert.equal(a2.lane, 0)
    // Both lanes converge on a1, and the graph narrows back to one lane.
    assert.equal(a1.lane, 0)
    assert.deepEqual(a1.incoming.map(e => e.from).sort(), [0, 1])
    assert.equal(a1.through.length, 0)
    // The branch keeps one color throughout.
    assert.equal(b1.color, m.outgoing[1].color)
  })

  it('dims commits that are not on the current branch', () => {
    const rows = layoutGraph(
      [c('other', ['base']), c('mine', ['base']), c('base')],
      'mine'
    )
    assert.deepEqual(
      rows.map(r => r.isInHead),
      [false, true, true]
    )
  })

  it('parses log output and decorations', () => {
    const out =
      [
        'abc1234',
        'def5678',
        'Blake',
        'b@x',
        '1700000000',
        'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1',
        'Fix: a\x1fb',
      ].join('\x1f') + '\x1e\n'
    const [commit] = parseGraphLog(out)
    assert.equal(commit.sha, 'abc1234')
    assert.deepEqual(commit.parents, ['def5678'])
    assert.equal(commit.subject, 'Fix: a\x1fb')
    assert.deepEqual(
      commit.refs.map(r => [r.kind, r.name, r.isCurrent, r.isInSyncWithRemote]),
      [
        ['local', 'main', true, true],
        ['tag', 'v1', false, false],
      ]
    )
  })

  it('shows remote-only branches and detached HEAD', () => {
    const refs = parseDecorations(
      'HEAD, refs/remotes/origin/feature, refs/remotes/origin/HEAD'
    )
    assert.deepEqual(
      refs.map(r => [r.kind, r.name]),
      [
        ['head', 'HEAD'],
        ['remote', 'origin/feature'],
      ]
    )
  })
})
