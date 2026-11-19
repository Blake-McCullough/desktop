import * as React from 'react'
import { Disposable } from 'event-kit'
import { ToolbarDropdown, DropdownState } from '../toolbar'
import * as octicons from '../octicons/octicons.generated'
import { Octicon } from '../octicons'
import { Button } from '../lib/button'
import { TextBox } from '../lib/text-box'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import {
  IRepositoryMergeRequests,
  gitLabMergeRequestStore,
} from '../../lib/stores/gitlab-merge-request-store'
import {
  IMergeRequest,
  IMergeRequestDetails,
  describeMergeStatus,
  getCreateMergeRequestUrl,
} from '../../lib/gitlab/merge-requests'
import { formatStatus, getJobStatusColor } from '../../lib/gitlab/gitlab-api'
import { showPipelineWindow } from '../main-process-proxy'
import { RelativeTime } from '../relative-time'

interface IMergeRequestButtonProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  /** The checked-out branch, or null when HEAD is detached. */
  readonly branchName: string | null
  /** Whether the branch has been pushed (has an upstream). */
  readonly isBranchPublished: boolean
  /** The repository's default branch name, if known. */
  readonly defaultBranchName: string | null
  readonly enableFocusTrap: boolean
}

interface IMergeRequestButtonState {
  readonly dropdownState: DropdownState
  readonly mergeRequests: IRepositoryMergeRequests
  readonly filter: string
}

const capitalize = (text: string) =>
  text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)

/** How often to refresh while the app is in use. */
const RefreshIntervalMs = 60 * 1000

/**
 * The toolbar button for GitLab merge requests: the current branch's merge
 * request (approvals, pipeline) at a glance, a way to create one, and the
 * project's open merge requests to check out.
 */
export class MergeRequestButton extends React.Component<
  IMergeRequestButtonProps,
  IMergeRequestButtonState
> {
  private subscription: Disposable | null = null
  private timer: number | null = null
  private readonly checkoutHandlers = new Map<number, () => void>()
  private readonly openHandlers = new Map<number, () => void>()

  public constructor(props: IMergeRequestButtonProps) {
    super(props)
    this.state = {
      dropdownState: 'closed',
      mergeRequests: gitLabMergeRequestStore.getState(props.repository),
      filter: '',
    }
  }

  public componentDidMount() {
    this.subscription = gitLabMergeRequestStore.onDidUpdate(id => {
      if (id === this.props.repository.id) {
        this.setState({
          mergeRequests: gitLabMergeRequestStore.getState(
            this.props.repository
          ),
        })
      }
    })
    this.refresh()
    this.timer = window.setInterval(() => {
      if (!document.hidden) {
        this.refresh()
      }
    }, RefreshIntervalMs)
  }

  public componentDidUpdate(prevProps: IMergeRequestButtonProps) {
    if (
      prevProps.repository.id !== this.props.repository.id ||
      prevProps.branchName !== this.props.branchName ||
      prevProps.isBranchPublished !== this.props.isBranchPublished
    ) {
      this.setState({
        mergeRequests: gitLabMergeRequestStore.getState(this.props.repository),
      })
      this.refresh()
    }
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
    if (this.timer !== null) {
      window.clearInterval(this.timer)
    }
  }

  private refresh = () => {
    gitLabMergeRequestStore.refresh(
      this.props.repository,
      this.props.branchName
    )
  }

  private onDropdownStateChanged = (dropdownState: DropdownState) => {
    this.setState({ dropdownState })
    if (dropdownState === 'open') {
      this.refresh()
    }
  }

  private close() {
    this.setState({ dropdownState: 'closed' })
  }

  private onCreate = () => {
    const { project } = this.state.mergeRequests
    const { branchName, defaultBranchName } = this.props
    if (project === null || branchName === null) {
      return
    }
    this.close()
    this.props.dispatcher.openInBrowser(
      getCreateMergeRequestUrl(
        project,
        branchName,
        defaultBranchName ?? undefined
      )
    )
  }

  private onOpenCurrent = () => {
    const current = this.state.mergeRequests.current
    if (current !== null) {
      this.close()
      this.props.dispatcher.openInBrowser(current.webUrl)
    }
  }

  private onOpenPipeline = () => {
    const { project, current } = this.state.mergeRequests
    if (project === null || current?.pipeline == null) {
      return
    }
    this.close()
    showPipelineWindow({
      webBaseUrl: project.webBaseUrl,
      hostname: project.hostname,
      projectPath: project.projectPath,
      pipelineId: current.pipeline.id,
      jobId: null,
      repositoryName: this.props.repository.alias ?? this.props.repository.name,
    })
  }

  private onFilterChanged = (filter: string) => {
    this.setState({ filter })
  }

  private getCheckout(mr: IMergeRequest) {
    let handler = this.checkoutHandlers.get(mr.iid)
    if (handler === undefined) {
      handler = () => {
        const { project } = this.state.mergeRequests
        if (project === null) {
          return
        }
        this.close()
        this.props.dispatcher.checkoutGitLabMergeRequest(
          this.props.repository,
          project,
          mr
        )
      }
      this.checkoutHandlers.set(mr.iid, handler)
    }
    return handler
  }

  private getOpen(mr: IMergeRequest) {
    let handler = this.openHandlers.get(mr.iid)
    if (handler === undefined) {
      handler = () => {
        this.close()
        this.props.dispatcher.openInBrowser(mr.webUrl)
      }
      this.openHandlers.set(mr.iid, handler)
    }
    return handler
  }

  /** Branches you'd normally merge into rather than from. */
  private get isOnDefaultBranch() {
    const { branchName, defaultBranchName } = this.props
    return branchName !== null && branchName === defaultBranchName
  }

  public render() {
    const { mergeRequests } = this.state
    // Only for GitLab repositories (unknown until the first lookup).
    if (mergeRequests.project === null) {
      return null
    }

    const { current, list } = mergeRequests
    let title: string
    let description: string | JSX.Element
    let icon = octicons.gitPullRequest

    // `description` is the small line above, `title` the main one.
    if (current !== null) {
      title = current.title
      description = this.renderButtonSummary(current)
      if (current.draft) {
        icon = octicons.gitPullRequestDraft
      }
    } else if (
      this.props.branchName !== null &&
      this.props.isBranchPublished &&
      !this.isOnDefaultBranch
    ) {
      title = __DARWIN__ ? 'Create Merge Request' : 'Create merge request'
      description = 'No merge request yet'
    } else {
      description = __DARWIN__ ? 'Merge Requests' : 'Merge requests'
      title =
        list.length === 0
          ? mergeRequests.isLoading
            ? 'Loading…'
            : 'None open'
          : `${list.length} open`
    }

    return (
      <ToolbarDropdown
        className="merge-request-button"
        icon={icon}
        title={title}
        description={description}
        tooltip={current !== null ? `!${current.iid} ${current.title}` : title}
        onlyShowTooltipWhenOverflowed={true}
        dropdownState={this.state.dropdownState}
        onDropdownStateChanged={this.onDropdownStateChanged}
        dropdownContentRenderer={this.renderDropdown}
        enableFocusTrap={this.props.enableFocusTrap}
        // It's the last toolbar button: open against the window's right edge.
        foldoutStyleOverrides={{ width: 420, marginLeft: undefined, right: 0 }}
      />
    )
  }

  /** e.g. "1/2 approvals · ● Running". */
  private renderButtonSummary(mr: IMergeRequestDetails) {
    const parts: Array<JSX.Element> = []
    if (mr.approvals !== null && mr.approvals.required > 0) {
      const given = mr.approvals.required - mr.approvals.left
      parts.push(
        <span key="approvals">
          {given}/{mr.approvals.required} approvals
        </span>
      )
    } else if (mr.approvals !== null && mr.approvals.approvedBy.length > 0) {
      parts.push(<span key="approvals">Approved</span>)
    }
    if (mr.pipeline !== null) {
      parts.push(
        <span
          key="pipeline"
          className={`mr-pipeline status-${getJobStatusColor(
            mr.pipeline.status
          )}`}
        >
          ● {capitalize(formatStatus(mr.pipeline.status))}
        </span>
      )
    }
    parts.unshift(<span key="iid">!{mr.iid}</span>)
    return (
      <span className="mr-summary">
        {parts.map((p, i) => (
          <React.Fragment key={i}>
            {i > 0 && ' · '}
            {p}
          </React.Fragment>
        ))}
      </span>
    )
  }

  private renderDropdown = () => {
    const { mergeRequests } = this.state
    return (
      <div className="merge-request-foldout">
        {mergeRequests.error !== null && (
          <div className="mr-error" role="alert">
            {mergeRequests.error}
          </div>
        )}
        {this.renderCurrent()}
        {this.renderList()}
      </div>
    )
  }

  private renderCurrent() {
    const { current, isLoading } = this.state.mergeRequests
    const { branchName, isBranchPublished } = this.props

    return (
      <section className="mr-current" aria-label="This branch">
        <h2>
          {branchName === null ? 'No branch' : `This branch: ${branchName}`}
        </h2>
        {current !== null ? (
          this.renderCurrentDetails(current)
        ) : branchName === null ? (
          <p className="mr-muted">
            Check out a branch to create a merge request.
          </p>
        ) : this.isOnDefaultBranch ? (
          <p className="mr-muted">
            This is the default branch. Merge requests usually merge other
            branches into it.
          </p>
        ) : (
          <>
            <p className="mr-muted">
              {isLoading
                ? 'Looking for a merge request…'
                : isBranchPublished
                ? 'No open merge request for this branch.'
                : 'Publish this branch to create a merge request.'}
            </p>
            <Button
              type="submit"
              onClick={this.onCreate}
              disabled={!isBranchPublished}
            >
              {__DARWIN__ ? 'Create Merge Request' : 'Create merge request'}
            </Button>
          </>
        )}
      </section>
    )
  }

  private renderCurrentDetails(mr: IMergeRequestDetails) {
    const status = describeMergeStatus(mr.mergeStatus)
    const { approvals, pipeline } = mr
    return (
      <div className="mr-details">
        <div className="mr-title">
          <Octicon
            symbol={
              mr.draft ? octicons.gitPullRequestDraft : octicons.gitPullRequest
            }
          />
          <span>
            <strong>!{mr.iid}</strong> {mr.title}
          </span>
        </div>
        <div className="mr-meta">
          {mr.sourceBranch} → {mr.targetBranch} · by {mr.authorName}
          {mr.commentCount > 0 && ` · ${mr.commentCount} comments`}
        </div>
        <ul className="mr-checks">
          {status !== null && (
            <li className={status === 'Ready to merge' ? 'good' : 'warn'}>
              {status}
            </li>
          )}
          {approvals !== null && (
            <li className={approvals.left === 0 ? 'good' : 'warn'}>
              {approvals.required > 0
                ? `${approvals.required - approvals.left} of ${
                    approvals.required
                  } approvals`
                : approvals.approvedBy.length > 0
                ? 'Approved'
                : 'No approvals required'}
              {approvals.approvedBy.length > 0 &&
                ` (${approvals.approvedBy.join(', ')})`}
            </li>
          )}
          {pipeline !== null ? (
            <li
              className={`mr-pipeline status-${getJobStatusColor(
                pipeline.status
              )}`}
            >
              Pipeline #{pipeline.id}:{' '}
              {capitalize(formatStatus(pipeline.status))}
            </li>
          ) : (
            <li className="mr-muted">No pipeline</li>
          )}
          {mr.hasConflicts && <li className="bad">Has merge conflicts</li>}
        </ul>
        <div className="mr-actions">
          <Button onClick={this.onOpenCurrent}>Open in GitLab</Button>
          {pipeline !== null && (
            <Button onClick={this.onOpenPipeline}>Open pipeline</Button>
          )}
        </div>
      </div>
    )
  }

  private renderList() {
    const { list, isLoading, updatedAt } = this.state.mergeRequests
    const needle = this.state.filter.trim().toLowerCase()
    const filtered =
      needle.length === 0
        ? list
        : list.filter(mr =>
            [mr.title, `!${mr.iid}`, mr.sourceBranch, mr.authorName]
              .join(' ')
              .toLowerCase()
              .includes(needle)
          )

    return (
      <section className="mr-list" aria-label="Open merge requests">
        <div className="mr-list-header">
          <h2>Open merge requests ({list.length})</h2>
          <Button onClick={this.refresh} disabled={isLoading}>
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
        {list.length > 5 && (
          <TextBox
            placeholder="Filter by title, branch, author or !number"
            ariaLabel="Filter merge requests"
            prefixedIcon={octicons.search}
            value={this.state.filter}
            onValueChanged={this.onFilterChanged}
          />
        )}
        {filtered.length === 0 ? (
          <p className="mr-muted">
            {list.length === 0
              ? isLoading
                ? 'Loading…'
                : 'No open merge requests.'
              : 'No merge requests match.'}
          </p>
        ) : (
          <ul>{filtered.map(mr => this.renderListItem(mr))}</ul>
        )}
        {updatedAt !== null && (
          <p className="mr-updated">
            Updated <RelativeTime date={new Date(updatedAt)} />
          </p>
        )}
      </section>
    )
  }

  private renderListItem(mr: IMergeRequest) {
    const isCurrent =
      !mr.isFromFork && mr.sourceBranch === this.props.branchName
    return (
      <li key={mr.iid} className="mr-item">
        <div className="mr-item-text">
          <div className="mr-item-title">
            {mr.draft && <span className="mr-badge">Draft</span>}
            <span>{mr.title}</span>
          </div>
          <div className="mr-meta">
            !{mr.iid} · {mr.authorName} · {mr.sourceBranch} → {mr.targetBranch}
            {mr.isFromFork && ' · from a fork'}
            {mr.hasConflicts && ' · conflicts'}
          </div>
        </div>
        <div className="mr-item-actions">
          <Button
            onClick={this.getCheckout(mr)}
            disabled={isCurrent}
            ariaLabel={`Check out !${mr.iid} ${mr.title}`}
          >
            {isCurrent ? 'Checked out' : 'Check out'}
          </Button>
          <Button
            onClick={this.getOpen(mr)}
            ariaLabel={`Open !${mr.iid} in GitLab`}
          >
            Open
          </Button>
        </div>
      </li>
    )
  }
}
