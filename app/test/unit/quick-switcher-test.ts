import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  buildQuickSwitcherItems,
  filterQuickSwitcherItems,
  IQuickSwitcherInput,
} from '../../src/lib/quick-switcher'
import { Branch, BranchType } from '../../src/models/branch'
import { Repository } from '../../src/models/repository'
import { CommitIdentity } from '../../src/models/commit-identity'

const tip = {
  sha: '300acef',
  author: new CommitIdentity('Alex', 'alex@example.com', new Date()),
}
const local = (name: string, upstream: string | null = null) =>
  new Branch(name, upstream, tip, BranchType.Local, `refs/heads/${name}`)
const remote = (name: string) =>
  new Branch(name, null, tip, BranchType.Remote, `refs/remotes/${name}`)
const repo = (id: number, name: string, alias?: string) =>
  new Repository(`/code/${name}`, id, null, false, alias ?? null)

const payments = repo(1, 'payments-api')
const billing = repo(2, 'billing-service')
const blog = repo(3, 'blog', 'My blog')
const main = local('main', 'origin/main')

function input(extra: Partial<IQuickSwitcherInput> = {}): IQuickSwitcherInput {
  return {
    repositories: [payments, billing, blog],
    currentRepository: payments,
    groups: new Map([['g1', { name: 'acme/platform', color: '#e53935' }]]),
    assignments: new Map([[2, 'g1']]),
    recentRepositoryIds: [3],
    branches: [
      main,
      local('feature/retries', 'origin/feature/retries'),
      local('spike'),
      remote('origin/main'),
      remote('origin/feature/retries'),
      remote('origin/release/1.4'),
      remote('origin/HEAD'),
    ],
    currentBranch: main,
    recentBranchNames: ['spike'],
    ...extra,
  }
}

describe('buildQuickSwitcherItems', () => {
  it('lists other repositories, recent first, then branches', () => {
    const items = buildQuickSwitcherItems(input())
    assert.deepEqual(
      items.map(i => `${i.kind}:${i.title}:${i.subtitle}`),
      [
        'repository:My blog:',
        'repository:billing-service:acme/platform',
        'branch:spike:',
        'branch:feature/retries:',
        'branch:release/1.4:origin',
      ]
    )
    const billingItem = items[1]
    assert.equal(
      billingItem.kind === 'repository' ? billingItem.color : null,
      '#e53935'
    )
  })

  it('lists only repositories when locked to them', () => {
    const items = buildQuickSwitcherItems(input({ repositoriesOnly: true }))
    assert.deepEqual(
      items.map(i => i.kind),
      ['repository', 'repository']
    )
  })

  it('leaves out missing repositories', () => {
    const missing = new Repository('/gone', 4, null, true)
    const items = buildQuickSwitcherItems(
      input({ repositories: [payments, missing] })
    )
    assert.equal(
      items.some(i => i.kind === 'repository'),
      false
    )
  })
})

describe('filterQuickSwitcherItems', () => {
  it('matches repositories and branches by name', () => {
    const items = buildQuickSwitcherItems(input())
    const titles = filterQuickSwitcherItems(items, 'bill').map(
      m => m.item.title
    )
    assert.equal(titles[0], 'billing-service')
    assert.deepEqual(
      filterQuickSwitcherItems(items, 'retr').map(m => m.item.title),
      ['feature/retries']
    )
  })

  it('matches on the group name too', () => {
    const items = buildQuickSwitcherItems(input())
    assert.deepEqual(
      filterQuickSwitcherItems(items, 'platform').map(m => m.item.title),
      ['billing-service']
    )
  })

  it('keeps the default order with no query, up to the limit', () => {
    const items = buildQuickSwitcherItems(input())
    assert.equal(filterQuickSwitcherItems(items, '  ', 2).length, 2)
  })
})
