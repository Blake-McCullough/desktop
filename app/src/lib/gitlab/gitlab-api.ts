/**
 * A small, defensive GitLab REST (v4) client used for the pipeline status
 * indicators. Every request has a timeout, transient failures are retried
 * with backoff, and the number of requests in flight at once is capped so a
 * large number of repositories can never flood the network or the app.
 */

/** A parsed reference to a project (repository) hosted on a GitLab instance. */
export interface IGitLabProject {
  /** The instance hostname, e.g. `gitlab.com` (no port). */
  readonly hostname: string
  /**
   * The full namespace path of the project, including any nested subgroups,
   * e.g. `group/subgroup/project`.
   */
  readonly projectPath: string
  /**
   * Base URL of the instance's web UI, e.g. `https://gitlab.com` or
   * `https://git.example.com/gitlab` for instances served from a sub path.
   * The REST API lives at `${webBaseUrl}/api/v4`.
   */
  readonly webBaseUrl: string
}

/** A single CI/CD job for a commit, as reported by GitLab. */
export interface IGitLabJobStatus {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly stage?: string
  /** Link to the job in the GitLab web UI, when known. */
  readonly webUrl?: string
}

/** The latest pipeline (or set of commit statuses) for a commit. */
export interface IGitLabPipelineInfo {
  /** The commit the statuses belong to. */
  readonly sha: string
  /** The overall pipeline status, e.g. `success`, `running`, `failed`. */
  readonly status: string
  /** Link to the pipeline in the GitLab web UI, when known. */
  readonly webUrl?: string
  /** Jobs in stage order, without retried duplicates. */
  readonly jobs: ReadonlyArray<IGitLabJobStatus>
}

/** An error returned by the GitLab API (or a failure to reach it). */
export class GitLabApiError extends Error {
  public constructor(
    message: string,
    /** HTTP status code, or `0` for network errors and timeouts. */
    public readonly status: number
  ) {
    super(message)
    this.name = 'GitLabApiError'
  }

  /** The token is missing, invalid, expired or revoked. */
  public get isUnauthorized() {
    return this.status === 401
  }

  /** The project doesn't exist or the token can't see it. */
  public get isNotFound() {
    return this.status === 404
  }

  /** The token doesn't have the required scope for this request. */
  public get isForbidden() {
    return this.status === 403
  }
}

const RequestTimeoutMs = 15 * 1000
const MaxAttempts = 3
const MaxConcurrentRequests = 4

/** Statuses that mean the job or pipeline hasn't finished yet. */
const ActiveStatuses: ReadonlySet<string> = new Set([
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'scheduled',
])

/** Whether a job or pipeline status means it's still in progress. */
export function isActiveStatus(status: string): boolean {
  return ActiveStatuses.has(status)
}

/* ---------------------------------------------------------------------------
 * Remote URL parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse a git remote URL into a GitLab hostname and full project path.
 *
 * Handles HTTPS (`https://host[:port]/group/sub/project.git`), scp-style SSH
 * (`git@host:group/sub/project.git`) and URL-style SSH
 * (`ssh://git@host[:port]/group/sub/project.git`) remotes, including
 * arbitrarily nested subgroups.
 */
export function parseGitLabProject(remoteUrl: string): IGitLabProject | null {
  const url = remoteUrl.trim()
  let hostname: string
  let port = ''
  let path: string
  let scheme = 'https:'

  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    hostname = parsed.hostname
    path = decodeURIComponent(parsed.pathname)
    // For HTTP(S) remotes the web UI is on the same scheme and port. For
    // SSH remotes the port is the SSH port, so it says nothing about where
    // the web UI is — assume the HTTPS default.
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      scheme = parsed.protocol
      port = parsed.port
    }
  } else if (scp !== null) {
    hostname = scp[1]
    path = scp[2]
  } else {
    return null
  }

  const projectPath = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')

  // A project always lives in at least one namespace.
  if (hostname.length === 0 || !projectPath.includes('/')) {
    return null
  }

  const host = port.length > 0 ? `${hostname}:${port}` : hostname
  return {
    hostname: hostname.toLowerCase(),
    projectPath,
    webBaseUrl: `${scheme}//${host.toLowerCase()}`,
  }
}

/**
 * Normalize a user-entered instance URL (e.g. `git.example.com`,
 * `https://git.example.com/gitlab/`) to a base URL without trailing slash,
 * or `null` if it isn't usable.
 */
export function normalizeInstanceUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return null
  }

  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const parsed = new URL(withScheme)
    if (parsed.hostname.length === 0) {
      return null
    }
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`
  } catch {
    return null
  }
}

/**
 * Work out whether a project lives on a GitLab instance we should talk to,
 * and if so which base URL to use for it.
 *
 * A host counts as GitLab when it's listed in `instanceUrls` (configured in
 * Preferences → GitLab) or, as a fallback, when its name contains "gitlab".
 * Configured instances win so that self-hosted instances served from a sub
 * path or over plain HTTP get the right API base URL.
 */
export function resolveGitLabInstance(
  project: IGitLabProject,
  instanceUrls: ReadonlyArray<string>
): IGitLabProject | null {
  for (const instanceUrl of instanceUrls) {
    try {
      const parsed = new URL(instanceUrl)
      if (parsed.hostname.toLowerCase() !== project.hostname) {
        continue
      }

      // When the instance is served from a sub path (e.g. /gitlab), HTTPS
      // remotes include it at the start of the project path. Strip it so
      // we're left with the namespace path the API expects.
      const subPath = parsed.pathname.replace(/^\/+|\/+$/g, '')
      let projectPath = project.projectPath
      if (subPath.length > 0 && projectPath.startsWith(`${subPath}/`)) {
        projectPath = projectPath.substring(subPath.length + 1)
      }

      return { ...project, projectPath, webBaseUrl: instanceUrl }
    } catch {
      continue
    }
  }

  return project.hostname.includes('gitlab') ? project : null
}

/**
 * Best-effort heuristic for whether a hostname looks like a GitLab instance.
 * Prefer `resolveGitLabInstance`, which also honours configured instances.
 */
export function isLikelyGitLabHost(hostname: string): boolean {
  return hostname.toLowerCase().includes('gitlab')
}

/* ---------------------------------------------------------------------------
 * Request plumbing
 * ------------------------------------------------------------------------- */

let activeRequests = 0
const requestQueue: Array<() => void> = []

async function withRequestSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRequests >= MaxConcurrentRequests) {
    await new Promise<void>(resolve => requestQueue.push(resolve))
  }

  activeRequests++
  try {
    return await fn()
  } finally {
    activeRequests--
    requestQueue.shift()?.()
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function isRetryable(status: number) {
  return status === 0 || status === 429 || status >= 500
}

function getRetryDelay(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get('Retry-After')
  if (retryAfter != null) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return Math.min(seconds, 60) * 1000
    }
  }

  // 1s, 2s, 4s … with a little jitter so many repositories don't retry in
  // lock step.
  const jitter = crypto.getRandomValues(new Uint8Array(1))[0]
  return 1000 * 2 ** (attempt - 1) + jitter
}

function apiUrl(project: Pick<IGitLabProject, 'webBaseUrl'>, path: string) {
  return `${project.webBaseUrl}/api/v4${path}`
}

function projectApiPath(project: IGitLabProject) {
  return `/projects/${encodeURIComponent(project.projectPath)}`
}

/**
 * Make a request to the GitLab API and parse the JSON body.
 *
 * Throws a `GitLabApiError` for non-2xx responses (after retrying transient
 * ones) and for network errors or timeouts.
 */
async function gitLabRequest<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' = 'GET'
): Promise<T> {
  let lastError: GitLabApiError | null = null

  for (let attempt = 1; attempt <= MaxAttempts; attempt++) {
    let response: Response | null = null

    try {
      response = await withRequestSlot(async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), RequestTimeoutMs)
        try {
          return await fetch(url, {
            method,
            headers: {
              'PRIVATE-TOKEN': token,
              Accept: 'application/json',
            },
            signal: controller.signal,
            cache: 'no-store',
          })
        } finally {
          clearTimeout(timeout)
        }
      })
    } catch (e) {
      const reason =
        e instanceof Error && e.name === 'AbortError'
          ? `timed out after ${RequestTimeoutMs / 1000}s`
          : `${e instanceof Error ? e.message : e}`
      lastError = new GitLabApiError(`Couldn't reach GitLab: ${reason}`, 0)
    }

    if (response !== null) {
      if (response.ok) {
        // Some endpoints (e.g. play) can legitimately return an empty body.
        const text = await response.text()
        return (text.length > 0 ? JSON.parse(text) : null) as T
      }

      let detail = ''
      try {
        const body = await response.json()
        detail = body?.message ?? body?.error ?? ''
        if (typeof detail !== 'string') {
          detail = JSON.stringify(detail)
        }
      } catch {
        // Not JSON — ignore.
      }

      lastError = new GitLabApiError(
        `GitLab returned ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status
      )
    }

    if (
      lastError === null ||
      !isRetryable(lastError.status) ||
      attempt === MaxAttempts
    ) {
      break
    }

    await delay(getRetryDelay(response, attempt))
  }

  throw lastError ?? new GitLabApiError('Unknown GitLab error', 0)
}

/* ---------------------------------------------------------------------------
 * Endpoints
 * ------------------------------------------------------------------------- */

interface IApiPipeline {
  readonly id: number
  readonly status: string
  readonly web_url?: string
}

interface IApiJob {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly stage?: string
  readonly web_url?: string
}

interface IApiCommitStatus {
  readonly id: number
  readonly name?: string
  readonly ref?: string
  readonly status?: string
  readonly target_url?: string | null
  readonly created_at?: string
}

/**
 * Fetch the latest pipeline for a commit along with its jobs.
 *
 * Uses the pipelines API (latest pipeline only, retried jobs excluded) and
 * falls back to the commit statuses API for commits whose statuses come from
 * an external CI system. Returns `null` when the commit has no pipeline or
 * statuses at all.
 *
 * Throws a `GitLabApiError` on failure.
 */
export async function fetchPipelineForCommit(
  project: IGitLabProject,
  sha: string,
  token: string
): Promise<IGitLabPipelineInfo | null> {
  const base = projectApiPath(project)
  const pipelines = await gitLabRequest<ReadonlyArray<IApiPipeline>>(
    apiUrl(
      project,
      `${base}/pipelines?sha=${encodeURIComponent(
        sha
      )}&order_by=id&sort=desc&per_page=1`
    ),
    token
  )

  if (Array.isArray(pipelines) && pipelines.length > 0) {
    const pipeline = pipelines[0]
    const jobs = await gitLabRequest<ReadonlyArray<IApiJob>>(
      apiUrl(project, `${base}/pipelines/${pipeline.id}/jobs?per_page=100`),
      token
    )

    return {
      sha,
      status: pipeline.status,
      webUrl: pipeline.web_url,
      jobs: (Array.isArray(jobs) ? jobs : [])
        .map(job => ({
          id: job.id,
          name: `${job.name}`,
          status: `${job.status ?? 'unknown'}`,
          stage: job.stage,
          webUrl: job.web_url,
        }))
        // Jobs are created in stage order, so ascending id is a reliable
        // display order.
        .sort((a, b) => a.id - b.id),
    }
  }

  const statuses = await gitLabRequest<ReadonlyArray<IApiCommitStatus>>(
    apiUrl(
      project,
      `${base}/repository/commits/${encodeURIComponent(
        sha
      )}/statuses?per_page=100`
    ),
    token
  )

  if (!Array.isArray(statuses) || statuses.length === 0) {
    return null
  }

  // The statuses API returns every status ever reported, including retried
  // ones. Keep only the newest per name.
  const latestByName = new Map<string, IApiCommitStatus>()
  for (const status of statuses) {
    const name = `${status.name ?? status.ref ?? 'job'}`
    const existing = latestByName.get(name)
    if (existing === undefined || status.id > existing.id) {
      latestByName.set(name, status)
    }
  }

  const jobs = [...latestByName.entries()]
    .map(([name, status]) => ({
      id: status.id,
      name,
      status: `${status.status ?? 'unknown'}`,
      webUrl: status.target_url ?? undefined,
    }))
    .sort((a, b) => a.id - b.id)

  return {
    sha,
    status: getAggregateStatus(jobs),
    jobs,
  }
}

/**
 * Trigger ("play") a manual GitLab CI/CD job so that it starts running.
 * Requires a token with the `api` scope.
 *
 * Throws a `GitLabApiError` on failure.
 */
export async function playGitLabJob(
  project: IGitLabProject,
  jobId: number,
  token: string
): Promise<void> {
  await gitLabRequest(
    apiUrl(project, `${projectApiPath(project)}/jobs/${jobId}/play`),
    token,
    'POST'
  )
}

/** The result of checking a token against an instance. */
export interface IGitLabTokenCheck {
  readonly username: string
  /** Token scopes, when the instance exposes them. */
  readonly scopes: ReadonlyArray<string> | null
  readonly expiresAt: string | null
}

/**
 * Check that a token works against an instance and report who it belongs to
 * and which scopes it has.
 *
 * Throws a `GitLabApiError` on failure.
 */
export async function checkGitLabToken(
  webBaseUrl: string,
  token: string
): Promise<IGitLabTokenCheck> {
  const user = await gitLabRequest<{ username: string }>(
    apiUrl({ webBaseUrl }, '/user'),
    token
  )

  let scopes: ReadonlyArray<string> | null = null
  let expiresAt: string | null = null
  try {
    const self = await gitLabRequest<{
      scopes?: ReadonlyArray<string>
      expires_at?: string | null
    }>(apiUrl({ webBaseUrl }, '/personal_access_tokens/self'), token)
    scopes = self?.scopes ?? null
    expiresAt = self?.expires_at ?? null
  } catch {
    // Older instances (and non-PAT tokens) don't support this endpoint.
  }

  return { username: user.username, scopes, expiresAt }
}

/* ---------------------------------------------------------------------------
 * Presentation helpers
 * ------------------------------------------------------------------------- */

/** The color a job status dot should be rendered with. */
export type GitLabJobStatusColor = 'green' | 'red' | 'yellow' | 'grey' | 'blue'

/**
 * Map a GitLab pipeline/job status string to the color that should
 * represent it in the UI.
 */
export function getJobStatusColor(status: string): GitLabJobStatusColor {
  switch (status) {
    case 'success':
      return 'green'
    case 'failed':
      return 'red'
    case 'running':
      return 'blue'
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return 'yellow'
    default:
      // canceled, skipped, manual, unknown …
      return 'grey'
  }
}

/**
 * Pick the "worst" status across a set of jobs, in the same spirit as
 * GitLab's own pipeline status: failed > running > pending > manual >
 * canceled > skipped > success.
 */
export function getAggregateStatus(
  jobs: ReadonlyArray<Pick<IGitLabJobStatus, 'status'>>
): string {
  const order = [
    'failed',
    'running',
    'pending',
    'preparing',
    'waiting_for_resource',
    'created',
    'scheduled',
    'manual',
    'canceled',
    'skipped',
    'success',
  ]

  let best = order.length
  for (const job of jobs) {
    const index = order.indexOf(job.status)
    if (index !== -1 && index < best) {
      best = index
    }
  }

  return best < order.length ? order[best] : 'unknown'
}

/** A human readable label for a status, e.g. `waiting_for_resource`. */
export function formatStatus(status: string): string {
  return status.replace(/_/g, ' ')
}
