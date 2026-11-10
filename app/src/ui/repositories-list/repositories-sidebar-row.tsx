/* eslint-disable github/a11y-no-title-attribute */
// Native `title` tooltips are used deliberately on these small, numerous
// status elements (each also has an aria-label or visible text): the shared
// TooltippedContent component attaches a ResizeObserver and about a dozen
// event listeners per element, which adds up quickly across every job of
// every repository in the sidebar.
import * as React from 'react'
import classNames from 'classnames'
import { Repository } from '../../models/repository'
import { IAheadBehind } from '../../models/branch'
import { Repositoryish } from './group-repositories'
import { RepositoryListItem } from './repository-list-item'
import { IMatches } from '../../lib/fuzzy-find'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import {
  IGitLabJobStatus,
  formatStatus,
  getJobStatusColor,
} from '../../lib/gitlab/gitlab-api'
import { IRepositoryPipelineState } from '../../lib/stores/gitlab-pipeline-status-store'

const NoMatches: IMatches = { title: [], subtitle: [] }

/** How many job dots to show before collapsing the rest into "+N". */
const MaxVisibleJobs = 8

interface IRepositoriesSidebarRowProps {
  readonly repository: Repositoryish
  readonly selected: boolean
  readonly aheadBehind: IAheadBehind | null
  readonly changedFilesCount: number
  readonly pipeline: IRepositoryPipelineState | undefined
  readonly playingJobIds: ReadonlySet<number>
  readonly isDragging: boolean

  readonly onClick: (repository: Repositoryish) => void
  readonly onContextMenu: (
    repository: Repositoryish,
    event: React.MouseEvent<HTMLDivElement>
  ) => void
  readonly onDragStart: (
    repository: Repositoryish,
    event: React.DragEvent<HTMLDivElement>
  ) => void
  readonly onDragEnd: () => void
  readonly onPlayJob: (repository: Repositoryish, job: IGitLabJobStatus) => void
  readonly onOpenUrl: (url: string) => void
}

/**
 * One repository in the sidebar. A `PureComponent` with stable callbacks so
 * that only rows whose data actually changed re-render.
 */
export class RepositoriesSidebarRow extends React.PureComponent<IRepositoriesSidebarRowProps> {
  private onClick = () => this.props.onClick(this.props.repository)

  private onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.props.onClick(this.props.repository)
    }
  }

  private onContextMenu = (event: React.MouseEvent<HTMLDivElement>) =>
    this.props.onContextMenu(this.props.repository, event)

  private onDragStart = (event: React.DragEvent<HTMLDivElement>) =>
    this.props.onDragStart(this.props.repository, event)

  private onJobClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const jobId = Number(event.currentTarget.dataset.jobId)
    const job = this.props.pipeline?.pipeline?.jobs.find(j => j.id === jobId)
    if (job === undefined) {
      return
    }

    if (job.status === 'manual') {
      this.props.onPlayJob(this.props.repository, job)
    } else if (job.webUrl !== undefined) {
      this.props.onOpenUrl(job.webUrl)
    }
  }

  private onMoreClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const url = this.props.pipeline?.pipeline?.webUrl
    if (url !== undefined) {
      this.props.onOpenUrl(url)
    }
  }

  public render() {
    const { repository, selected, isDragging } = this.props

    return (
      <div
        className={classNames('repositories-sidebar-item', 'repository-list', {
          selected,
          dragging: isDragging,
        })}
        role="button"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        draggable={true}
        onDragStart={this.onDragStart}
        onDragEnd={this.props.onDragEnd}
        onClick={this.onClick}
        onKeyDown={this.onKeyDown}
        onContextMenu={this.onContextMenu}
      >
        <RepositoryListItem
          repository={repository}
          needsDisambiguation={false}
          matches={NoMatches}
          aheadBehind={this.props.aheadBehind}
          changedFilesCount={this.props.changedFilesCount}
        />
        {repository instanceof Repository && this.renderPipeline()}
      </div>
    )
  }

  private renderPipeline() {
    const state = this.props.pipeline
    if (state === undefined) {
      return null
    }

    const { pipeline, isFetching, error } = state

    if (pipeline === null || pipeline.jobs.length === 0) {
      if (error !== null) {
        return (
          <div className="gitlab-pipeline-status">
            <span className="gitlab-pipeline-error" title={error}>
              <Octicon symbol={octicons.alert} />
            </span>
          </div>
        )
      }

      if (isFetching && pipeline === null && state.fetchedAt === 0) {
        return (
          <div className="gitlab-pipeline-status">
            <span
              className="gitlab-pipeline-loading"
              title="Fetching GitLab pipeline status…"
            />
          </div>
        )
      }

      return null
    }

    const visible = pipeline.jobs.slice(0, MaxVisibleJobs)
    const hidden = pipeline.jobs.length - visible.length

    return (
      <div
        className={classNames('gitlab-pipeline-status', {
          stale: error !== null,
          'branch-fallback': pipeline.fallbackRef !== undefined,
        })}
        title={
          error ??
          (pipeline.fallbackRef !== undefined
            ? `No pipeline for the checked-out commit — showing the latest pipeline on ${pipeline.fallbackRef}`
            : undefined)
        }
      >
        {visible.map(this.renderJob)}
        {hidden > 0 && (
          <button
            type="button"
            className="gitlab-job-more"
            onClick={this.onMoreClick}
            title={`${hidden} more job${
              hidden === 1 ? '' : 's'
            } — open pipeline`}
          >
            +{hidden}
          </button>
        )}
      </div>
    )
  }

  private renderJob = (job: IGitLabJobStatus) => {
    const label = `${job.stage ? `${job.stage} › ` : ''}${
      job.name
    }: ${formatStatus(job.status)}`

    if (job.status === 'manual') {
      const playing = this.props.playingJobIds.has(job.id)
      return (
        <button
          key={job.id}
          type="button"
          data-job-id={job.id}
          className={classNames('gitlab-job-run-button', { playing })}
          disabled={playing}
          onClick={this.onJobClick}
          title={playing ? `Starting "${job.name}"…` : `Run "${job.name}"`}
          aria-label={`Run ${job.name}`}
        >
          <Octicon
            symbol={playing ? octicons.sync : octicons.triangleRight}
            className={playing ? 'spin' : undefined}
          />
          <span className="label">{playing ? 'Running' : 'Run'}</span>
        </button>
      )
    }

    return (
      <button
        key={job.id}
        type="button"
        data-job-id={job.id}
        className={classNames(
          'gitlab-job-dot',
          `gitlab-job-dot-${getJobStatusColor(job.status)}`,
          { running: job.status === 'running' }
        )}
        onClick={this.onJobClick}
        title={job.webUrl !== undefined ? `${label} — open in GitLab` : label}
        aria-label={label}
      />
    )
  }
}
