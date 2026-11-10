import { Repository } from '../models/repository'
import { git } from './git/core'

/** A branch or tag pointing at a commit in the graph. */
export interface IGraphRef {
  readonly kind: 'local' | 'remote' | 'tag' | 'head'
  /** Display name, e.g. `main`, `origin/main`, `v1.0`, or `HEAD`. */
  readonly name: string
  /** The checked-out branch. */
  readonly isCurrent: boolean
  /**
   * For a local branch: a remote branch with the same name points at the
   * same commit (shown as one label with a cloud icon, like Fork).
   */
  readonly isInSyncWithRemote: boolean
}

export interface IGraphCommit {
  readonly sha: string
  readonly parents: ReadonlyArray<string>
  readonly author: string
  readonly email: string
  /** Seconds since the epoch. */
  readonly timestamp: number
  readonly subject: string
  readonly refs: ReadonlyArray<IGraphRef>
}

/** A line segment in a row's graph cell, between lane indexes. */
export interface IGraphEdge {
  readonly from: number
  readonly to: number
  readonly color: number
}

/** Everything needed to draw one row of the graph. */
export interface IGraphRow {
  readonly commit: IGraphCommit
  /** Lane of the commit's dot. */
  readonly lane: number
  readonly color: number
  readonly isMerge: boolean
  /** Whether the commit is reachable from HEAD (others are dimmed). */
  readonly isInHead: boolean
  /** Lanes passing straight through this row. */
  readonly through: ReadonlyArray<{
    readonly lane: number
    readonly color: number
  }>
  /** Lines from the top of the row into the commit dot. */
  readonly incoming: ReadonlyArray<IGraphEdge>
  /** Lines from the commit dot to the bottom of the row (towards parents). */
  readonly outgoing: ReadonlyArray<IGraphEdge>
  /** Number of lane columns this row needs. */
  readonly width: number
}

/** How many colors lanes cycle through (see the stylesheet). */
export const GraphColorCount = 8

const FieldSeparator = '\x1f'
const RecordSeparator = '\x1e'

/**
 * Load commits for the graph, newest first, in an order where every commit
 * comes before its parents (which the lane layout relies on).
 */
export async function loadGraphCommits(
  repository: Repository,
  options: { readonly allBranches: boolean; readonly limit: number }
): Promise<ReadonlyArray<IGraphCommit>> {
  const format = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s']
    .join(FieldSeparator)
    .concat(RecordSeparator)

  const args = [
    'log',
    '--date-order',
    '--decorate=full',
    `--format=${format}`,
    `--max-count=${options.limit}`,
    ...(options.allBranches
      ? ['--branches', '--remotes', '--tags', 'HEAD']
      : ['HEAD']),
    '--',
  ]

  const result = await git(args, repository.path, 'commitGraphLog', {
    successExitCodes: new Set([0, 128]),
  })

  // 128: e.g. an empty repository with no commits yet.
  if (result.exitCode !== 0) {
    return []
  }

  return parseGraphLog(result.stdout)
}

/** Parse `loadGraphCommits` output. Exported for tests. */
export function parseGraphLog(stdout: string): ReadonlyArray<IGraphCommit> {
  const commits: Array<IGraphCommit> = []

  for (const record of stdout.split(RecordSeparator)) {
    const trimmed = record.replace(/^\n/, '')
    if (trimmed.length === 0) {
      continue
    }
    const [sha, parents, author, email, at, decorations, ...rest] =
      trimmed.split(FieldSeparator)
    if (sha === undefined || sha.length < 7) {
      continue
    }

    commits.push({
      sha,
      parents: parents.length > 0 ? parents.split(' ') : [],
      author,
      email,
      timestamp: parseInt(at, 10) || 0,
      subject: rest.join(FieldSeparator),
      refs: parseDecorations(decorations ?? ''),
    })
  }

  return commits
}

/** Parse a `%D` (with `--decorate=full`) decoration string. */
export function parseDecorations(
  decorations: string
): ReadonlyArray<IGraphRef> {
  if (decorations.trim().length === 0) {
    return []
  }

  let current: string | null = null
  let detachedHead = false
  const locals: Array<string> = []
  const remotes: Array<string> = []
  const tags: Array<string> = []

  for (const raw of decorations.split(', ')) {
    let entry = raw.trim()
    if (entry.startsWith('HEAD -> ')) {
      entry = entry.substring('HEAD -> '.length)
      current = entry.replace(/^refs\/heads\//, '')
    } else if (entry === 'HEAD') {
      detachedHead = true
      continue
    }

    if (entry.startsWith('tag: ')) {
      tags.push(entry.substring('tag: '.length).replace(/^refs\/tags\//, ''))
    } else if (entry.startsWith('refs/heads/')) {
      locals.push(entry.substring('refs/heads/'.length))
    } else if (entry.startsWith('refs/remotes/')) {
      const name = entry.substring('refs/remotes/'.length)
      // `origin/HEAD` is just a pointer to the default branch.
      if (!name.endsWith('/HEAD')) {
        remotes.push(name)
      }
    }
  }

  const refs: Array<IGraphRef> = []
  const syncedRemotes = new Set<string>()

  for (const local of locals) {
    const remote = remotes.find(r => r.substring(r.indexOf('/') + 1) === local)
    if (remote !== undefined) {
      syncedRemotes.add(remote)
    }
    refs.push({
      kind: 'local',
      name: local,
      isCurrent: local === current,
      isInSyncWithRemote: remote !== undefined,
    })
  }

  // The checked-out branch first, like Fork.
  refs.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))

  if (detachedHead) {
    refs.unshift({
      kind: 'head',
      name: 'HEAD',
      isCurrent: true,
      isInSyncWithRemote: false,
    })
  }

  for (const remote of remotes) {
    if (!syncedRemotes.has(remote)) {
      refs.push({
        kind: 'remote',
        name: remote,
        isCurrent: false,
        isInSyncWithRemote: false,
      })
    }
  }

  for (const tag of tags) {
    refs.push({
      kind: 'tag',
      name: tag,
      isCurrent: false,
      isInSyncWithRemote: false,
    })
  }

  return refs
}

/**
 * Lay commits out into lanes, like Fork/GitKraken: each commit gets a
 * column, branches keep their lane (and color) until they merge, and merges
 * and forks are drawn as lines between lanes.
 *
 * `commits` must list every commit before its parents (`--date-order` or
 * `--topo-order`). `headSha` marks which commits are on the current branch.
 */
export function layoutGraph(
  commits: ReadonlyArray<IGraphCommit>,
  headSha: string | null
): ReadonlyArray<IGraphRow> {
  // The commit each lane is waiting for (null = free), and its color.
  const lanes: Array<string | null> = []
  const colors: Array<number> = []
  let nextColor = 0

  const takeLane = () => {
    const free = lanes.indexOf(null)
    const index = free === -1 ? lanes.length : free
    lanes[index] = null
    colors[index] = nextColor++ % GraphColorCount
    return index
  }

  // Commits reachable from HEAD. Children always come before parents, so a
  // single pass propagating from HEAD is enough.
  const inHead = new Set<string>()
  if (headSha !== null) {
    inHead.add(headSha)
  }

  const rows: Array<IGraphRow> = []

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha)
    const hasLineAbove = lane !== -1
    if (lane === -1) {
      lane = takeLane()
    }
    const color = colors[lane]
    const widthBefore = lanes.length

    const through: Array<{ lane: number; color: number }> = []
    const incoming: Array<IGraphEdge> = []

    for (let i = 0; i < lanes.length; i++) {
      const waitingFor = lanes[i]
      if (waitingFor === null) {
        continue
      }
      if (waitingFor === commit.sha) {
        if (i !== lane || hasLineAbove) {
          incoming.push({ from: i, to: lane, color: colors[i] })
        }
        if (i !== lane) {
          // Another branch converging here ends at this commit.
          lanes[i] = null
        }
      } else {
        through.push({ lane: i, color: colors[i] })
      }
    }

    const outgoing: Array<IGraphEdge> = []
    const [firstParent, ...otherParents] = commit.parents

    if (firstParent === undefined) {
      lanes[lane] = null
    } else {
      lanes[lane] = firstParent
      outgoing.push({ from: lane, to: lane, color })
    }

    for (const parent of otherParents) {
      const existing = lanes.indexOf(parent)
      if (existing !== -1) {
        outgoing.push({ from: lane, to: existing, color: colors[existing] })
      } else {
        const newLane = takeLane()
        lanes[newLane] = parent
        outgoing.push({ from: lane, to: newLane, color: colors[newLane] })
      }
    }

    // Drop free lanes at the end so the graph narrows again.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.pop()
    }

    const isInHead = inHead.has(commit.sha)
    if (isInHead) {
      for (const parent of commit.parents) {
        inHead.add(parent)
      }
    }

    rows.push({
      commit,
      lane,
      color,
      isMerge: commit.parents.length > 1,
      isInHead,
      through,
      incoming,
      outgoing,
      width: Math.max(widthBefore, lanes.length, lane + 1),
    })
  }

  return rows
}

/** Load the details shown when a commit is selected. */
export interface IGraphCommitDetails {
  readonly body: string
  readonly files: ReadonlyArray<{
    readonly status: string
    readonly path: string
  }>
}

export async function loadGraphCommitDetails(
  repository: Repository,
  commit: IGraphCommit
): Promise<IGraphCommitDetails> {
  const [message, diff] = await Promise.all([
    git(
      ['show', '-s', '--format=%B', commit.sha, '--'],
      repository.path,
      'commitGraphMessage'
    ),
    git(
      [
        'diff-tree',
        '-r',
        '-M',
        '--name-status',
        '--no-commit-id',
        // Merges are shown against their first parent, like GitHub.
        ...(commit.parents.length > 0
          ? [commit.parents[0], commit.sha]
          : ['--root', commit.sha]),
        '--',
      ],
      repository.path,
      'commitGraphFiles'
    ),
  ])

  const files = diff.stdout
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split('\t')
      return {
        status: parts[0].charAt(0),
        path: parts.length > 2 ? `${parts[1]} → ${parts[2]}` : parts[1],
      }
    })

  return { body: message.stdout.trim(), files }
}
