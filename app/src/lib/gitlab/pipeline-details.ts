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

/* ------------------------------ test reports ----------------------------- */

/** One test case from a pipeline's JUnit report. */
export interface ITestCase {
  readonly name: string
  readonly classname: string | null
  readonly file: string | null
  /** `success`, `failed`, `skipped` or `error`. */
  readonly status: string
  /** Seconds. */
  readonly executionTime: number | null
  /** The failure message / output GitLab recorded. */
  readonly output: string | null
  readonly stackTrace: string | null
  /** How many times it failed recently on the default branch, if known. */
  readonly recentFailures: number | null
}

/** Results for one job (GitLab names the suite after the job). */
export interface ITestSuite {
  readonly name: string
  readonly totalTime: number
  readonly totalCount: number
  readonly successCount: number
  readonly failedCount: number
  readonly skippedCount: number
  readonly errorCount: number
  /** Set when GitLab couldn't parse the suite's report. */
  readonly suiteError: string | null
  readonly testCases: ReadonlyArray<ITestCase>
}

export interface ITestReport {
  readonly totalTime: number
  readonly totalCount: number
  readonly successCount: number
  readonly failedCount: number
  readonly skippedCount: number
  readonly errorCount: number
  readonly suites: ReadonlyArray<ITestSuite>
}

interface IApiTestCase {
  readonly status?: string
  readonly name?: string
  readonly classname?: string | null
  readonly file?: string | null
  readonly execution_time?: number | null
  readonly system_output?: string | null
  readonly stack_trace?: string | null
  readonly recent_failures?: { readonly count?: number } | null
}

interface IApiTestSuite {
  readonly name?: string
  readonly total_time?: number
  readonly total_count?: number
  readonly success_count?: number
  readonly failed_count?: number
  readonly skipped_count?: number
  readonly error_count?: number
  readonly suite_error?: string | null
  readonly test_cases?: ReadonlyArray<IApiTestCase>
}

interface IApiTestReport extends IApiTestSuite {
  readonly test_suites?: ReadonlyArray<IApiTestSuite>
}

const num = (n: number | undefined | null) =>
  typeof n === 'number' && isFinite(n) ? n : 0

function toTestCase(api: IApiTestCase): ITestCase {
  // GitLab sends system_output as a string, or occasionally an array.
  const rawOutput = api.system_output as unknown
  const output = Array.isArray(rawOutput)
    ? rawOutput.join('\n')
    : typeof rawOutput === 'string'
    ? rawOutput
    : null
  return {
    name: api.name ?? '(unnamed test)',
    classname: api.classname ?? null,
    file: api.file ?? null,
    status: api.status ?? 'unknown',
    executionTime:
      typeof api.execution_time === 'number' ? api.execution_time : null,
    output: output !== null && output.trim().length > 0 ? output : null,
    stackTrace:
      typeof api.stack_trace === 'string' && api.stack_trace.trim().length > 0
        ? api.stack_trace
        : null,
    recentFailures:
      typeof api.recent_failures?.count === 'number'
        ? api.recent_failures.count
        : null,
  }
}

export function toTestReport(api: IApiTestReport): ITestReport {
  return {
    totalTime: num(api.total_time),
    totalCount: num(api.total_count),
    successCount: num(api.success_count),
    failedCount: num(api.failed_count),
    skippedCount: num(api.skipped_count),
    errorCount: num(api.error_count),
    suites: (api.test_suites ?? []).map(s => ({
      name: s.name ?? '(unnamed suite)',
      totalTime: num(s.total_time),
      totalCount: num(s.total_count),
      successCount: num(s.success_count),
      failedCount: num(s.failed_count),
      skippedCount: num(s.skipped_count),
      errorCount: num(s.error_count),
      suiteError: s.suite_error ?? null,
      testCases: (s.test_cases ?? []).map(toTestCase),
    })),
  }
}

/**
 * The pipeline's test results, parsed by GitLab from the JUnit XML files
 * its jobs list under `artifacts:reports:junit`. Empty (total 0) when no
 * job does.
 */
export async function fetchPipelineTestReport(
  project: IGitLabProject,
  pipelineId: number,
  token: string
): Promise<ITestReport> {
  const api = await gitLabProjectRequest<IApiTestReport>(
    project,
    `/pipelines/${pipelineId}/test_report`,
    token
  )
  return toTestReport(api ?? {})
}
