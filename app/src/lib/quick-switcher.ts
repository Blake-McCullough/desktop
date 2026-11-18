import { Branch, BranchType } from '../models/branch'
import { Repository } from '../models/repository'
import { IMatches, match } from './fuzzy-find'

/** Something you can jump to from the quick switcher. */
export type QuickSwitcherItem =
  | {
      readonly kind: 'repository'
      readonly id: string
      readonly title: string
      /** The sidebar group it's in, if any. */
      readonly subtitle: string
      readonly color?: string
      readonly repository: Repository
    }
  | {
      readonly kind: 'branch'
      readonly id: string
      readonly title: string
      /** e.g. `origin` for a branch only on the remote. */
      readonly subtitle: string
      readonly branch: Branch
    }

export interface IQuickSwitcherMatch {
  readonly item: QuickSwitcherItem
  readonly matches: IMatches
}

export interface IQuickSwitcherInput {
  readonly repositories: ReadonlyArray<Repository>
  /** The repository you're in; it's left out of the list. */
  readonly currentRepository: Repository | null
  /** Sidebar groups: id → name and colour. */
  readonly groups: ReadonlyMap<
    string,
    { readonly name: string; readonly color?: string }
  >
  /** Repository id → sidebar group id. */
  readonly assignments: ReadonlyMap<number, string>
  /** Repository ids, most recently opened first. */
  readonly recentRepositoryIds: ReadonlyArray<number>
  /** The current repository's branches (local and remote). */
  readonly branches: ReadonlyArray<Branch>
  readonly currentBranch: Branch | null
  /** Branch names, most recently checked out first. */
  readonly recentBranchNames: ReadonlyArray<string>
}

function rankBy<T>(order: ReadonlyArray<T>) {
  const index = new Map(order.map((v, i) => [v, i]))
  return (v: T) => index.get(v) ?? Number.MAX_SAFE_INTEGER
}

/**
 * Everything the switcher offers, in the order it's shown before you type:
 * other repositories (recently opened first), then the current repository's
 * branches (recently checked out first, then local, then remote-only).
 */
export function buildQuickSwitcherItems(
  input: IQuickSwitcherInput
): ReadonlyArray<QuickSwitcherItem> {
  const repoRank = rankBy(input.recentRepositoryIds)
  const repositories = input.repositories
    .filter(r => !r.missing && r.id !== input.currentRepository?.id)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => repoRank(a.r.id) - repoRank(b.r.id) || a.i - b.i)
    .map(({ r }): QuickSwitcherItem => {
      const groupId = input.assignments.get(r.id)
      const group =
        groupId === undefined ? undefined : input.groups.get(groupId)
      return {
        kind: 'repository',
        id: `repository:${r.id}`,
        title: r.alias ?? r.name,
        subtitle: group?.name ?? '',
        color: group?.color,
        repository: r,
      }
    })

  const current = input.currentBranch?.name
  const local = input.branches.filter(
    b => b.type === BranchType.Local && b.name !== current
  )
  const localNames = new Set(input.branches.map(b => b.name))
  const trackedRemotes = new Set(
    input.branches
      .filter(b => b.type === BranchType.Local)
      .map(b => b.upstream)
      .filter((u): u is string => u !== null)
  )
  // Remote branches you don't have locally; checking one out creates it.
  const remoteOnly = input.branches.filter(
    b =>
      b.type === BranchType.Remote &&
      !trackedRemotes.has(b.name) &&
      !localNames.has(b.nameWithoutRemote) &&
      b.nameWithoutRemote !== 'HEAD'
  )
  const branchRank = rankBy(input.recentBranchNames)
  const sortedLocal = local
    .map((b, i) => ({ b, i }))
    .sort((x, y) => branchRank(x.b.name) - branchRank(y.b.name) || x.i - y.i)
    .map(({ b }) => b)

  const branches = [...sortedLocal, ...remoteOnly].map(
    (b): QuickSwitcherItem => ({
      kind: 'branch',
      id: `branch:${b.type}:${b.name}`,
      title: b.type === BranchType.Remote ? b.nameWithoutRemote : b.name,
      subtitle: b.type === BranchType.Remote ? b.remoteName ?? '' : '',
      branch: b,
    })
  )

  return [...repositories, ...branches]
}

/**
 * The items matching what you typed, best first (keeping the default order
 * for an empty query), at most `limit` of them.
 */
export function filterQuickSwitcherItems(
  items: ReadonlyArray<QuickSwitcherItem>,
  query: string,
  limit = 50
): ReadonlyArray<IQuickSwitcherMatch> {
  const q = query.trim()
  if (q.length === 0) {
    return items
      .slice(0, limit)
      .map(item => ({ item, matches: { title: [], subtitle: [] } }))
  }
  return match(q, items, item => [item.title, item.subtitle])
    .slice(0, limit)
    .map(m => ({ item: m.item, matches: m.matches }))
}
