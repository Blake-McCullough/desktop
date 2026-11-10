import * as React from 'react'
import * as Path from 'path'
import classNames from 'classnames'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Button } from '../lib/button'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { WorktreeEntry } from '../../models/worktree'
import { PopupType } from '../../models/popup'
import { listWorktrees } from '../../lib/git/worktree'
import { git } from '../../lib/git/core'
import { shell } from '../../lib/app-shell'
import { writeClipboardText } from '../main-process-proxy'

interface IWorktreeViewerDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly onDismissed: () => void
}

/** Extra, slower-to-load information about a worktree. */
interface IWorktreeDetails {
  readonly shortSha: string | null
  readonly subject: string | null
  readonly relativeDate: string | null
  /** Number of changed (including untracked) files, or `null` if unknown. */
  readonly changedFiles: number | null
  /** Commits ahead of / behind its upstream, or `null` without one. */
  readonly ahead: number | null
  readonly behind: number | null
}

interface IWorktreeViewerDialogState {
  readonly worktrees: ReadonlyArray<WorktreeEntry> | null
  readonly details: ReadonlyMap<string, IWorktreeDetails>
  readonly error: string | null
  readonly isLoading: boolean
}

const okExitCodes = new Set([0, 1, 128])

/** Count entries in `git status --porcelain=v1 -z` output. */
function countStatusEntries(stdout: string): number {
  const parts = stdout.split('\0')
  let count = 0
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 3) {
      continue
    }
    count++
    // Renames and copies are followed by the original path.
    if (entry[0] === 'R' || entry[0] === 'C') {
      i++
    }
  }
  return count
}

async function loadDetails(worktree: WorktreeEntry): Promise<IWorktreeDetails> {
  const path = worktree.path
  const [log, status, aheadBehind] = await Promise.all([
    git(['log', '-1', '--format=%h%x00%s%x00%cr'], path, 'worktreeViewerLog', {
      successExitCodes: okExitCodes,
    }).catch(() => null),
    git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      path,
      'worktreeViewerStatus',
      { successExitCodes: okExitCodes }
    ).catch(() => null),
    git(
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      path,
      'worktreeViewerAheadBehind',
      { successExitCodes: okExitCodes }
    ).catch(() => null),
  ])

  const [shortSha, subject, relativeDate] =
    log !== null && log.exitCode === 0 ? log.stdout.trim().split('\0') : []

  let ahead: number | null = null
  let behind: number | null = null
  if (aheadBehind !== null && aheadBehind.exitCode === 0) {
    const [b, a] = aheadBehind.stdout.trim().split(/\s+/).map(Number)
    if (!isNaN(a) && !isNaN(b)) {
      ahead = a
      behind = b
    }
  }

  return {
    shortSha: shortSha ?? null,
    subject: subject ?? null,
    relativeDate: relativeDate ?? null,
    changedFiles:
      status !== null && status.exitCode === 0
        ? countStatusEntries(status.stdout)
        : null,
    ahead,
    behind,
  }
}

function normalizePath(p: string) {
  const resolved = Path.resolve(p).replace(/[\\/]+$/, '')
  return __WIN32__ || __DARWIN__ ? resolved.toLowerCase() : resolved
}

function branchName(worktree: WorktreeEntry) {
  return worktree.branch?.replace(/^refs\/heads\//, '') ?? null
}

/**
 * A window listing every worktree of a repository with its branch, latest
 * commit, uncommitted changes and ahead/behind state, plus quick actions
 * to switch to, open, or remove each one.
 */
export class WorktreeViewerDialog extends React.Component<
  IWorktreeViewerDialogProps,
  IWorktreeViewerDialogState
> {
  private loadVersion = 0
  private unmounted = false
  private readonly handlers = new Map<string, () => void>()

  public constructor(props: IWorktreeViewerDialogProps) {
    super(props)
    this.state = {
      worktrees: null,
      details: new Map(),
      error: null,
      isLoading: true,
    }
  }

  public componentDidMount() {
    this.load()
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private load = async () => {
    const version = ++this.loadVersion
    this.setState({ isLoading: true, error: null })

    let worktrees: ReadonlyArray<WorktreeEntry>
    try {
      worktrees = await listWorktrees(this.props.repository)
    } catch (e) {
      if (!this.unmounted && version === this.loadVersion) {
        this.setState({
          isLoading: false,
          error: `Couldn't list worktrees: ${e.message}`,
        })
      }
      return
    }

    if (this.unmounted || version !== this.loadVersion) {
      return
    }
    this.setState({ worktrees })

    // Details are loaded per worktree and shown as each one arrives.
    await Promise.all(
      worktrees.map(async worktree => {
        if (worktree.isPrunable) {
          return
        }
        const details = await loadDetails(worktree)
        if (this.unmounted || version !== this.loadVersion) {
          return
        }
        this.setState(prev => {
          const map = new Map(prev.details)
          map.set(worktree.path, details)
          return { details: map }
        })
      })
    )

    if (!this.unmounted && version === this.loadVersion) {
      this.setState({ isLoading: false })
    }
  }

  /** A stable click handler per action and worktree path. */
  private handler(action: string, path: string) {
    const key = `${action}\0${path}`
    let handler = this.handlers.get(key)
    if (handler === undefined) {
      handler = () => this.runAction(action, path)
      this.handlers.set(key, handler)
    }
    return handler
  }

  private runAction(action: string, path: string) {
    const worktree = this.state.worktrees?.find(w => w.path === path)
    if (worktree === undefined) {
      return
    }
    const { dispatcher, repository } = this.props

    switch (action) {
      case 'switch':
        this.props.onDismissed()
        dispatcher.switchWorktree(repository, worktree)
        break
      case 'reveal':
        shell.showFolderContents(path)
        break
      case 'editor':
        dispatcher.openInExternalEditor(path)
        break
      case 'shell':
        dispatcher.openShell(path)
        break
      case 'copy':
        writeClipboardText(path)
        break
      case 'remove':
        this.props.onDismissed()
        dispatcher.requestDeleteWorktree(repository, path)
        break
    }
  }

  private onNewWorktree = () => {
    const { dispatcher, repository } = this.props
    this.props.onDismissed()
    dispatcher.showPopup({ type: PopupType.AddWorktree, repository })
  }

  private renderBadges(worktree: WorktreeEntry, isCurrent: boolean) {
    return (
      <>
        {worktree.type === 'main' && <span className="badge">Main</span>}
        {isCurrent && <span className="badge current">Open</span>}
        {worktree.isLocked && (
          <span className="badge">
            <Octicon symbol={octicons.lock} />
            Locked
          </span>
        )}
        {worktree.isPrunable && (
          <span className="badge warning">
            <Octicon symbol={octicons.alert} />
            Missing
          </span>
        )}
      </>
    )
  }

  private renderDetails(worktree: WorktreeEntry) {
    if (worktree.isPrunable) {
      return (
        <div className="worktree-meta muted">
          The folder no longer exists. Remove it to clean up.
        </div>
      )
    }

    const details = this.state.details.get(worktree.path)
    if (details === undefined) {
      return <div className="worktree-meta muted">Loading…</div>
    }

    const changes = details.changedFiles
    return (
      <>
        {details.shortSha !== null && (
          <div className="worktree-commit">
            <Octicon symbol={octicons.gitCommit} />
            <code>{details.shortSha}</code>
            <span className="subject">{details.subject}</span>
            <span className="date">{details.relativeDate}</span>
          </div>
        )}
        <div className="worktree-meta">
          {changes !== null && (
            <span className={classNames('chip', { dirty: changes > 0 })}>
              <Octicon
                symbol={changes > 0 ? octicons.fileDiff : octicons.check}
              />
              {changes === 0
                ? 'No changes'
                : `${changes} changed file${changes === 1 ? '' : 's'}`}
            </span>
          )}
          {details.ahead !== null && details.ahead > 0 && (
            <span className="chip">
              <Octicon symbol={octicons.arrowUp} />
              {details.ahead} to push
            </span>
          )}
          {details.behind !== null && details.behind > 0 && (
            <span className="chip">
              <Octicon symbol={octicons.arrowDown} />
              {details.behind} to pull
            </span>
          )}
          {details.ahead === null && !worktree.isDetached && (
            <span className="chip muted">Not published</span>
          )}
        </div>
      </>
    )
  }

  private renderWorktree = (worktree: WorktreeEntry) => {
    const isCurrent =
      normalizePath(worktree.path) === normalizePath(this.props.repository.path)
    const branch = branchName(worktree)
    const path = worktree.path

    return (
      <li
        key={path}
        className={classNames('worktree-card', {
          current: isCurrent,
          missing: worktree.isPrunable,
        })}
      >
        <div className="worktree-main">
          <div className="worktree-title">
            <Octicon symbol={octicons.fileDirectory} />
            <span className="name">{Path.basename(path)}</span>
            {this.renderBadges(worktree, isCurrent)}
          </div>
          <div className="worktree-branch">
            <Octicon symbol={octicons.gitBranch} />
            {branch !== null ? (
              <span className="branch">{branch}</span>
            ) : (
              <span className="muted">
                Detached at {worktree.head.substring(0, 7)}
              </span>
            )}
          </div>
          <div className="worktree-path">{path}</div>
          {this.renderDetails(worktree)}
        </div>

        <div className="worktree-actions">
          {!isCurrent && !worktree.isPrunable && (
            <Button
              className="switch-button"
              onClick={this.handler('switch', path)}
              ariaLabel={`Switch to ${Path.basename(path)}`}
            >
              <Octicon symbol={octicons.arrowSwitch} />
              Switch to
            </Button>
          )}
          <div className="icon-actions">
            {!worktree.isPrunable && (
              <>
                {this.renderIconButton(
                  path,
                  'reveal',
                  octicons.fileDirectory,
                  'Show in folder'
                )}
                {this.renderIconButton(
                  path,
                  'editor',
                  octicons.code,
                  'Open in editor'
                )}
                {this.renderIconButton(
                  path,
                  'shell',
                  octicons.terminal,
                  'Open in terminal'
                )}
              </>
            )}
            {this.renderIconButton(path, 'copy', octicons.copy, 'Copy path')}
            {worktree.type !== 'main' &&
              this.renderIconButton(
                path,
                'remove',
                octicons.trash,
                'Remove worktree…'
              )}
          </div>
        </div>
      </li>
    )
  }

  private renderIconButton(
    path: string,
    action: string,
    symbol: typeof octicons.copy,
    label: string
  ) {
    return (
      <Button
        className="icon-button"
        onClick={this.handler(action, path)}
        tooltip={label}
        ariaLabel={label}
      >
        <Octicon symbol={symbol} />
      </Button>
    )
  }

  public render() {
    const { worktrees, error, isLoading } = this.state
    const count = worktrees?.length ?? 0

    return (
      <Dialog
        id="worktree-viewer"
        title={`Worktrees — ${
          this.props.repository.alias ?? this.props.repository.name
        }`}
        onDismissed={this.props.onDismissed}
        onSubmit={this.props.onDismissed}
      >
        <DialogContent>
          <div className="worktree-viewer-toolbar">
            <span className="summary">
              {worktrees === null
                ? 'Loading worktrees…'
                : `${count} worktree${count === 1 ? '' : 's'}`}
            </span>
            <Button onClick={this.load} disabled={isLoading}>
              <Octicon
                symbol={octicons.sync}
                className={isLoading ? 'spin' : undefined}
              />
              Refresh
            </Button>
            <Button onClick={this.onNewWorktree}>
              <Octicon symbol={octicons.plus} />
              New worktree…
            </Button>
          </div>

          {error !== null && <div className="worktree-error">{error}</div>}

          {worktrees !== null && (
            <ul className="worktree-cards">
              {worktrees.map(this.renderWorktree)}
            </ul>
          )}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Close"
            cancelButtonVisible={false}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
