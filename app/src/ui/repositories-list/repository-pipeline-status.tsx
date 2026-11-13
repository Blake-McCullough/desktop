/* eslint-disable github/a11y-no-title-attribute */
// Native `title` tooltips are used deliberately on these small, numerous
// status elements (each also has an aria-label or visible text): the shared
// TooltippedContent component attaches a ResizeObserver and about a dozen
// event listeners per element, which adds up quickly across every job of
// every repository in the list.
import * as React from 'react'
import classNames from 'classnames'
import { Repository } from '../../models/repository'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import {
  IGitLabJobStatus,
  formatStatus,
  getJobStatusColor,
} from '../../lib/gitlab/gitlab-api'
import { IRepositoryPipelineState } from '../../lib/stores/gitlab-pipeline-status-store'

/** How many job dots to show before collapsing the rest into "+N". */
const MaxVisibleJobs = 8

interface IRepositoryPipelineStatusProps {
  readonly repository: Repository
  readonly pipeline: IRepositoryPipelineState | undefined
  readonly playingJobIds: ReadonlySet<number>
  readonly onPlayJob: (repository: Repository, job: IGitLabJobStatus) => void
  readonly onOpenUrl: (url: string) => void
}

/**
 * The GitLab pipeline of a repository's latest pushed commit: a dot per job,
 * and Run buttons for manual jobs. Used by the sidebar and the toolbar's
 * repository list.
 */
export class RepositoryPipelineStatus extends React.PureComponent<IRepositoryPipelineStatusProps> {
  // Keep clicks on dots and buttons from also selecting the row.
  private stopMouseDown = (event: React.MouseEvent) => event.stopPropagation()

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
    return this.renderPipeline()
  }

  private renderPipeline() {
    const state = this.props.pipeline
    if (state === undefined) {
      return null
    }

    const { pipeline, isFetching, error } = state

    if (pipeline === null || pipeline.jobs.length === 0) {
      // Just pushed and GitLab hasn't created the pipeline yet. Show that
      // (with no jobs or Run buttons) rather than an older pipeline.
      if (
        state.awaitingPipeline &&
        state.pushedSha !== null &&
        error === null
      ) {
        const short = state.pushedSha.substring(0, 7)
        return (
          <div className="gitlab-pipeline-status">
            <span
              className="gitlab-pipeline-awaiting"
              title={`Waiting for GitLab to start a pipeline for ${short}, the latest pushed commit`}
              role="img"
              aria-label={`Waiting for a pipeline for ${short}`}
            />
          </div>
        )
      }

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
        })}
        title={
          error ??
          `Pipeline for ${pipeline.sha.substring(
            0,
            7
          )}, the latest pushed commit`
        }
      >
        {visible.map(this.renderJob)}
        {hidden > 0 && (
          <button
            type="button"
            onMouseDown={this.stopMouseDown}
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
          onMouseDown={this.stopMouseDown}
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
        onMouseDown={this.stopMouseDown}
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
