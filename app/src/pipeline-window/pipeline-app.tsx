import * as React from 'react'
import { createWriteStream } from 'fs'
import { Readable } from 'stream'
import { pipeline as streamPipeline } from 'stream/promises'
import * as Path from 'path'
import { ipcRenderer } from 'electron'
import { IPipelineWindowRequest } from '../lib/pipeline-window-shared'
import {
  GitLabApiError,
  IGitLabProject,
  formatStatus,
  getJobStatusColor,
  isActiveStatus,
} from '../lib/gitlab/gitlab-api'
import { getGitLabToken } from '../lib/gitlab/gitlab-token'
import {
  IJobDetails,
  IPipelineDetails,
  IPipelineNeeds,
  JobAction,
  fetchJobArtifactsArchive,
  fetchJobLog,
  fetchPipelineDetails,
  fetchPipelineJobDetails,
  fetchPipelineNeeds,
  formatDuration,
  getJobActions,
  runJobAction,
  runPipelineAction,
} from '../lib/gitlab/pipeline-details'
import { IParsedLog, parseJobLog } from '../lib/gitlab/job-log'
import { JobLogView } from './job-log-view'
import { PipelineGraphView } from './pipeline-graph-view'
import { openExternal, showSaveDialogForWindow } from '../ui/main-process-proxy'

interface IPipelineAppProps {
  readonly request: IPipelineWindowRequest
}

interface IPipelineAppState {
  readonly pipeline: IPipelineDetails | null
  readonly jobs: ReadonlyArray<IJobDetails>
  readonly selectedJobId: number | null
  readonly log: IParsedLog | null
  readonly logLoading: boolean
  readonly error: string | null
  /** A short-lived message about the last action. */
  readonly notice: string | null
  /** Keys of actions in progress, e.g. `job:123:retry`. */
  readonly busy: ReadonlySet<string>
  readonly lastUpdated: number | null
  /** The graph of jobs, or the job list with the selected job's log. */
  readonly view: PipelineView
  /** Which jobs need which (from GraphQL); null until known or if unavailable. */
  readonly needs: IPipelineNeeds | null
}

type PipelineView = 'graph' | 'jobs'
const ViewKey = 'pipeline-window/view'

function getStoredView(): PipelineView {
  try {
    return localStorage.getItem(ViewKey) === 'jobs' ? 'jobs' : 'graph'
  } catch {
    return 'graph'
  }
}

/** How often to refresh while something is running, and when idle. */
const ActivePipelineMs = 5000
const IdlePipelineMs = 30000
const ActiveLogMs = 2500
const HiddenWindowMs = 30000

const StageOrder = (jobs: ReadonlyArray<IJobDetails>) => {
  const stages: string[] = []
  for (const job of jobs) {
    if (!stages.includes(job.stage)) {
      stages.push(job.stage)
    }
  }
  return stages
}

function statusIcon(status: string) {
  switch (status) {
    case 'success':
      return '✓'
    case 'failed':
      return '✕'
    case 'running':
      return '●'
    case 'manual':
      return '▶'
    case 'canceled':
      return '⊘'
    case 'skipped':
      return '»'
    default:
      return '○'
  }
}

function describeError(e: unknown): string {
  if (e instanceof GitLabApiError) {
    if (e.isUnauthorized) {
      return 'GitLab rejected the token for this server. Check it in Options → GitLab.'
    }
    if (e.isForbidden) {
      return 'GitLab refused: the token needs the "api" scope, and you need Developer access to the project.'
    }
  }
  return e instanceof Error ? e.message : `${e}`
}

function StatusBadge(props: { readonly status: string }) {
  return (
    <span className={`status-badge status-${getJobStatusColor(props.status)}`}>
      <span aria-hidden={true}>{statusIcon(props.status)}</span>{' '}
      {formatStatus(props.status)}
    </span>
  )
}

/**
 * The pipeline window: the pipeline's jobs by stage and the selected job's
 * log, kept in sync with GitLab while anything is running.
 */
export class PipelineApp extends React.Component<
  IPipelineAppProps,
  IPipelineAppState
> {
  private readonly project: IGitLabProject
  private pipelineTimer: number | null = null
  private logTimer: number | null = null
  private logRequestId = 0
  private unmounted = false
  private readonly selectHandlers = new Map<number, () => void>()
  private readonly actionHandlers = new Map<string, () => void>()
  /** Pipeline iid whose needs we last asked for, so we ask once. */
  private needsRequestedFor: string | null = null

  public constructor(props: IPipelineAppProps) {
    super(props)
    const { webBaseUrl, hostname, projectPath } = props.request
    this.project = { webBaseUrl, hostname, projectPath }
    this.state = {
      pipeline: null,
      jobs: [],
      selectedJobId: props.request.jobId,
      log: null,
      logLoading: false,
      error: null,
      notice: null,
      busy: new Set(),
      lastUpdated: null,
      // Opened from a job's dot: show that job. Otherwise the last view used.
      view: props.request.jobId !== null ? 'jobs' : getStoredView(),
      needs: null,
    }
  }

  public componentDidMount() {
    ipcRenderer.on('pipeline-window-select-job', this.onSelectJobMessage)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.refreshPipeline()
  }

  public componentWillUnmount() {
    this.unmounted = true
    ipcRenderer.removeListener(
      'pipeline-window-select-job',
      this.onSelectJobMessage
    )
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.clearTimers()
  }

  private clearTimers() {
    if (this.pipelineTimer !== null) {
      window.clearTimeout(this.pipelineTimer)
      this.pipelineTimer = null
    }
    if (this.logTimer !== null) {
      window.clearTimeout(this.logTimer)
      this.logTimer = null
    }
  }

  /**
   * Fetch which jobs need which, for the graph. Once per pipeline, and again
   * if new job names turn up (e.g. jobs added by a retry or a child).
   */
  private async refreshNeeds(
    pipeline: IPipelineDetails,
    jobs: ReadonlyArray<IJobDetails>
  ) {
    if (pipeline.iid === null) {
      return
    }
    const known = this.state.needs?.needs
    const key = `${pipeline.iid}:${
      known === undefined ? '' : jobs.filter(j => !known.has(j.name)).length
    }`
    if (
      this.needsRequestedFor === key ||
      (known !== undefined && jobs.every(j => known.has(j.name)))
    ) {
      return
    }
    this.needsRequestedFor = key
    try {
      const token = await this.getToken()
      const needs = await fetchPipelineNeeds(this.project, pipeline.iid, token)
      if (!this.unmounted && needs !== null) {
        this.setState({ needs })
      }
    } catch (e) {
      // The graph falls back to stage order.
      log.warn('Could not load job needs for the pipeline graph', e)
    }
  }

  private onShowGraph = () => this.setView('graph', true)
  private onShowJobs = () => this.setView('jobs', true)

  /** `remember`: the view you picked becomes the default for new windows. */
  private setView(view: PipelineView, remember: boolean) {
    this.setState({ view }, () => {
      if (view === 'jobs') {
        this.refreshLog()
      }
    })
    if (remember) {
      try {
        localStorage.setItem(ViewKey, view)
      } catch {
        // Not important.
      }
    }
  }

  /** From the graph: open a job's log. */
  private onOpenJobFromGraph = (jobId: number) => {
    this.selectJob(jobId)
    this.setView('jobs', false)
  }

  private onRunJobFromGraph = (job: IJobDetails) => {
    this.jobAction(job, 'play')
  }

  private isJobRunning = (jobId: number) =>
    this.state.busy.has(`job:${jobId}:play`)

  private onVisibilityChange = () => {
    if (!document.hidden) {
      // Catch up straight away when the window comes back.
      this.refreshPipeline()
      this.refreshLog()
    }
  }

  private onSelectJobMessage = (_: unknown, jobId: number) => {
    this.selectJob(jobId)
  }

  private async getToken(): Promise<string> {
    const token = await getGitLabToken(this.project.webBaseUrl)
    if (token === null) {
      throw new Error(
        `No GitLab token is set for ${this.project.hostname}. Add one in Options → GitLab.`
      )
    }
    return token
  }

  private get selectedJob(): IJobDetails | null {
    return this.state.jobs.find(j => j.id === this.state.selectedJobId) ?? null
  }

  private isPipelineActive() {
    return (
      (this.state.pipeline !== null &&
        isActiveStatus(this.state.pipeline.status)) ||
      this.state.jobs.some(j => isActiveStatus(j.status))
    )
  }

  /* ------------------------------ refreshing ------------------------------ */

  private refreshPipeline = async () => {
    if (this.pipelineTimer !== null) {
      window.clearTimeout(this.pipelineTimer)
      this.pipelineTimer = null
    }

    try {
      const token = await this.getToken()
      const { pipelineId } = this.props.request
      const [pipeline, jobs] = await Promise.all([
        fetchPipelineDetails(this.project, pipelineId, token),
        fetchPipelineJobDetails(this.project, pipelineId, token),
      ])
      if (this.unmounted) {
        return
      }

      const previousJob = this.selectedJob
      let selectedJobId = this.state.selectedJobId
      if (selectedJobId === null || !jobs.some(j => j.id === selectedJobId)) {
        // Default to the first failed, then running, then last job.
        selectedJobId =
          (
            jobs.find(j => j.status === 'failed' && !j.allowFailure) ??
            jobs.find(j => j.status === 'running') ??
            jobs[jobs.length - 1]
          )?.id ?? null
      }

      this.setState(
        {
          pipeline,
          jobs,
          selectedJobId,
          error: null,
          lastUpdated: Date.now(),
        },
        () => {
          const job = this.selectedJob
          const changed =
            job !== null &&
            (previousJob === null ||
              previousJob.id !== job.id ||
              previousJob.status !== job.status)
          // Fetch the log when the selection appears or its job's status
          // changes (e.g. it finished: get the complete log once).
          if (changed && this.logTimer === null) {
            this.refreshLog()
          }
        }
      )
      this.refreshNeeds(pipeline, jobs)
      document.title = `Pipeline #${pipeline.id} · ${formatStatus(
        pipeline.status
      )} — ${this.props.request.repositoryName}`
    } catch (e) {
      if (!this.unmounted) {
        this.setState({ error: describeError(e) })
      }
    } finally {
      if (!this.unmounted) {
        this.pipelineTimer = window.setTimeout(
          this.refreshPipeline,
          document.hidden
            ? HiddenWindowMs
            : this.isPipelineActive()
            ? ActivePipelineMs
            : IdlePipelineMs
        )
      }
    }
  }

  private refreshLog = async () => {
    if (this.logTimer !== null) {
      window.clearTimeout(this.logTimer)
      this.logTimer = null
    }
    const job = this.selectedJob
    // The graph doesn't show logs; fetch it when you switch to the jobs.
    if (job === null || this.state.view === 'graph') {
      return
    }

    const id = ++this.logRequestId
    const hasLog = !['created', 'manual', 'skipped', 'scheduled'].includes(
      job.status
    )
    if (!hasLog) {
      this.setState({ log: null, logLoading: false })
      return
    }

    this.setState({ logLoading: this.state.log === null })
    try {
      const token = await this.getToken()
      const text = await fetchJobLog(this.project, job.id, token)
      if (this.unmounted || id !== this.logRequestId) {
        return
      }
      this.setState({ log: parseJobLog(text), logLoading: false })
    } catch (e) {
      if (!this.unmounted && id === this.logRequestId) {
        this.setState({ logLoading: false, error: describeError(e) })
      }
    } finally {
      const current = this.selectedJob
      if (
        !this.unmounted &&
        id === this.logRequestId &&
        current !== null &&
        current.id === job.id &&
        isActiveStatus(current.status)
      ) {
        this.logTimer = window.setTimeout(
          this.refreshLog,
          document.hidden ? HiddenWindowMs : ActiveLogMs
        )
      }
    }
  }

  private selectJob(jobId: number) {
    if (jobId === this.state.selectedJobId) {
      return
    }
    this.logRequestId++
    if (this.logTimer !== null) {
      window.clearTimeout(this.logTimer)
      this.logTimer = null
    }
    this.setState({ selectedJobId: jobId, log: null }, () => this.refreshLog())
  }

  private getSelectHandler(jobId: number) {
    let handler = this.selectHandlers.get(jobId)
    if (handler === undefined) {
      handler = () => this.selectJob(jobId)
      this.selectHandlers.set(jobId, handler)
    }
    return handler
  }

  /* -------------------------------- actions ------------------------------- */

  /**
   * Run an action, tracking it as busy. `fn` can return a message to show
   * instead of `notice`, or `null` for none.
   */
  private async runBusy(
    key: string,
    notice: string,
    fn: () => Promise<string | null | void>
  ) {
    if (this.state.busy.has(key)) {
      return
    }
    this.setState(prev => ({
      busy: new Set(prev.busy).add(key),
      notice: null,
      error: null,
    }))
    try {
      const result = await fn()
      if (!this.unmounted) {
        this.setState({ notice: result === undefined ? notice : result })
      }
    } catch (e) {
      if (!this.unmounted) {
        this.setState({ error: describeError(e) })
      }
    } finally {
      if (!this.unmounted) {
        this.setState(prev => {
          const busy = new Set(prev.busy)
          busy.delete(key)
          return { busy }
        })
        this.refreshPipeline()
      }
    }
  }

  private jobAction(job: IJobDetails, action: JobAction) {
    const verb =
      action === 'play'
        ? 'Started'
        : action === 'retry'
        ? 'Retrying'
        : 'Cancelling'
    return this.runBusy(
      `job:${job.id}:${action}`,
      `${verb} ${job.name}.`,
      async () => {
        const token = await this.getToken()
        const result = await runJobAction(this.project, job.id, action, token)
        // Retrying creates a new job; follow it.
        if (result !== null && result.id !== job.id) {
          this.setState({ selectedJobId: result.id, log: null })
        }
      }
    )
  }

  private pipelineAction(action: 'retry' | 'cancel') {
    const pipeline = this.state.pipeline
    if (pipeline === null) {
      return
    }
    return this.runBusy(
      `pipeline:${action}`,
      action === 'retry'
        ? 'Retrying the failed jobs.'
        : 'Cancelling the pipeline.',
      async () => {
        const token = await this.getToken()
        await runPipelineAction(this.project, pipeline.id, action, token)
      }
    )
  }

  private downloadArtifacts(job: IJobDetails) {
    return this.runBusy(
      `job:${job.id}:artifacts`,
      `Saved ${job.name}'s artifacts.`,
      async () => {
        const path = await showSaveDialogForWindow({
          title: 'Save artifacts',
          defaultPath: `${job.name.replace(/[^\w.-]+/g, '-')}-artifacts.zip`,
          filters: [{ name: 'Zip archive', extensions: ['zip'] }],
        })
        if (path === null) {
          return null
        }
        const token = await this.getToken()
        const response = await fetchJobArtifactsArchive(
          this.project,
          job.id,
          token
        )
        if (response.body === null) {
          throw new Error('GitLab sent an empty download.')
        }
        await streamPipeline(
          Readable.fromWeb(response.body as any),
          createWriteStream(path)
        )
        return `Saved ${job.name}'s artifacts to ${Path.basename(path)}.`
      }
    )
  }

  private getActionHandler(key: string, fn: () => void) {
    let handler = this.actionHandlers.get(key)
    if (handler === undefined) {
      handler = fn
      this.actionHandlers.set(key, handler)
    }
    return handler
  }

  private onRetryPipeline = () => this.pipelineAction('retry')
  private onCancelPipeline = () => this.pipelineAction('cancel')
  private onRefresh = () => {
    this.refreshPipeline()
    this.refreshLog()
  }
  private onOpenPipeline = () => {
    if (this.state.pipeline?.webUrl) {
      openExternal(this.state.pipeline.webUrl)
    }
  }

  /* ------------------------------- rendering ------------------------------ */

  public render() {
    return (
      <div id="pipeline-app">
        {this.renderHeader()}
        {(this.state.error !== null || this.state.notice !== null) && (
          <div
            className={`pipeline-banner ${
              this.state.error !== null ? 'error' : 'notice'
            }`}
            role={this.state.error !== null ? 'alert' : 'status'}
          >
            {this.state.error ?? this.state.notice}
          </div>
        )}
        {this.renderViewSwitch()}
        {this.state.view === 'graph' ? (
          <div className="pipeline-body graph">
            <PipelineGraphView
              jobs={this.state.jobs}
              needs={this.state.needs}
              selectedJobId={this.state.selectedJobId}
              onOpenJob={this.onOpenJobFromGraph}
              onRunJob={this.onRunJobFromGraph}
              isRunning={this.isJobRunning}
            />
          </div>
        ) : (
          <div className="pipeline-body">
            {this.renderJobs()}
            {this.renderJob()}
          </div>
        )}
      </div>
    )
  }

  private renderViewSwitch() {
    const { view } = this.state
    return (
      <div className="pipeline-view-switch" role="tablist" aria-label="View">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'graph'}
          className={view === 'graph' ? 'selected' : undefined}
          onClick={this.onShowGraph}
        >
          Graph
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'jobs'}
          className={view === 'jobs' ? 'selected' : undefined}
          onClick={this.onShowJobs}
        >
          Jobs and logs
        </button>
      </div>
    )
  }

  private renderHeader() {
    const { pipeline, busy } = this.state
    const { request } = this.props
    const active = this.isPipelineActive()
    const canRetry =
      pipeline !== null && ['failed', 'canceled'].includes(pipeline.status)

    return (
      <header className="pipeline-header">
        <div className="pipeline-title">
          <h1>
            Pipeline #{request.pipelineId}
            {pipeline !== null && <StatusBadge status={pipeline.status} />}
          </h1>
          <div className="pipeline-meta">
            <span>{request.projectPath}</span>
            {pipeline !== null && (
              <>
                <span>
                  on <code>{pipeline.ref}</code>
                </span>
                <span>
                  <code>{pipeline.sha.slice(0, 8)}</code>
                </span>
                {pipeline.userName !== null && (
                  <span>by {pipeline.userName}</span>
                )}
                {pipeline.duration !== null && (
                  <span>{formatDuration(pipeline.duration)}</span>
                )}
              </>
            )}
            {active && <span className="live-dot">Live</span>}
            {this.state.lastUpdated !== null && (
              <span>
                Updated {new Date(this.state.lastUpdated).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
        <div className="pipeline-actions">
          {canRetry && (
            <button
              type="button"
              onClick={this.onRetryPipeline}
              disabled={busy.has('pipeline:retry')}
            >
              Retry failed jobs
            </button>
          )}
          {active && (
            <button
              type="button"
              onClick={this.onCancelPipeline}
              disabled={busy.has('pipeline:cancel')}
            >
              Cancel pipeline
            </button>
          )}
          <button type="button" onClick={this.onRefresh}>
            Refresh
          </button>
          <button
            type="button"
            onClick={this.onOpenPipeline}
            disabled={!pipeline?.webUrl}
          >
            Open in browser
          </button>
        </div>
      </header>
    )
  }

  private renderJobs() {
    const { jobs, selectedJobId, pipeline } = this.state
    if (jobs.length === 0) {
      return (
        <nav className="pipeline-jobs empty">
          {pipeline === null ? 'Loading…' : 'This pipeline has no jobs.'}
        </nav>
      )
    }

    return (
      <nav className="pipeline-jobs" aria-label="Jobs">
        {StageOrder(jobs).map(stage => (
          <section key={stage} className="pipeline-stage">
            <h2>{stage}</h2>
            <ul>
              {jobs
                .filter(j => j.stage === stage)
                .map(job => (
                  <li key={job.id}>
                    <button
                      type="button"
                      className={`job-row status-${getJobStatusColor(
                        job.status
                      )} ${job.id === selectedJobId ? 'selected' : ''}`}
                      onClick={this.getSelectHandler(job.id)}
                      aria-current={job.id === selectedJobId}
                    >
                      <span className="job-icon" aria-hidden={true}>
                        {statusIcon(job.status)}
                      </span>
                      <span className="job-name">{job.name}</span>
                      {job.allowFailure && job.status === 'failed' && (
                        <span className="job-tag">allowed to fail</span>
                      )}
                      <span className="job-duration">
                        {formatDuration(job.duration)}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </nav>
    )
  }

  private renderJob() {
    const job = this.selectedJob
    if (job === null) {
      return <main className="pipeline-job empty">Select a job.</main>
    }

    const actions = getJobActions(job)
    const busy = (action: string) =>
      this.state.busy.has(`job:${job.id}:${action}`)
    const label: Record<JobAction, string> = {
      play: '▶ Run',
      retry: 'Retry',
      cancel: 'Cancel',
    }

    return (
      <main className="pipeline-job">
        <div className="job-header">
          <div>
            <h2>
              {job.name} <StatusBadge status={job.status} />
            </h2>
            <div className="pipeline-meta">
              <span>Stage: {job.stage}</span>
              {job.duration !== null && (
                <span>Took {formatDuration(job.duration)}</span>
              )}
              {job.queuedDuration !== null && job.queuedDuration > 1 && (
                <span>Queued {formatDuration(job.queuedDuration)}</span>
              )}
              {job.runnerDescription !== null && (
                <span>Runner: {job.runnerDescription}</span>
              )}
            </div>
          </div>
          <div className="pipeline-actions">
            {actions.map(action => (
              <button
                type="button"
                key={action}
                className={action === 'play' ? 'primary' : undefined}
                disabled={busy(action)}
                onClick={this.getActionHandler(`${job.id}:${action}`, () =>
                  this.jobAction(job, action)
                )}
              >
                {label[action]}
              </button>
            ))}
            {job.hasArchive && (
              <button
                type="button"
                disabled={busy('artifacts')}
                onClick={this.getActionHandler(`${job.id}:artifacts`, () =>
                  this.downloadArtifacts(job)
                )}
              >
                {busy('artifacts') ? 'Downloading…' : 'Download artifacts'}
              </button>
            )}
            <button
              type="button"
              disabled={job.webUrl.length === 0}
              onClick={this.getActionHandler(`${job.id}:open`, () =>
                openExternal(job.webUrl)
              )}
            >
              Open in browser
            </button>
          </div>
        </div>
        <JobLogView
          key={job.id}
          log={this.state.log}
          isLoading={this.state.logLoading}
          isLive={isActiveStatus(job.status)}
          emptyMessage={
            job.status === 'manual'
              ? 'This is a manual job. Run it to start it.'
              : job.status === 'created' || job.status === 'scheduled'
              ? 'This job hasn’t started yet.'
              : job.status === 'skipped'
              ? 'This job was skipped.'
              : 'No log output.'
          }
        />
      </main>
    )
  }
}
