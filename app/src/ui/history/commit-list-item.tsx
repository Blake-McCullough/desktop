/**
 * This a11y linter is a false-positive as the element is a drop target
 * facilitating our drag and drop functionality for reordering, squashing, and
 * cherry-picking.
 */
/* eslint-disable jsx-a11y/no-static-element-interactions */
import * as React from 'react'
import { Disposable } from 'event-kit'
import { Commit } from '../../models/commit'
import { Repository } from '../../models/repository'
import { GitHubRepository } from '../../models/github-repository'
import { IAvatarUser, getAvatarUsersForCommit } from '../../models/avatar'
import { RichText } from '../lib/rich-text'
import { RelativeTime } from '../relative-time'
import { CommitAttribution } from '../lib/commit-attribution'
import { AvatarStack } from '../lib/avatar-stack'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Draggable } from '../lib/draggable'
import { dragAndDropManager } from '../../lib/drag-and-drop-manager'
import {
  DragType,
  DropTargetSelector,
  DropTargetType,
} from '../../models/drag-drop'
import classNames from 'classnames'
import { Account } from '../../models/account'
import { Emoji } from '../../lib/emoji'
import { enableAccessibleListToolTips } from '../../lib/feature-flag'
import { TooltippedContent } from '../lib/tooltipped-content'
import { formatDate } from '../../lib/format-date'
import {
  IGitLabJobStatus,
  getJobStatusColor,
  GitLabJobStatusColor,
} from '../../lib/gitlab/gitlab-api'
import { gitLabPipelineStatusStore } from '../../lib/stores/gitlab-pipeline-status-store'

interface ICommitProps {
  /**
   * The repository this commit belongs to, if known. Used to look up
   * GitLab pipeline statuses for this commit. `null`/`undefined` disables
   * the pipeline status dot entirely.
   */
  readonly repository?: Repository | null
  readonly gitHubRepository: GitHubRepository | null
  readonly commit: Commit
  readonly selectedCommits: ReadonlyArray<Commit>
  readonly emoji: Map<string, Emoji>
  readonly onRenderCommitDragElement?: (commit: Commit) => void
  readonly onRemoveDragElement?: () => void
  readonly onSquash?: (
    toSquash: ReadonlyArray<Commit>,
    squashOnto: Commit,
    isInvokedByContextMenu: boolean
  ) => void
  /**
   * Whether or not the commit can be dragged for certain operations like squash,
   * cherry-pick, reorder, etc. Defaults to false.
   */
  readonly isDraggable?: boolean
  readonly showUnpushedIndicator: boolean
  readonly disableSquashing?: boolean
  readonly unpushedIndicatorTitle?: string
  readonly accounts: ReadonlyArray<Account>
  readonly preferAbsoluteDates: boolean
}

interface ICommitListItemState {
  readonly avatarUsers: ReadonlyArray<IAvatarUser>

  /**
   * Cached GitLab CI/CD job statuses for this commit, or `undefined` if
   * none are cached (yet, or because there's no resolvable GitLab
   * repository/token).
   */
  readonly gitLabJobStatuses: ReadonlyArray<IGitLabJobStatus> | undefined
}

/** A component which displays a single commit in a commit list. */
export class CommitListItem extends React.PureComponent<
  ICommitProps,
  ICommitListItemState
> {
  public constructor(props: ICommitProps) {
    super(props)

    this.state = {
      avatarUsers: getAvatarUsersForCommit(
        props.gitHubRepository,
        props.commit
      ),
      gitLabJobStatuses: undefined,
    }
  }

  private gitLabPipelineStatusSubscription: Disposable | null = null

  public componentDidMount() {
    this.gitLabPipelineStatusSubscription = gitLabPipelineStatusStore.onDidUpdate(
      () => this.refreshGitLabJobStatuses()
    )
    this.refreshGitLabJobStatuses()
  }

  public componentWillUnmount() {
    if (this.gitLabPipelineStatusSubscription !== null) {
      this.gitLabPipelineStatusSubscription.dispose()
      this.gitLabPipelineStatusSubscription = null
    }
  }

  public componentWillReceiveProps(nextProps: ICommitProps) {
    if (nextProps.commit !== this.props.commit) {
      this.setState({
        avatarUsers: getAvatarUsersForCommit(
          nextProps.gitHubRepository,
          nextProps.commit
        ),
      })
    }

    if (
      nextProps.commit !== this.props.commit ||
      nextProps.repository !== this.props.repository
    ) {
      this.refreshGitLabJobStatuses(nextProps)
    }
  }

  private refreshGitLabJobStatuses = (props: ICommitProps = this.props) => {
    const { repository, commit } = props
    if (repository === null || repository === undefined) {
      return
    }

    const statuses = gitLabPipelineStatusStore.getOrFetchCommitStatuses(
      repository,
      commit.sha
    )

    // Only setState when the returned array reference actually changed, so
    // this doesn't cause excessive re-renders of this PureComponent as
    // `onDidUpdate` fires for unrelated repositories/commits too.
    if (statuses !== this.state.gitLabJobStatuses) {
      this.setState({ gitLabJobStatuses: statuses })
    }
  }

  private onMouseUp = () => {
    const { onSquash, selectedCommits, commit, disableSquashing } = this.props
    if (
      disableSquashing !== true &&
      dragAndDropManager.isDragOfTypeInProgress(DragType.Commit) &&
      onSquash !== undefined &&
      // don't squash if dragging one commit and dropping onto itself
      selectedCommits.filter(c => c.sha !== commit.sha).length > 0
    ) {
      onSquash(selectedCommits, commit, false)
    }
  }

  private onMouseEnter = () => {
    const { selectedCommits, commit, disableSquashing } = this.props
    const isSelected =
      selectedCommits.find(c => c.sha === commit.sha) !== undefined
    if (
      disableSquashing !== true &&
      dragAndDropManager.isDragOfTypeInProgress(DragType.Commit) &&
      !isSelected
    ) {
      dragAndDropManager.emitEnterDropTarget({
        type: DropTargetType.Commit,
      })
    }
  }

  private onMouseLeave = () => {
    if (dragAndDropManager.isDragOfTypeInProgress(DragType.Commit)) {
      dragAndDropManager.emitLeaveDropTarget()
    }
  }

  public render() {
    const { commit } = this.props
    const {
      author: { date },
    } = commit

    const isDraggable = this.props.isDraggable || false
    const hasEmptySummary = commit.summary.length === 0
    const commitSummary = hasEmptySummary
      ? 'Empty commit message'
      : commit.summary

    const summaryClassNames = classNames('summary', {
      'empty-summary': hasEmptySummary,
    })

    return (
      <Draggable
        isEnabled={isDraggable}
        onDragStart={this.onDragStart}
        onRenderDragElement={this.onRenderCommitDragElement}
        onRemoveDragElement={this.onRemoveDragElement}
        dropTargetSelectors={[
          DropTargetSelector.Branch,
          DropTargetSelector.PullRequest,
          DropTargetSelector.Commit,
          DropTargetSelector.ListInsertionPoint,
        ]}
      >
        <div
          className="commit"
          onMouseEnter={this.onMouseEnter}
          onMouseLeave={this.onMouseLeave}
          onMouseUp={this.onMouseUp}
        >
          <div className="info">
            <RichText
              className={summaryClassNames}
              emoji={this.props.emoji}
              text={commitSummary}
              renderUrlsAsLinks={false}
            />
            <div className="description">
              <AvatarStack
                users={this.state.avatarUsers}
                accounts={this.props.accounts}
                tooltip={!enableAccessibleListToolTips()}
              />
              <div className="byline">
                <CommitAttribution avatarUsers={this.state.avatarUsers} />
                {renderRelativeTime(date, this.props.preferAbsoluteDates)}
              </div>
            </div>
          </div>
          {this.renderCommitIndicators()}
        </div>
      </Draggable>
    )
  }

  private renderCommitIndicators() {
    const tagIndicator = renderCommitListItemTags(this.props.commit.tags)
    const unpushedIndicator = this.renderUnpushedIndicator()
    const gitLabPipelineIndicator = this.renderGitLabPipelineIndicator()

    if (tagIndicator || unpushedIndicator || gitLabPipelineIndicator) {
      return (
        <div className="commit-indicators">
          {tagIndicator}
          {unpushedIndicator}
          {gitLabPipelineIndicator}
        </div>
      )
    }

    return null
  }

  private renderGitLabPipelineIndicator() {
    const { gitLabJobStatuses } = this.state
    if (gitLabJobStatuses === undefined || gitLabJobStatuses.length === 0) {
      return null
    }

    const color = getAggregateJobStatusColor(gitLabJobStatuses)
    const tooltip = gitLabJobStatuses
      .map(job => `${job.name}: ${job.status}`)
      .join('\n')

    return (
      <TooltippedContent
        tagName="div"
        className="gitlab-pipeline-indicator"
        tooltip={tooltip}
        disabled={enableAccessibleListToolTips()}
      >
        <span className={`gitlab-job-dot gitlab-job-dot-${color}`} />
      </TooltippedContent>
    )
  }

  private renderUnpushedIndicator() {
    if (!this.props.showUnpushedIndicator) {
      return null
    }

    return (
      <TooltippedContent
        tagName="div"
        className="unpushed-indicator"
        tooltip={this.props.unpushedIndicatorTitle}
        disabled={enableAccessibleListToolTips()}
      >
        <Octicon symbol={octicons.arrowUp} />
      </TooltippedContent>
    )
  }

  private onDragStart = () => {
    // Removes active status from commit selection so they do not appear
    // highlighted in commit list.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    dragAndDropManager.setDragData({
      type: DragType.Commit,
      commits: this.props.selectedCommits,
    })
  }

  private onRenderCommitDragElement = () => {
    if (this.props.onRenderCommitDragElement !== undefined) {
      this.props.onRenderCommitDragElement(this.props.commit)
    }
  }

  private onRemoveDragElement = () => {
    if (this.props.onRemoveDragElement !== undefined) {
      this.props.onRemoveDragElement()
    }
  }
}

function renderRelativeTime(date: Date, preferAbsoluteDates: boolean) {
  return (
    <>
      {` • `}
      {preferAbsoluteDates ? (
        formatDate(date)
      ) : (
        <RelativeTime date={date} tooltip={!enableAccessibleListToolTips()} />
      )}
    </>
  )
}

/**
 * Pick the "worst" status across a commit's GitLab CI/CD jobs to represent
 * as a single aggregated dot, using this priority order (worst first):
 * failed (red) > running/pending/created (yellow) >
 * canceled/skipped/manual (grey) > success (green).
 */
function getAggregateJobStatusColor(
  jobStatuses: ReadonlyArray<IGitLabJobStatus>
): GitLabJobStatusColor {
  const statuses = new Set(jobStatuses.map(job => job.status))

  if (statuses.has('failed')) {
    return 'red'
  }

  if (
    statuses.has('running') ||
    statuses.has('pending') ||
    statuses.has('created')
  ) {
    return 'yellow'
  }

  if (
    statuses.has('canceled') ||
    statuses.has('skipped') ||
    statuses.has('manual')
  ) {
    return 'grey'
  }

  // Only remaining case per the priority order is everything being
  // `success` (or some other/unknown status, which getJobStatusColor also
  // treats as grey).
  return jobStatuses.every(job => job.status === 'success')
    ? 'green'
    : getJobStatusColor(jobStatuses[0].status)
}

function renderCommitListItemTags(tags: ReadonlyArray<string>) {
  if (tags.length === 0) {
    return null
  }
  const [firstTag] = tags
  return (
    <span className="tag-indicator">
      <span className="tag-name" key={firstTag}>
        {firstTag}
      </span>
      {tags.length > 1 && (
        <span key={tags.length} className="tag-indicator-more" />
      )}
    </span>
  )
}
