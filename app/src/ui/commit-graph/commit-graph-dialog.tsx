/* eslint-disable github/a11y-no-title-attribute */
// Native `title` tooltips are used on the many small graph labels: the
// shared TooltippedContent component attaches observers and listeners per
// element, which is too heavy for hundreds of rows.
import * as React from 'react'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import { Dialog, DialogContent } from '../dialog'
import { Button } from '../lib/button'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Repository } from '../../models/repository'
import { git } from '../../lib/git/core'
import {
  IGraphCommit,
  IGraphCommitDetails,
  IGraphRef,
  IGraphRow,
  layoutGraph,
  loadGraphCommitDetails,
  loadGraphCommits,
} from '../../lib/commit-graph'
import { getTagAppearance } from '../../lib/tag-color-rules'
import { showContextualMenu } from '../../lib/menu-item'
import { writeClipboardText } from '../main-process-proxy'

interface ICommitGraphDialogProps {
  readonly repository: Repository
  readonly onDismissed: () => void
}

interface ICommitGraphDialogState {
  readonly allBranches: boolean
  readonly limit: number
  readonly rows: ReadonlyArray<IGraphRow> | null
  readonly isLoading: boolean
  readonly error: string | null
  readonly selectedIndex: number | null
  readonly details: IGraphCommitDetails | null
  readonly query: string
  readonly scrollTop: number
  readonly viewportHeight: number
}

/** Lane colors, in the spirit of Fork's palette. */
const Palette = [
  '#f0820f', // orange
  '#e3b505', // yellow
  '#e5484d', // red
  '#3fb950', // green
  '#9a6b3f', // brown
  '#8b5cf6', // purple
  '#2f81f7', // blue
  '#14b8a6', // teal
]

const AvatarPalette = [
  '#8b5cf6',
  '#2f81f7',
  '#3fb950',
  '#e5484d',
  '#f0820f',
  '#14b8a6',
  '#db61a2',
  '#6e7781',
]

const RowHeight = 24
const LaneWidth = 14
const GraphPadding = 6
const PageSize = 2000
const Overscan = 15

const laneX = (lane: number) => GraphPadding + lane * LaneWidth + LaneWidth / 2

function hashString(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function initials(name: string) {
  const words = name
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)
  if (words.length === 0) {
    return '?'
  }
  const first = words[0][0]
  const second = words.length > 1 ? words[words.length - 1][0] : words[0][1]
  return `${first}${second ?? ''}`.toUpperCase()
}

function tint(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      })
}

/** The graph cell of one row: lane lines, merge curves and the commit dot. */
function GraphCell(props: { readonly row: IGraphRow }) {
  const { row } = props
  const width = GraphPadding * 2 + row.width * LaneWidth
  const mid = RowHeight / 2
  const x = laneX(row.lane)
  const color = Palette[row.color]

  return (
    <svg
      className="graph-cell"
      width={width}
      height={RowHeight}
      viewBox={`0 0 ${width} ${RowHeight}`}
      aria-hidden="true"
    >
      {row.through.map(t => (
        <line
          key={`t${t.lane}`}
          x1={laneX(t.lane)}
          y1={0}
          x2={laneX(t.lane)}
          y2={RowHeight}
          stroke={Palette[t.color]}
        />
      ))}
      {row.incoming.map(e => {
        const x1 = laneX(e.from)
        return e.from === e.to ? (
          <line
            key={`i${e.from}`}
            x1={x1}
            y1={0}
            x2={x}
            y2={mid}
            stroke={Palette[e.color]}
          />
        ) : (
          // A branch merging into this commit curves in from its lane.
          <path
            key={`i${e.from}`}
            d={`M ${x1} 0 C ${x1} ${mid * 0.7}, ${x} ${mid * 0.3}, ${x} ${mid}`}
            stroke={Palette[e.color]}
            fill="none"
          />
        )
      })}
      {row.outgoing.map(e => {
        const x2 = laneX(e.to)
        return e.from === e.to ? (
          <line
            key={`o${e.to}`}
            x1={x}
            y1={mid}
            x2={x2}
            y2={RowHeight}
            stroke={Palette[e.color]}
          />
        ) : (
          <path
            key={`o${e.to}`}
            d={`M ${x} ${mid} C ${x} ${mid + mid * 0.7}, ${x2} ${
              mid + mid * 0.3
            }, ${x2} ${RowHeight}`}
            stroke={Palette[e.color]}
            fill="none"
          />
        )
      })}
      {row.isMerge ? (
        <>
          <circle className="merge-dot" cx={x} cy={mid} r={5} stroke={color} />
          <path
            d={`M ${x - 2.5} ${mid - 1} L ${x} ${mid + 1.5} L ${x + 2.5} ${
              mid - 1
            }`}
            stroke={color}
            fill="none"
            strokeWidth={1.3}
          />
        </>
      ) : (
        <circle cx={x} cy={mid} r={4} fill={color} stroke="none" />
      )}
    </svg>
  )
}

function RefLabel(props: {
  readonly graphRef: IGraphRef
  readonly laneColor: string
}) {
  const { graphRef, laneColor } = props
  const tagAppearance =
    graphRef.kind === 'tag' ? getTagAppearance(graphRef.name) : null

  const color = tagAppearance?.background ?? laneColor
  const style: React.CSSProperties =
    tagAppearance !== null
      ? {
          borderColor: tagAppearance.background,
          backgroundColor: tagAppearance.background,
          color: tagAppearance.foreground,
        }
      : graphRef.kind === 'tag'
      ? {}
      : { borderColor: color, backgroundColor: tint(color, 0.16) }

  const icon =
    graphRef.kind === 'tag'
      ? octicons.tag
      : graphRef.kind === 'remote' || graphRef.isInSyncWithRemote
      ? octicons.cloud
      : graphRef.kind === 'head'
      ? octicons.gitCommit
      : null

  const title =
    graphRef.kind === 'tag'
      ? `Tag ${graphRef.name}`
      : graphRef.kind === 'remote'
      ? `Remote branch ${graphRef.name}`
      : graphRef.kind === 'head'
      ? 'Detached HEAD'
      : `Branch ${graphRef.name}${graphRef.isCurrent ? ' (checked out)' : ''}${
          graphRef.isInSyncWithRemote ? ', in sync with remote' : ''
        }`

  return (
    <span
      className={classNames('graph-ref', `graph-ref-${graphRef.kind}`, {
        current: graphRef.isCurrent,
      })}
      style={style}
      title={title}
    >
      {graphRef.isCurrent && graphRef.kind === 'local' && (
        <Octicon symbol={octicons.check} />
      )}
      {icon !== null && <Octicon symbol={icon} />}
      <span className="graph-ref-name">{graphRef.name}</span>
    </span>
  )
}

/**
 * A Fork-style commit graph: every branch drawn as a colored lane, with
 * merges and forks connecting lanes, branch/tag labels on their commits,
 * and details for the selected commit.
 */
export class CommitGraphDialog extends React.Component<
  ICommitGraphDialogProps,
  ICommitGraphDialogState
> {
  private scrollRef = React.createRef<HTMLDivElement>()
  private resizeObserver: ResizeObserver | null = null
  private loadVersion = 0
  private detailsVersion = 0
  private unmounted = false

  private getMatches = memoizeOne(
    (
      rows: ReadonlyArray<IGraphRow> | null,
      query: string
    ): ReadonlyArray<number> => {
      const q = query.trim().toLowerCase()
      if (rows === null || q.length === 0) {
        return []
      }
      return rows
        .map((row, i) => (rowMatches(row.commit, q) ? i : -1))
        .filter(i => i !== -1)
    }
  )

  public constructor(props: ICommitGraphDialogProps) {
    super(props)
    this.state = {
      allBranches: true,
      limit: PageSize,
      rows: null,
      isLoading: true,
      error: null,
      selectedIndex: null,
      details: null,
      query: '',
      scrollTop: 0,
      viewportHeight: 600,
    }
  }

  public componentDidMount() {
    this.load()

    const element = this.scrollRef.current
    if (element !== null && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.setState({ viewportHeight: element.clientHeight })
      })
      this.resizeObserver.observe(element)
    }
  }

  public componentWillUnmount() {
    this.unmounted = true
    this.resizeObserver?.disconnect()
  }

  private load = async (
    allBranches = this.state.allBranches,
    limit = this.state.limit
  ) => {
    const version = ++this.loadVersion
    this.setState({ isLoading: true, error: null })

    try {
      const [commits, head] = await Promise.all([
        loadGraphCommits(this.props.repository, { allBranches, limit }),
        git(
          ['rev-parse', '--verify', '--quiet', 'HEAD'],
          this.props.repository.path,
          'commitGraphHead',
          { successExitCodes: new Set([0, 1]) }
        ),
      ])
      if (this.unmounted || version !== this.loadVersion) {
        return
      }

      const headSha = head.stdout.trim() || null
      const selectedSha =
        this.state.selectedIndex !== null && this.state.rows !== null
          ? this.state.rows[this.state.selectedIndex]?.commit.sha
          : undefined

      const rows = layoutGraph(commits, headSha)
      const reselected =
        selectedSha !== undefined
          ? rows.findIndex(r => r.commit.sha === selectedSha)
          : -1

      this.setState({
        rows,
        isLoading: false,
        selectedIndex: reselected === -1 ? null : reselected,
        details: reselected === -1 ? null : this.state.details,
      })
    } catch (e) {
      if (!this.unmounted && version === this.loadVersion) {
        this.setState({
          isLoading: false,
          error: `Couldn't load history: ${e.message}`,
        })
      }
    }
  }

  private onRefresh = () => this.load()

  private onShowAllBranches = () => {
    this.setState({ allBranches: true, limit: PageSize })
    this.load(true, PageSize)
  }

  private onShowCurrentBranch = () => {
    this.setState({ allBranches: false, limit: PageSize })
    this.load(false, PageSize)
  }

  private onLoadMore = () => {
    const limit = this.state.limit + PageSize
    this.setState({ limit })
    this.load(this.state.allBranches, limit)
  }

  private onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    this.setState({ scrollTop: event.currentTarget.scrollTop })
  }

  private select(index: number, scrollIntoView = false) {
    const rows = this.state.rows
    if (rows === null || index < 0 || index >= rows.length) {
      return
    }

    this.setState({ selectedIndex: index, details: null })

    if (scrollIntoView) {
      const element = this.scrollRef.current
      if (element !== null) {
        const top = index * RowHeight
        if (top < element.scrollTop) {
          element.scrollTop = top
        } else if (top + RowHeight > element.scrollTop + element.clientHeight) {
          element.scrollTop = top + RowHeight - element.clientHeight
        }
      }
    }

    const version = ++this.detailsVersion
    loadGraphCommitDetails(this.props.repository, rows[index].commit)
      .then(details => {
        if (!this.unmounted && version === this.detailsVersion) {
          this.setState({ details })
        }
      })
      .catch(e => log.warn('[CommitGraph] failed to load commit details', e))
  }

  private onRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
    this.select(Number(event.currentTarget.dataset.index))
  }

  private onRowContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const index = Number(event.currentTarget.dataset.index)
    const row = this.state.rows?.[index]
    if (row === undefined) {
      return
    }
    this.select(index)

    const { commit } = row
    showContextualMenu([
      {
        label: __DARWIN__ ? 'Copy SHA' : 'Copy SHA',
        action: () => writeClipboardText(commit.sha),
      },
      {
        label: __DARWIN__ ? 'Copy Short SHA' : 'Copy short SHA',
        action: () => writeClipboardText(commit.sha.substring(0, 7)),
      },
      {
        label: __DARWIN__ ? 'Copy Message' : 'Copy message',
        action: () => writeClipboardText(commit.subject),
      },
    ])
  }

  private onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { selectedIndex, rows } = this.state
    if (rows === null || rows.length === 0) {
      return
    }

    const page = Math.max(1, Math.floor(this.state.viewportHeight / RowHeight))
    const current = selectedIndex ?? -1
    let next: number | null = null

    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(rows.length - 1, current + 1)
        break
      case 'ArrowUp':
        next = Math.max(0, current - 1)
        break
      case 'PageDown':
        next = Math.min(rows.length - 1, current + page)
        break
      case 'PageUp':
        next = Math.max(0, current - page)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = rows.length - 1
        break
    }

    if (next !== null) {
      event.preventDefault()
      this.select(next, true)
    }
  }

  private onQueryChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ query: event.currentTarget.value })
  }

  /** Enter in the search box (the dialog's submit) jumps to the next match. */
  private onSubmit = () => {
    const matches = this.getMatches(this.state.rows, this.state.query)
    if (matches.length === 0) {
      return
    }
    const current = this.state.selectedIndex ?? -1
    const next = matches.find(i => i > current) ?? matches[0]
    this.select(next, true)
  }

  private onJumpToParent = (event: React.MouseEvent<HTMLButtonElement>) => {
    const sha = event.currentTarget.dataset.sha
    const index = this.state.rows?.findIndex(r => r.commit.sha === sha) ?? -1
    if (index !== -1) {
      this.select(index, true)
    }
  }

  private onCopySha = () => {
    const { rows, selectedIndex } = this.state
    if (rows !== null && selectedIndex !== null) {
      writeClipboardText(rows[selectedIndex].commit.sha)
    }
  }

  private renderRow(
    row: IGraphRow,
    index: number,
    matches: ReadonlySet<number>
  ) {
    const { commit } = row
    const laneColor = Palette[row.color]

    // Keyboard navigation (arrows, Page Up/Down, Home/End) is handled by
    // the grid container, which keeps focus while the selection moves.
    return (
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events
      <div
        key={commit.sha}
        tabIndex={-1}
        className={classNames('commit-graph-row', {
          selected: index === this.state.selectedIndex,
          dimmed: !row.isInHead,
          match: matches.has(index),
          merge: row.isMerge,
        })}
        style={{ top: index * RowHeight }}
        data-index={index}
        onClick={this.onRowClick}
        onContextMenu={this.onRowContextMenu}
        role="row"
        aria-selected={index === this.state.selectedIndex}
      >
        <GraphCell row={row} />
        <div className="commit-graph-message">
          {commit.refs.map(r => (
            <RefLabel
              key={`${r.kind}:${r.name}`}
              graphRef={r}
              laneColor={laneColor}
            />
          ))}
          <span
            className={classNames('subject', {
              current: commit.refs.some(r => r.isCurrent),
            })}
          >
            {commit.subject}
          </span>
        </div>
        <div
          className="commit-graph-author"
          title={`${commit.author} <${commit.email}>`}
        >
          <span
            className="avatar"
            style={{
              backgroundColor:
                AvatarPalette[
                  hashString(commit.email || commit.author) %
                    AvatarPalette.length
                ],
            }}
          >
            {initials(commit.author)}
          </span>
          <span className="author-name">{commit.author}</span>
        </div>
        <div className="commit-graph-date">{formatDate(commit.timestamp)}</div>
        <div className="commit-graph-sha">{commit.sha.substring(0, 7)}</div>
      </div>
    )
  }

  private renderRows() {
    const { rows, scrollTop, viewportHeight, query } = this.state
    if (rows === null) {
      return null
    }

    const matchList = this.getMatches(rows, query)
    const matches = new Set(matchList)
    const first = Math.max(0, Math.floor(scrollTop / RowHeight) - Overscan)
    const last = Math.min(
      rows.length,
      Math.ceil((scrollTop + viewportHeight) / RowHeight) + Overscan
    )

    const visible = []
    for (let i = first; i < last; i++) {
      visible.push(this.renderRow(rows[i], i, matches))
    }

    const canLoadMore = rows.length >= this.state.limit

    return (
      <div
        className="commit-graph-rows"
        style={{ height: rows.length * RowHeight + (canLoadMore ? 48 : 0) }}
      >
        {visible}
        {canLoadMore && (
          <div
            className="commit-graph-load-more"
            style={{ top: rows.length * RowHeight }}
          >
            <Button onClick={this.onLoadMore} disabled={this.state.isLoading}>
              Load {PageSize} more commits
            </Button>
          </div>
        )}
      </div>
    )
  }

  private renderDetails() {
    const { rows, selectedIndex, details } = this.state
    if (rows === null || selectedIndex === null) {
      return (
        <div className="commit-graph-details empty">
          Select a commit to see its details.
        </div>
      )
    }

    const { commit } = rows[selectedIndex]
    const body = details?.body.split('\n').slice(1).join('\n').trim()

    return (
      <div className="commit-graph-details">
        <div className="details-message">
          <div className="details-subject">{commit.subject}</div>
          <div className="details-meta">
            <span>
              {commit.author} &lt;{commit.email}&gt;
            </span>
            <span>{new Date(commit.timestamp * 1000).toLocaleString()}</span>
            <button
              type="button"
              className="sha-button"
              onClick={this.onCopySha}
              title="Copy SHA"
            >
              <Octicon symbol={octicons.copy} />
              {commit.sha.substring(0, 10)}
            </button>
            {commit.parents.length > 0 && (
              <span className="parents">
                {commit.parents.length > 1 ? 'Parents' : 'Parent'}
                {commit.parents.map(p => (
                  <button
                    key={p}
                    type="button"
                    className="parent-link"
                    data-sha={p}
                    onClick={this.onJumpToParent}
                    title="Go to parent"
                  >
                    {p.substring(0, 7)}
                  </button>
                ))}
              </span>
            )}
          </div>
          {body !== undefined && body.length > 0 && (
            <pre className="details-body">{body}</pre>
          )}
        </div>
        <div className="details-files">
          {details === null ? (
            <div className="muted">Loading…</div>
          ) : details.files.length === 0 ? (
            <div className="muted">No file changes</div>
          ) : (
            <>
              <div className="files-header">
                {details.files.length} changed file
                {details.files.length === 1 ? '' : 's'}
                {commit.parents.length > 1 && ' (vs. first parent)'}
              </div>
              <ul>
                {details.files.map(f => (
                  <li key={f.path}>
                    <span className={`file-status status-${f.status}`}>
                      {f.status}
                    </span>
                    <span className="file-path">{f.path}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    )
  }

  public render() {
    const { rows, isLoading, error, allBranches, query } = this.state
    const matches = this.getMatches(rows, query)
    const name = this.props.repository.alias ?? this.props.repository.name

    return (
      <Dialog
        id="commit-graph"
        title={`History graph — ${name}`}
        onDismissed={this.props.onDismissed}
        onSubmit={this.onSubmit}
      >
        <DialogContent>
          <div className="commit-graph-toolbar">
            <div className="segmented" role="group" aria-label="Branches">
              <button
                type="button"
                className={classNames({ active: allBranches })}
                onClick={this.onShowAllBranches}
              >
                All branches
              </button>
              <button
                type="button"
                className={classNames({ active: !allBranches })}
                onClick={this.onShowCurrentBranch}
              >
                Current branch
              </button>
            </div>

            <div className="commit-graph-search">
              <Octicon symbol={octicons.search} />
              <input
                type="search"
                placeholder="Search message, author, SHA, branch or tag — Enter for next"
                value={query}
                onChange={this.onQueryChanged}
                aria-label="Search commits"
                spellCheck={false}
              />
              {query.trim().length > 0 && (
                <span className="match-count">
                  {matches.length} match{matches.length === 1 ? '' : 'es'}
                </span>
              )}
            </div>

            <span className="commit-count">
              {rows === null ? '' : `${rows.length} commits`}
            </span>
            <Button
              onClick={this.onRefresh}
              disabled={isLoading}
              tooltip="Refresh"
            >
              <Octicon
                symbol={octicons.sync}
                className={isLoading ? 'spin' : undefined}
              />
            </Button>
          </div>

          {error !== null && <div className="commit-graph-error">{error}</div>}

          <div
            className="commit-graph-scroll"
            ref={this.scrollRef}
            onScroll={this.onScroll}
            onKeyDown={this.onKeyDown}
            tabIndex={0}
            role="grid"
            aria-label="Commit graph"
          >
            {rows === null ? (
              <div className="commit-graph-loading">Loading history…</div>
            ) : rows.length === 0 ? (
              <div className="commit-graph-loading">No commits yet.</div>
            ) : (
              this.renderRows()
            )}
          </div>

          {this.renderDetails()}
        </DialogContent>
      </Dialog>
    )
  }
}

function rowMatches(commit: IGraphCommit, query: string) {
  return (
    commit.subject.toLowerCase().includes(query) ||
    commit.author.toLowerCase().includes(query) ||
    commit.sha.startsWith(query) ||
    commit.refs.some(r => r.name.toLowerCase().includes(query))
  )
}
