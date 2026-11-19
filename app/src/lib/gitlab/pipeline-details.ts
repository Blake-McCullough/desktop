import {
  IGitLabProject,
  gitLabGraphQL,
  gitLabProjectRequest,
} from './gitlab-api'

/** A pipeline, as shown in the pipeline window. */
export interface IPipelineDetails {
  readonly id: number
  readonly iid: number | null
  readonly status: string
  readonly ref: string
  readonly sha: string
  readonly webUrl: string
  readonly source: string | null
  readonly createdAt: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  /** Seconds, when GitLab reports it. */
  readonly duration: number | null
  readonly userName: string | null
}

/** A job artifact file (archive, report, …). */
export interface IJobArtifact {
  readonly fileType: string
  readonly filename: string
  readonly size: number
}

/** A job, as shown in the pipeline window. */
export interface IJobDetails {
  readonly id: number
  readonly name: string
  readonly stage: string
  readonly status: string
  readonly allowFailure: boolean
  readonly webUrl: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  /** Seconds. */
  readonly duration: number | null
  readonly queuedDuration: number | null
  readonly runnerDescription: string | null
  readonly artifacts: ReadonlyArray<IJobArtifact>
  /** Whether there's a downloadable artifacts archive. */
  readonly hasArchive: boolean
}

interface IApiPipelineDetails {
  readonly id: number
  readonly iid?: number
  readonly status: string
  readonly ref: string
  readonly sha: string
  readonly web_url?: string
  readonly source?: string
  readonly created_at?: string | null
  readonly started_at?: string | null
  readonly finished_at?: string | null
  readonly duration?: number | null
  readonly user?: { readonly name?: string } | null
}

interface IApiJobDetails {
  readonly id: number
  readonly name: string
  readonly stage?: string
  readonly status: string
  readonly allow_failure?: boolean
  readonly web_url?: string
  readonly started_at?: string | null
  readonly finished_at?: string | null
  readonly duration?: number | null
  readonly queued_duration?: number | null
  readonly runner?: { readonly description?: string } | null
  readonly artifacts?: ReadonlyArray<{
    readonly file_type?: string
    readonly filename?: string
    readonly size?: number
  }>
  readonly artifacts_file?: { readonly filename?: string } | null
}

export function toPipelineDetails(p: IApiPipelineDetails): IPipelineDetails {
  return {
    id: p.id,
    iid: p.iid ?? null,
    status: p.status,
    ref: p.ref,
    sha: p.sha,
    webUrl: p.web_url ?? '',
    source: p.source ?? null,
    createdAt: p.created_at ?? null,
    startedAt: p.started_at ?? null,
    finishedAt: p.finished_at ?? null,
    duration: p.duration ?? null,
    userName: p.user?.name ?? null,
  }
}

export function toJobDetails(j: IApiJobDetails): IJobDetails {
  const artifacts = (j.artifacts ?? []).map(a => ({
    fileType: a.file_type ?? '',
    filename: a.filename ?? '',
    size: a.size ?? 0,
  }))
  return {
    id: j.id,
    name: j.name,
    stage: j.stage ?? '',
    status: j.status,
    allowFailure: j.allow_failure === true,
    webUrl: j.web_url ?? '',
    startedAt: j.started_at ?? null,
    finishedAt: j.finished_at ?? null,
    duration: j.duration ?? null,
    queuedDuration: j.queued_duration ?? null,
    runnerDescription: j.runner?.description ?? null,
    artifacts,
    hasArchive:
      artifacts.some(a => a.fileType === 'archive') ||
      (j.artifacts_file?.filename ?? '').length > 0,
  }
}

export async function fetchPipelineDetails(
  project: IGitLabProject,
  pipelineId: number,
  token: string
): Promise<IPipelineDetails> {
  return toPipelineDetails(
    await gitLabProjectRequest<IApiPipelineDetails>(
      project,
      `/pipelines/${pipelineId}`,
      token
    )
  )
}

/**
 * The pipeline's jobs (latest attempt of each), in stage order as GitLab
 * returns them, oldest first within a stage.
 */
export async function fetchPipelineJobDetails(
  project: IGitLabProject,
  pipelineId: number,
  token: string
): Promise<ReadonlyArray<IJobDetails>> {
  const jobs: IJobDetails[] = []
  for (let page = 1; page <= 5; page++) {
    const batch = await gitLabProjectRequest<ReadonlyArray<IApiJobDetails>>(
      project,
      `/pipelines/${pipelineId}/jobs?per_page=100&page=${page}`,
      token
    )
    if (!Array.isArray(batch)) {
      break
    }
    jobs.push(...batch.map(toJobDetails))
    if (batch.length < 100) {
      break
    }
  }
  // GitLab lists newest first; show them in the order they run.
  return jobs.sort((a, b) => a.id - b.id)
}

/** The job's log (trace), as plain text with ANSI escapes. */
export async function fetchJobLog(
  project: IGitLabProject,
  jobId: number,
  token: string
): Promise<string> {
  const text = await gitLabProjectRequest<string | null>(
    project,
    `/jobs/${jobId}/trace`,
    token,
    { kind: 'text' }
  )
  return text ?? ''
}

export type JobAction = 'retry' | 'cancel' | 'play'

/** Retry, cancel or run (manual) a job. Returns the job it applies to now. */
export async function runJobAction(
  project: IGitLabProject,
  jobId: number,
  action: JobAction,
  token: string
): Promise<IJobDetails | null> {
  const job = await gitLabProjectRequest<IApiJobDetails | null>(
    project,
    `/jobs/${jobId}/${action}`,
    token,
    { method: 'POST' }
  )
  return job === null ? null : toJobDetails(job)
}

/** Retry the failed jobs of a pipeline, or cancel the whole pipeline. */
export async function runPipelineAction(
  project: IGitLabProject,
  pipelineId: number,
  action: 'retry' | 'cancel',
  token: string
): Promise<void> {
  await gitLabProjectRequest(
    project,
    `/pipelines/${pipelineId}/${action}`,
    token,
    { method: 'POST' }
  )
}

/** The job's artifacts archive, as an unread response to stream to disk. */
export function fetchJobArtifactsArchive(
  project: IGitLabProject,
  jobId: number,
  token: string
): Promise<Response> {
  return gitLabProjectRequest<Response>(
    project,
    `/jobs/${jobId}/artifacts`,
    token,
    { kind: 'raw' }
  )
}

/** Whether a job can be retried, cancelled or run right now. */
export function getJobActions(job: IJobDetails): ReadonlyArray<JobAction> {
  switch (job.status) {
    case 'manual':
      return ['play']
    case 'created':
    case 'pending':
    case 'running':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return ['cancel']
    case 'success':
    case 'failed':
    case 'canceled':
      return ['retry']
    default:
      return []
  }
}

/** "1m 05s", "45s", "2h 03m". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds) || seconds < 0) {
    return ''
  }
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, '0')}m`
  }
  if (m > 0) {
    return `${m}m ${String(sec).padStart(2, '0')}s`
  }
  return `${sec}s`
}

/** Which jobs each job waits for, from GitLab's GraphQL API. */
export interface IPipelineNeeds {
  /** Stage names in pipeline order. */
  readonly stages: ReadonlyArray<string>
  /**
   * Job name → the job names it `needs`, or `null` when it simply waits for
   * the stage before it (no `needs:` keyword).
   */
  readonly needs: ReadonlyMap<string, ReadonlyArray<string> | null>
}

const PipelineNeedsQuery = `
query PipelineNeeds($fullPath: ID!, $iid: ID!, $after: String) {
  project(fullPath: $fullPath) {
    pipeline(iid: $iid) {
      stages { nodes { name } }
      jobs(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          schedulingType
          needs { nodes { name } }
        }
      }
    }
  }
}`

interface IGraphQLPipelineNeeds {
  readonly project: {
    readonly pipeline: {
      readonly stages?: {
        readonly nodes: ReadonlyArray<{ readonly name: string } | null>
      } | null
      readonly jobs: {
        readonly pageInfo: {
          readonly hasNextPage: boolean
          readonly endCursor: string | null
        }
        readonly nodes: ReadonlyArray<{
          readonly name: string
          readonly schedulingType?: string | null
          readonly needs?: {
            readonly nodes: ReadonlyArray<{ readonly name: string } | null>
          } | null
        } | null>
      } | null
    } | null
  } | null
}

/** At most this many pages of 100 jobs. */
const MaxNeedsPages = 10

/**
 * Fetch the pipeline's job dependencies (the REST API doesn't have them).
 * Returns `null` when GitLab can't tell us, e.g. an old version without
 * the GraphQL fields; the graph then falls back to stage order.
 */
export async function fetchPipelineNeeds(
  project: IGitLabProject,
  pipelineIid: number,
  token: string
): Promise<IPipelineNeeds | null> {
  const needs = new Map<string, ReadonlyArray<string> | null>()
  let stages: ReadonlyArray<string> = []
  let after: string | null = null

  for (let page = 0; page < MaxNeedsPages; page++) {
    const data: IGraphQLPipelineNeeds = await gitLabGraphQL(
      project,
      PipelineNeedsQuery,
      { fullPath: project.projectPath, iid: String(pipelineIid), after },
      token
    )
    const pipeline = data.project?.pipeline
    if (pipeline === null || pipeline === undefined || !pipeline.jobs) {
      return null
    }
    if (page === 0) {
      stages = (pipeline.stages?.nodes ?? [])
        .map(s => s?.name)
        .filter((n): n is string => typeof n === 'string')
    }
    for (const job of pipeline.jobs.nodes) {
      if (job === null) {
        continue
      }
      const names = (job.needs?.nodes ?? [])
        .map(n => n?.name)
        .filter((n): n is string => typeof n === 'string')
      needs.set(job.name, job.schedulingType === 'dag' ? names : null)
    }
    const { hasNextPage, endCursor } = pipeline.jobs.pageInfo
    if (!hasNextPage || endCursor === null) {
      break
    }
    after = endCursor
  }

  return { stages, needs }
}
