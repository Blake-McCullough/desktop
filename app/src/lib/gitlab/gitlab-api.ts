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
  /**
   * Set when the commit itself had no pipeline and this is instead the
   * latest pipeline on its branch (e.g. HEAD has unpushed commits).
   */
  readonly fallbackRef?: string
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

  /** GitLab (or our own budget) says to slow down. */
  public get isRateLimited() {
    return this.status === 429
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

/**
 * Client-side request budget per GitLab instance: a token bucket allowing
 * short bursts but averaging at most `RequestsPerMinute`. Well under
 * GitLab's own limits, so the app can't trip them on its own.
 */
const RequestsPerMinute = 60
const BurstSize = 10

/** Never wait less than this after GitLab says we're rate limited. */
const MinRateLimitPauseMs = 60 * 1000
const MaxRateLimitPauseMs = 15 * 60 * 1000

/** Below this many remaining requests (per GitLab's headers), back off. */
const LowRemainingThreshold = 20

interface IHostBudget {
  tokens: number
  lastRefill: number
  /** No requests to this host before this time (epoch ms). */
  pausedUntil: number
  /** Next pause length when GitLab rate limits us again. */
  nextPauseMs: number
}

const budgets = new Map<string, IHostBudget>()
const rateLimitListeners = new Set<() => void>()

function getBudget(origin: string): IHostBudget {
  let budget = budgets.get(origin)
  if (budget === undefined) {
    budget = {
      tokens: BurstSize,
      lastRefill: Date.now(),
      pausedUntil: 0,
      nextPauseMs: MinRateLimitPauseMs,
    }
    budgets.set(origin, budget)
  }
  return budget
}

function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** Wait for a token from the host's budget. */
async function takeToken(budget: IHostBudget) {
  for (;;) {
    const now = Date.now()
    const refill = ((now - budget.lastRefill) / 60000) * RequestsPerMinute
    budget.tokens = Math.min(BurstSize, budget.tokens + refill)
    budget.lastRefill = now

    if (budget.tokens >= 1) {
      budget.tokens -= 1
      return
    }

    await delay(((1 - budget.tokens) * 60000) / RequestsPerMinute)
  }
}

function pauseHost(budget: IHostBudget, untilMs: number) {
  if (untilMs > budget.pausedUntil) {
    budget.pausedUntil = untilMs
    log.warn(
      `[GitLab] rate limited; pausing requests until ${new Date(
        untilMs
      ).toLocaleTimeString()}`
    )
    for (const fn of rateLimitListeners) {
      fn()
    }
  }
}

/**
 * Work out how long to pause from a rate-limited (or nearly exhausted)
 * response, using GitLab's `Retry-After` / `RateLimit-Reset` headers when
 * present and an increasing backoff otherwise.
 */
function getPauseUntil(response: Response, budget: IHostBudget): number {
  const now = Date.now()
  const retryAfter = parseInt(response.headers.get('Retry-After') ?? '', 10)
  if (!isNaN(retryAfter)) {
    return now + Math.max(retryAfter * 1000, MinRateLimitPauseMs)
  }

  const reset = parseInt(response.headers.get('RateLimit-Reset') ?? '', 10)
  if (!isNaN(reset) && reset * 1000 > now) {
    return Math.max(reset * 1000, now + MinRateLimitPauseMs)
  }

  const pause = budget.nextPauseMs
  budget.nextPauseMs = Math.min(pause * 2, MaxRateLimitPauseMs)
  return now + pause
}

/**
 * When requests are paused because GitLab rate limited us (epoch ms), or
 * `null` when they aren't.
 */
export function getGitLabRateLimitedUntil(): number | null {
  const now = Date.now()
  let until: number | null = null
  for (const budget of budgets.values()) {
    if (
      budget.pausedUntil > now &&
      (until === null || budget.pausedUntil > until)
    ) {
      until = budget.pausedUntil
    }
  }
  return until
}

/** Forget request budgets and pauses. For tests. */
export function resetGitLabRequestBudgets() {
  budgets.clear()
}

/** Be told when a rate-limit pause starts. */
export function onGitLabRateLimited(fn: () => void): () => void {
  rateLimitListeners.add(fn)
  return () => rateLimitListeners.delete(fn)
}

function isRetryable(status: number) {
  // 429 is deliberately not retried: we pause instead (see pauseHost).
  return status === 0 || status >= 500
}

function getRetryDelay(attempt: number) {
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
  const { body } = await gitLabRequestWithHeaders<T>(url, token, method)
  return body
}

/** Like `gitLabRequest`, but also returns the response headers (for paging). */
async function gitLabRequestWithHeaders<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' = 'GET'
): Promise<{ readonly body: T; readonly headers: Headers }> {
  const budget = getBudget(originOf(url))
  let lastError: GitLabApiError | null = null

  for (let attempt = 1; attempt <= MaxAttempts; attempt++) {
    // While paused, fail fast without touching the network.
    if (budget.pausedUntil > Date.now()) {
      throw new GitLabApiError(
        `GitLab rate limit reached; waiting until ${new Date(
          budget.pausedUntil
        ).toLocaleTimeString()}`,
        429
      )
    }

    await takeToken(budget)

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
      if (response.status === 429) {
        pauseHost(budget, getPauseUntil(response, budget))
        throw new GitLabApiError(
          `GitLab rate limit reached; waiting until ${new Date(
            budget.pausedUntil
          ).toLocaleTimeString()}`,
          429
        )
      }

      // Slow down before GitLab has to tell us to.
      const remaining = parseInt(
        response.headers.get('RateLimit-Remaining') ?? '',
        10
      )
      if (!isNaN(remaining) && remaining < LowRemainingThreshold) {
        pauseHost(budget, getPauseUntil(response, budget))
      }

      if (response.ok) {
        budget.nextPauseMs = MinRateLimitPauseMs
        // Some endpoints (e.g. play) can legitimately return an empty body.
        const text = await response.text()
        return {
          body: (text.length > 0 ? JSON.parse(text) : null) as T,
          headers: response.headers,
        }
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

    await delay(getRetryDelay(attempt))
  }

  throw lastError ?? new GitLabApiError('Unknown GitLab error', 0)
}

/* ---------------------------------------------------------------------------
 * Endpoints
 * ------------------------------------------------------------------------- */

interface IApiPipeline {
  readonly id: number
  readonly sha: string
  readonly ref: string
  readonly status: string
  readonly web_url?: string
  readonly updated_at?: string
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

/** Whether an error means "this endpoint isn't available to us" rather than a real failure. */
function isNotAvailable(e: unknown) {
  return e instanceof GitLabApiError && (e.isNotFound || e.isForbidden)
}

async function fetchJobs(
  project: IGitLabProject,
  pipelineId: number,
  token: string
): Promise<ReadonlyArray<IGitLabJobStatus>> {
  const jobs = await gitLabRequest<ReadonlyArray<IApiJob>>(
    apiUrl(
      project,
      `${projectApiPath(project)}/pipelines/${pipelineId}/jobs?per_page=100`
    ),
    token
  )

  return (
    (Array.isArray(jobs) ? jobs : [])
      .map(job => ({
        id: job.id,
        name: `${job.name}`,
        status: `${job.status ?? 'unknown'}`,
        stage: job.stage,
        webUrl: job.web_url,
      }))
      // Jobs are created in stage order, so ascending id is a reliable
      // display order.
      .sort((a, b) => a.id - b.id)
  )
}

/** How many recent pipelines one bulk request returns (GitLab's max page). */
const RecentPipelinesPageSize = 100

async function fetchRecentPipelines(
  project: IGitLabProject,
  token: string
): Promise<ReadonlyArray<IApiPipeline>> {
  const pipelines = await gitLabRequest<ReadonlyArray<IApiPipeline>>(
    apiUrl(
      project,
      `${projectApiPath(
        project
      )}/pipelines?order_by=id&sort=desc&per_page=${RecentPipelinesPageSize}`
    ),
    token
  )
  return Array.isArray(pipelines) ? pipelines : []
}

async function fetchPipelineForSha(
  project: IGitLabProject,
  sha: string,
  token: string
): Promise<IApiPipeline | null> {
  const pipelines = await gitLabRequest<ReadonlyArray<IApiPipeline>>(
    apiUrl(
      project,
      `${projectApiPath(project)}/pipelines?sha=${encodeURIComponent(
        sha
      )}&order_by=id&sort=desc&per_page=1`
    ),
    token
  )
  return Array.isArray(pipelines) && pipelines.length > 0 ? pipelines[0] : null
}

async function fetchCommitStatuses(
  project: IGitLabProject,
  sha: string,
  token: string
): Promise<IGitLabPipelineInfo | null> {
  let statuses: ReadonlyArray<IApiCommitStatus>
  try {
    statuses = await gitLabRequest<ReadonlyArray<IApiCommitStatus>>(
      apiUrl(
        project,
        `${projectApiPath(project)}/repository/commits/${encodeURIComponent(
          sha
        )}/statuses?per_page=100`
      ),
      token
    )
  } catch (e) {
    // 404 here means GitLab doesn't know the commit (e.g. it hasn't been
    // pushed), not that the project is inaccessible.
    if (isNotAvailable(e)) {
      return null
    }
    throw e
  }

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

  return { sha, status: getAggregateStatus(jobs), jobs }
}

/** Options for `GitLabPipelineResolver.resolve`. */
export interface IResolvePipelineOptions {
  /**
   * The checked-out branch. When the commit has no pipeline, the branch's
   * latest pipeline is shown instead (marked with `fallbackRef`).
   */
  readonly branch?: string | null
  /** Reuse the project's recent-pipelines list if it's younger than this. */
  readonly maxAgeMs: number
  /**
   * Allow one extra request for a commit whose pipeline is older than the
   * project's 100 most recent. Off for bulk/background lookups.
   */
  readonly allowShaLookup?: boolean
}

interface IRecentPipelines {
  readonly pipelines: ReadonlyArray<IApiPipeline>
  readonly fetchedAt: number
}

const ShaLookupTtlMs = 30 * 60 * 1000
const MaxJobCacheEntries = 500

/**
 * Resolves pipelines for commits using as few requests as possible:
 *
 * - One request lists a project's 100 most recent pipelines; every
 *   repository and history row for that project shares it.
 * - A pipeline's jobs are only fetched again when the pipeline changes
 *   (its `updated_at` or status).
 * - Older commits cost at most one extra lookup, remembered for 30 minutes.
 * - Concurrent requests for the same thing are shared.
 */
export class GitLabPipelineResolver {
  private readonly recent = new Map<string, IRecentPipelines>()
  private readonly recentPending = new Map<
    string,
    Promise<IRecentPipelines | null>
  >()
  /** Projects where the pipelines API isn't available (403/404). */
  private readonly pipelinesUnavailable = new Set<string>()
  private readonly jobs = new Map<
    number,
    { readonly key: string; readonly jobs: ReadonlyArray<IGitLabJobStatus> }
  >()
  private readonly jobsPending = new Map<
    string,
    Promise<ReadonlyArray<IGitLabJobStatus>>
  >()
  private readonly shaLookups = new Map<
    string,
    { readonly pipeline: IApiPipeline | null; readonly at: number }
  >()

  /** Forget everything (e.g. when the token or instances change). */
  public clear() {
    this.recent.clear()
    this.recentPending.clear()
    this.pipelinesUnavailable.clear()
    this.jobs.clear()
    this.jobsPending.clear()
    this.shaLookups.clear()
  }

  public async resolve(
    project: IGitLabProject,
    sha: string,
    token: string,
    options: IResolvePipelineOptions
  ): Promise<IGitLabPipelineInfo | null> {
    const key = projectKey(project)

    if (this.pipelinesUnavailable.has(key)) {
      // Some projects refuse the pipelines API but still expose commit
      // statuses (e.g. external CI).
      return fetchCommitStatuses(project, sha, token)
    }

    const recent = await this.getRecent(project, token, options.maxAgeMs)
    if (recent === null) {
      return fetchCommitStatuses(project, sha, token)
    }

    let pipeline = recent.pipelines.find(p => p.sha === sha) ?? null

    // Not among the recent pipelines. If GitLab returned a full page there
    // may be older ones, so (when allowed) ask about this commit directly.
    if (
      pipeline === null &&
      options.allowShaLookup === true &&
      recent.pipelines.length >= RecentPipelinesPageSize
    ) {
      pipeline = await this.lookupSha(project, sha, token)
    }

    let fallbackRef: string | undefined
    if (pipeline === null && options.branch) {
      pipeline = recent.pipelines.find(p => p.ref === options.branch) ?? null
      if (pipeline !== null) {
        fallbackRef = options.branch
      }
    }

    if (pipeline === null) {
      return null
    }

    return {
      sha,
      status: pipeline.status,
      webUrl: pipeline.web_url,
      jobs: await this.getJobs(project, pipeline, token),
      fallbackRef,
    }
  }

  private async getRecent(
    project: IGitLabProject,
    token: string,
    maxAgeMs: number
  ): Promise<IRecentPipelines | null> {
    const key = projectKey(project)
    const cached = this.recent.get(key)
    if (cached !== undefined && Date.now() - cached.fetchedAt <= maxAgeMs) {
      return cached
    }

    const pending = this.recentPending.get(key)
    if (pending !== undefined) {
      return pending
    }

    const request = fetchRecentPipelines(project, token)
      .then(pipelines => {
        const entry = { pipelines, fetchedAt: Date.now() }
        this.recent.set(key, entry)
        return entry
      })
      .catch(e => {
        if (isNotAvailable(e)) {
          this.pipelinesUnavailable.add(key)
          return null
        }
        // Serve stale data rather than nothing when GitLab is unhappy.
        if (cached !== undefined) {
          return cached
        }
        throw e
      })
      .finally(() => this.recentPending.delete(key))

    this.recentPending.set(key, request)
    return request
  }

  private async lookupSha(
    project: IGitLabProject,
    sha: string,
    token: string
  ): Promise<IApiPipeline | null> {
    const key = `${projectKey(project)}@${sha}`
    const cached = this.shaLookups.get(key)
    if (cached !== undefined && Date.now() - cached.at < ShaLookupTtlMs) {
      return cached.pipeline
    }

    const pipeline = await fetchPipelineForSha(project, sha, token)
    this.shaLookups.set(key, { pipeline, at: Date.now() })
    if (this.shaLookups.size > 2000) {
      this.shaLookups.clear()
    }
    return pipeline
  }

  private async getJobs(
    project: IGitLabProject,
    pipeline: IApiPipeline,
    token: string
  ): Promise<ReadonlyArray<IGitLabJobStatus>> {
    const version = `${pipeline.status}@${pipeline.updated_at ?? ''}`
    const cached = this.jobs.get(pipeline.id)
    if (cached !== undefined && cached.key === version) {
      return cached.jobs
    }

    const pendingKey = `${pipeline.id}:${version}`
    const pending = this.jobsPending.get(pendingKey)
    if (pending !== undefined) {
      return pending
    }

    const request = fetchJobs(project, pipeline.id, token)
      .then(jobs => {
        this.jobs.delete(pipeline.id)
        this.jobs.set(pipeline.id, { key: version, jobs })
        while (this.jobs.size > MaxJobCacheEntries) {
          const oldest = this.jobs.keys().next().value
          if (oldest === undefined) {
            break
          }
          this.jobs.delete(oldest)
        }
        return jobs
      })
      .catch(e => {
        // Fall back to the last known jobs if we have them.
        if (cached !== undefined) {
          return cached.jobs
        }
        throw e
      })
      .finally(() => this.jobsPending.delete(pendingKey))

    this.jobsPending.set(pendingKey, request)
    return request
  }
}

function projectKey(project: IGitLabProject) {
  return `${project.webBaseUrl}/${project.projectPath}`
}

/**
 * Fetch the pipeline for a single commit. Convenience wrapper around a
 * throwaway `GitLabPipelineResolver`; prefer a shared resolver.
 */
export async function fetchPipelineForCommit(
  project: IGitLabProject,
  sha: string,
  token: string,
  branch: string | null = null
): Promise<IGitLabPipelineInfo | null> {
  return new GitLabPipelineResolver().resolve(project, sha, token, {
    branch,
    maxAgeMs: 0,
    allowShaLookup: true,
  })
}

/**
 * Check that a project exists and the token can see it.
 *
 * Throws a `GitLabApiError` (404/403 when it isn't accessible).
 */
export async function verifyGitLabProject(
  project: IGitLabProject,
  token: string
): Promise<void> {
  await gitLabRequest(apiUrl(project, projectApiPath(project)), token)
}

/** Hosts that are definitely not GitLab, so never worth probing. */
const KnownNonGitLabHosts = [
  'github.com',
  'bitbucket.org',
  'dev.azure.com',
  'ssh.dev.azure.com',
  'visualstudio.com',
  'codeberg.org',
  'sourceforge.net',
  'gitee.com',
]

/**
 * Detect whether an arbitrary host runs GitLab, WITHOUT sending the token
 * (the host might not be GitLab at all). GitLab answers an anonymous
 * `GET /api/v4/version` with a JSON 401 (or 200 on public instances);
 * other servers answer with HTML or a 404.
 */
export async function probeGitLabHost(webBaseUrl: string): Promise<boolean> {
  const host = (() => {
    try {
      return new URL(webBaseUrl).hostname.toLowerCase()
    } catch {
      return ''
    }
  })()

  if (
    host.length === 0 ||
    KnownNonGitLabHosts.some(h => host === h || host.endsWith(`.${h}`))
  ) {
    return false
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${webBaseUrl}/api/v4/version`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      return false
    }
    const body = await response.json()
    return (
      (response.status === 401 && /unauthorized/i.test(`${body?.message}`)) ||
      (response.ok && typeof body?.version === 'string')
    )
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
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
 * Projects (for cloning)
 * ------------------------------------------------------------------------- */

/** A project the user can clone, as listed by `GET /projects`. */
export interface IGitLabCloneableProject {
  readonly id: number
  readonly name: string
  /** e.g. `acme/backend/api` */
  readonly pathWithNamespace: string
  /**
   * The full path of the group (or user namespace) the project lives in,
   * e.g. `acme/backend`.
   */
  readonly namespaceFullPath: string
  /** Human readable namespace name, e.g. `Acme / Backend`. */
  readonly namespaceName: string
  /** `group` or `user`. */
  readonly namespaceKind: string
  readonly httpUrl: string
  readonly sshUrl: string
  readonly webUrl: string
  readonly defaultBranch: string | null
  readonly visibility: string | null
  readonly archived: boolean
  readonly isFork: boolean
  readonly lastActivityAt: string | null
}

/** The projects visible to a token on one instance. */
export interface IGitLabProjectList {
  /** The username the token belongs to. */
  readonly username: string
  readonly projects: ReadonlyArray<IGitLabCloneableProject>
  /** True when the list was cut off at `MaxProjectPages` pages. */
  readonly truncated: boolean
}

interface IApiProject {
  readonly id: number
  readonly name: string
  readonly path_with_namespace: string
  readonly http_url_to_repo?: string
  readonly ssh_url_to_repo?: string
  readonly web_url?: string
  readonly default_branch?: string | null
  readonly visibility?: string
  readonly archived?: boolean
  readonly forked_from_project?: unknown
  readonly last_activity_at?: string
  readonly namespace?: {
    readonly name?: string
    readonly full_path?: string
    readonly kind?: string
  }
}

/** At 100 projects per page this lists up to 2000 projects. */
const MaxProjectPages = 20

/** Parse an API project, or return null for a malformed entry. */
export function toCloneableProject(
  p: IApiProject
): IGitLabCloneableProject | null {
  if (
    p === null ||
    typeof p !== 'object' ||
    typeof p.id !== 'number' ||
    typeof p.path_with_namespace !== 'string' ||
    typeof p.http_url_to_repo !== 'string'
  ) {
    return null
  }

  const slash = p.path_with_namespace.lastIndexOf('/')
  const namespaceFullPath =
    p.namespace?.full_path ??
    (slash > 0 ? p.path_with_namespace.slice(0, slash) : '')

  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : p.path_with_namespace,
    pathWithNamespace: p.path_with_namespace,
    namespaceFullPath,
    namespaceName: p.namespace?.name ?? namespaceFullPath,
    namespaceKind: p.namespace?.kind ?? 'group',
    httpUrl: p.http_url_to_repo,
    sshUrl: p.ssh_url_to_repo ?? '',
    webUrl: p.web_url ?? '',
    defaultBranch: p.default_branch ?? null,
    visibility: p.visibility ?? null,
    archived: p.archived === true,
    isFork:
      p.forked_from_project !== undefined && p.forked_from_project !== null,
    lastActivityAt: p.last_activity_at ?? null,
  }
}

interface ICachedProjectList {
  readonly token: string
  readonly fetchedAt: number
  readonly result: Promise<IGitLabProjectList>
}

/** Listing is cached per instance for this long, unless refreshed. */
const ProjectListCacheMs = 10 * 60 * 1000
const projectListCache = new Map<string, ICachedProjectList>()

/**
 * List every project the token is a member of (directly or through a
 * group) on an instance, most recently active first.
 *
 * Results are cached per instance for ten minutes, and concurrent callers
 * share one request; pass `refresh` to bypass the cache. Pages go through the
 * same rate budget as pipeline polling.
 */
export function fetchGitLabProjects(
  webBaseUrl: string,
  token: string,
  refresh = false
): Promise<IGitLabProjectList> {
  const cached = projectListCache.get(webBaseUrl)
  if (
    !refresh &&
    cached !== undefined &&
    cached.token === token &&
    Date.now() - cached.fetchedAt < ProjectListCacheMs
  ) {
    return cached.result
  }

  const result = loadGitLabProjects(webBaseUrl, token)
  projectListCache.set(webBaseUrl, { token, fetchedAt: Date.now(), result })
  // Don't keep a failure around; the next call should try again.
  result.catch(() => {
    if (projectListCache.get(webBaseUrl)?.result === result) {
      projectListCache.delete(webBaseUrl)
    }
  })
  return result
}

/** Forget cached project lists (e.g. after the token changes). */
export function clearGitLabProjectCache() {
  projectListCache.clear()
}

async function loadGitLabProjects(
  webBaseUrl: string,
  token: string
): Promise<IGitLabProjectList> {
  const user = await gitLabRequest<{ username: string }>(
    apiUrl({ webBaseUrl }, '/user'),
    token
  )

  const projects = new Map<number, IGitLabCloneableProject>()
  let page: string | null = '1'
  let pages = 0

  while (page !== null && pages < MaxProjectPages) {
    const query: URLSearchParams = new URLSearchParams({
      membership: 'true',
      per_page: '100',
      order_by: 'last_activity_at',
      sort: 'desc',
      statistics: 'false',
      page,
    })
    const response: { body: unknown; headers: Headers } =
      await gitLabRequestWithHeaders<unknown>(
        apiUrl({ webBaseUrl }, `/projects?${query}`),
        token
      )
    pages++
    const { body, headers } = response

    if (!Array.isArray(body)) {
      break
    }

    for (const raw of body) {
      const project = toCloneableProject(raw)
      if (project !== null) {
        projects.set(project.id, project)
      }
    }

    const next: string = headers.get('x-next-page')?.trim() ?? ''
    page = /^\d+$/.test(next) && body.length > 0 ? next : null
  }

  return {
    username: user?.username ?? '',
    projects: [...projects.values()],
    truncated: page !== null,
  }
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
