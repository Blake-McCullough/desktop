import { Emitter, Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { getRemotes } from '../git/remote'
import { git } from '../git/core'
import {
  getGitLabInstanceUrls,
  getGitLabToken,
  onGitLabSettingsChanged,
} from '../gitlab/gitlab-token'
import {
  GitLabApiError,
  IGitLabPipelineInfo,
  IGitLabProject,
  fetchPipelineForCommit,
  isActiveStatus,
  parseGitLabProject,
  playGitLabJob,
  probeGitLabHost,
  resolveGitLabInstance,
  verifyGitLabProject,
} from '../gitlab/gitlab-api'

/** How many repositories to refresh concurrently. */
const RefreshConcurrency = 4

/** Poll interval when nothing is running. */
const IdlePollIntervalMs = 3 * 60 * 1000

/** Poll interval while at least one pipeline is running or pending. */
const ActivePollIntervalMs = 30 * 1000

/** How long to remember which GitLab project (if any) a repository maps to. */
const ProjectCacheTtlMs = 10 * 60 * 1000

/** How long to back off from a project GitLab says doesn't exist (404/403). */
const NotFoundBackoffMs = 30 * 60 * 1000

/**
 * A finished pipeline for an unchanged HEAD won't change, so there's no need
 * to ask GitLab about it on every poll. Re-check occasionally anyway in case
 * a job was retried.
 */
const FinishedPipelineTtlMs = 10 * 60 * 1000

/** Max number of per-commit results kept in memory. */
const MaxCommitCacheEntries = 300

/** Per-commit cache lifetimes. */
const CommitActiveTtlMs = 30 * 1000
const CommitFinishedTtlMs = 60 * 60 * 1000
const CommitNoPipelineTtlMs = 5 * 60 * 1000

/** Pipeline state for one repository's current HEAD. */
export interface IRepositoryPipelineState {
  /** The latest pipeline for HEAD, or `null` if HEAD has none. */
  readonly pipeline: IGitLabPipelineInfo | null
  /** Whether a refresh is in flight. */
  readonly isFetching: boolean
  /** The last error, if the most recent refresh failed. */
  readonly error: string | null
  /** When the pipeline was last successfully fetched. */
  readonly fetchedAt: number
}

/** Latest known pipeline states, keyed by repository id. */
export type IGitLabPipelineStatusMap = ReadonlyMap<
  number,
  IRepositoryPipelineState
>

interface IProjectCacheEntry {
  readonly project: IGitLabProject | null
  readonly expiresAt: number
  /** Whether we've confirmed the token can see this project. */
  readonly verified: boolean
}

/** How long to remember whether an unrecognized host runs GitLab. */
const HostProbeTtlMs = 60 * 60 * 1000

interface ICommitCacheEntry {
  readonly pipeline: IGitLabPipelineInfo | null
  readonly fetchedAt: number
}

/** Run `fn` over `items`, never more than `concurrency` at a time. */
async function mapWithConcurrency<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
}

function describeError(e: unknown): string {
  if (e instanceof GitLabApiError) {
    if (e.isUnauthorized) {
      return 'GitLab rejected the token (401). Check it in Preferences → GitLab.'
    }
    if (e.isForbidden) {
      return "The GitLab token doesn't have access to this project."
    }
    return e.message
  }
  return e instanceof Error ? e.message : `${e}`
}

/**
 * A singleton store that owns fetching GitLab pipeline statuses, both for
 * each repository's HEAD (shown in the repositories sidebar) and for
 * individual commits (shown in the history list).
 *
 * The store owns its own polling loop so it can be smart about it: it pauses
 * while the window is hidden, speeds up while something is running, skips
 * network requests for finished pipelines whose HEAD hasn't moved, and
 * stops entirely when the token is rejected until the settings change.
 */
class GitLabPipelineStatusStore {
  private readonly emitter = new Emitter()
  private statuses: Map<number, IRepositoryPipelineState> = new Map()

  private readonly projects = new Map<number, IProjectCacheEntry>()
  private readonly hostProbes = new Map<
    string,
    { readonly result: Promise<boolean>; readonly expiresAt: number }
  >()
  private readonly inFlightRepositoryIds = new Set<number>()

  private readonly commitCache = new Map<string, ICommitCacheEntry>()
  private readonly pendingCommitKeys = new Set<string>()
  private readonly commitListeners = new Map<string, Set<() => void>>()

  /** Set when GitLab rejects the token; cleared when settings change. */
  private authError: string | null = null

  private getRepositories: (() => ReadonlyArray<Repository>) | null = null
  private pollTimer: number | null = null
  private lastPollAt = 0
  private emitScheduled = false
  private readonly disposables: Array<Disposable> = []

  public constructor() {
    this.disposables.push(
      onGitLabSettingsChanged(() => {
        this.authError = null
        this.projects.clear()
        this.hostProbes.clear()
        this.commitCache.clear()
        this.statuses = new Map()
        this.scheduleEmit()
        this.pollNow()
      })
    )

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
      window.addEventListener('online', this.onOnline)
    }
  }

  /* ----------------------------- subscriptions ---------------------------- */

  /** Subscribe to changes to per-repository statuses. */
  public onDidUpdate(fn: (statuses: IGitLabPipelineStatusMap) => void) {
    return this.emitter.on('did-update', fn)
  }

  /** Subscribe to changes to a single commit's pipeline. */
  public onDidUpdateCommit(
    repository: Repository,
    sha: string,
    fn: () => void
  ): Disposable {
    const key = this.commitKey(repository, sha)
    let set = this.commitListeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.commitListeners.set(key, set)
    }
    set.add(fn)

    return new Disposable(() => {
      const listeners = this.commitListeners.get(key)
      if (listeners !== undefined) {
        listeners.delete(fn)
        if (listeners.size === 0) {
          this.commitListeners.delete(key)
        }
      }
    })
  }

  /**
   * Coalesce bursts of updates (e.g. a dozen repositories finishing in the
   * same tick) into a single render.
   */
  private scheduleEmit() {
    if (this.emitScheduled) {
      return
    }
    this.emitScheduled = true
    setTimeout(() => {
      this.emitScheduled = false
      this.emitter.emit('did-update', this.statuses)
    }, 50)
  }

  /* -------------------------------- reading ------------------------------- */

  /** Read the current cached statuses without triggering a fetch. */
  public getStatuses(): IGitLabPipelineStatusMap {
    return this.statuses
  }

  /** The current authentication problem, if GitLab rejected the token. */
  public getAuthError(): string | null {
    return this.authError
  }

  /* -------------------------------- polling ------------------------------- */

  /**
   * Start polling the given repositories' HEAD pipelines. Safe to call more
   * than once — later calls just replace the repository source.
   */
  public startPolling(getRepositories: () => ReadonlyArray<Repository>) {
    this.getRepositories = getRepositories
    if (this.pollTimer === null) {
      this.pollNow()
    }
  }

  public stopPolling() {
    this.getRepositories = null
    this.clearPollTimer()
  }

  private clearPollTimer() {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private pollNow = () => {
    this.clearPollTimer()
    this.poll().finally(() => this.scheduleNextPoll())
  }

  private scheduleNextPoll() {
    this.clearPollTimer()
    if (this.getRepositories === null) {
      return
    }

    // A chain of timeouts rather than setInterval: when the machine wakes
    // from sleep, Chromium would otherwise fire every missed interval at
    // once.
    this.pollTimer = window.setTimeout(this.pollNow, this.getPollInterval())
  }

  private getPollInterval() {
    for (const state of this.statuses.values()) {
      if (state.pipeline !== null && isActiveStatus(state.pipeline.status)) {
        return ActivePollIntervalMs
      }
    }
    return IdlePollIntervalMs
  }

  private onVisibilityChange = () => {
    if (
      document.visibilityState === 'visible' &&
      Date.now() - this.lastPollAt > this.getPollInterval()
    ) {
      this.pollNow()
    }
  }

  private onOnline = () => {
    if (Date.now() - this.lastPollAt > ActivePollIntervalMs) {
      this.pollNow()
    }
  }

  private async poll() {
    if (this.getRepositories === null) {
      return
    }

    // Don't do background work nobody can see. We'll catch up as soon as
    // the window becomes visible again.
    if (typeof document !== 'undefined' && document.hidden) {
      return
    }

    this.lastPollAt = Date.now()
    await this.refresh(this.getRepositories())
  }

  /* ------------------------------- refreshing ----------------------------- */

  /**
   * Refresh the pipeline statuses for the given repositories.
   *
   * No-op when no token is configured or the token was rejected.
   */
  public async refresh(
    repositories: ReadonlyArray<Repository>,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const token = await getGitLabToken()
    if (token === null || this.authError !== null) {
      return
    }

    await mapWithConcurrency(repositories, RefreshConcurrency, repository =>
      this.refreshRepository(repository, token, options.force === true)
    )
  }

  private setRepositoryState(
    repositoryId: number,
    update: Partial<IRepositoryPipelineState>
  ) {
    const previous = this.statuses.get(repositoryId) ?? {
      pipeline: null,
      isFetching: false,
      error: null,
      fetchedAt: 0,
    }
    const statuses = new Map(this.statuses)
    statuses.set(repositoryId, { ...previous, ...update })
    this.statuses = statuses
    this.scheduleEmit()
  }

  private async refreshRepository(
    repository: Repository,
    token: string,
    force: boolean
  ): Promise<void> {
    if (repository.missing || this.inFlightRepositoryIds.has(repository.id)) {
      return
    }

    this.inFlightRepositoryIds.add(repository.id)
    let markedFetching = false

    try {
      const project = await this.resolveProject(repository)
      if (project === null) {
        if (this.statuses.has(repository.id)) {
          const statuses = new Map(this.statuses)
          statuses.delete(repository.id)
          this.statuses = statuses
          this.scheduleEmit()
        }
        return
      }

      if (!(await this.ensureProjectAccessible(repository, project, token))) {
        return
      }

      const sha = await this.getHeadSha(repository)
      if (sha === null) {
        return
      }

      const previous = this.statuses.get(repository.id)
      if (
        !force &&
        previous !== undefined &&
        previous.error === null &&
        previous.pipeline !== null &&
        previous.pipeline.sha === sha &&
        !isActiveStatus(previous.pipeline.status) &&
        Date.now() - previous.fetchedAt < FinishedPipelineTtlMs
      ) {
        return
      }

      markedFetching = true
      this.setRepositoryState(repository.id, { isFetching: true })

      const branch = await this.getHeadBranch(repository)
      const pipeline = await fetchPipelineForCommit(project, sha, token, branch)
      this.setRepositoryState(repository.id, {
        pipeline,
        isFetching: false,
        error: null,
        fetchedAt: Date.now(),
      })

      // Keep the per-commit cache in sync so the history list doesn't need
      // to ask again for HEAD (unless it's the branch's pipeline rather
      // than this commit's).
      if (pipeline === null || pipeline.fallbackRef === undefined) {
        this.storeCommitResult(this.commitKey(repository, sha), pipeline)
      }
    } catch (e) {
      this.handleError(repository, e)
      if (markedFetching) {
        this.setRepositoryState(repository.id, {
          isFetching: false,
          error: describeError(e),
        })
      }
    } finally {
      this.inFlightRepositoryIds.delete(repository.id)
    }
  }

  private handleError(repository: Repository, e: unknown) {
    if (e instanceof GitLabApiError) {
      if (e.isUnauthorized) {
        // Every other request will fail the same way. Stop until the user
        // fixes the token instead of hammering the server.
        this.authError = describeError(e)
        log.warn(`[GitLab] token rejected; pausing pipeline status updates`)
        this.scheduleEmit()
        return
      }
    }

    log.warn(
      `[GitLab] failed to refresh pipeline status for '${
        repository.name
      }': ${describeError(e)}`
    )
  }

  /**
   * Confirm (once per cache period) that the token can see the project. A
   * 404/403 here — and only here — means the repository is backed off, so
   * a missing commit or a restricted endpoint can't hide a whole project.
   */
  private async ensureProjectAccessible(
    repository: Repository,
    project: IGitLabProject,
    token: string
  ): Promise<boolean> {
    const cached = this.projects.get(repository.id)
    if (cached?.verified === true) {
      return true
    }

    try {
      await verifyGitLabProject(project, token)
    } catch (e) {
      if (e instanceof GitLabApiError && (e.isNotFound || e.isForbidden)) {
        log.info(
          `[GitLab] '${repository.name}' (${project.projectPath} on ${project.webBaseUrl}) isn't accessible with this token (${e.status}); backing off`
        )
        this.projects.set(repository.id, {
          project: null,
          expiresAt: Date.now() + NotFoundBackoffMs,
          verified: false,
        })
        return false
      }
      throw e
    }

    this.projects.set(repository.id, {
      project,
      expiresAt: cached?.expiresAt ?? Date.now() + ProjectCacheTtlMs,
      verified: true,
    })
    return true
  }

  /** Whether an unrecognized host runs GitLab (cached, probed without the token). */
  private isGitLabHost(project: IGitLabProject): Promise<boolean> {
    const key = project.webBaseUrl
    const cached = this.hostProbes.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.result
    }

    const result = probeGitLabHost(project.webBaseUrl).then(isGitLab => {
      if (isGitLab) {
        log.info(`[GitLab] detected a GitLab instance at ${key}`)
      }
      return isGitLab
    })
    this.hostProbes.set(key, {
      result,
      expiresAt: Date.now() + HostProbeTtlMs,
    })
    return result
  }

  /**
   * Resolve a repository to a GitLab project, caching the answer (including
   * "not GitLab") so we don't spawn git for every repository on every poll.
   */
  private async resolveProject(
    repository: Repository
  ): Promise<IGitLabProject | null> {
    const cached = this.projects.get(repository.id)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.project
    }

    let project: IGitLabProject | null = null
    try {
      const remotes = await getRemotes(repository)
      const instances = getGitLabInstanceUrls()
      // Prefer origin, then upstream, then anything else that's GitLab.
      const ordered = [...remotes].sort((a, b) => {
        const rank = (name: string) =>
          name === 'origin' ? 0 : name === 'upstream' ? 1 : 2
        return rank(a.name) - rank(b.name)
      })

      for (const remote of ordered) {
        const parsed = parseGitLabProject(remote.url)
        if (parsed === null) {
          continue
        }

        const resolved = resolveGitLabInstance(parsed, instances)
        if (resolved !== null) {
          project = resolved
          break
        }

        // Not configured and not obviously GitLab by name: ask the server.
        if (await this.isGitLabHost(parsed)) {
          project = parsed
          break
        }
      }
    } catch (e) {
      log.warn(`[GitLab] couldn't read remotes for '${repository.name}'`, e)
    }

    this.projects.set(repository.id, {
      project,
      expiresAt: Date.now() + ProjectCacheTtlMs,
      verified: false,
    })
    return project
  }

  /** The checked-out branch name, or `null` when HEAD is detached. */
  private async getHeadBranch(repository: Repository): Promise<string | null> {
    try {
      const result = await git(
        ['symbolic-ref', '--short', '-q', 'HEAD'],
        repository.path,
        'gitlabPipelineHeadBranch',
        { successExitCodes: new Set([0, 1]) }
      )
      const branch = result.stdout.trim()
      return branch.length > 0 ? branch : null
    } catch {
      return null
    }
  }

  private async getHeadSha(repository: Repository): Promise<string | null> {
    try {
      const result = await git(
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        repository.path,
        'gitlabPipelineHeadSha',
        { successExitCodes: new Set([0, 1]) }
      )
      const sha = result.stdout.trim()
      return sha.length > 0 ? sha : null
    } catch {
      return null
    }
  }

  /* ------------------------------- actions -------------------------------- */

  /**
   * Trigger a manual job, then refresh the repository so the UI picks up its
   * new state. Throws with a user-presentable message on failure.
   */
  public async playJob(repository: Repository, jobId: number): Promise<void> {
    const token = await getGitLabToken()
    if (token === null) {
      throw new Error('No GitLab token is configured.')
    }

    const project = await this.resolveProject(repository)
    if (project === null) {
      throw new Error(`'${repository.name}' isn't a GitLab project.`)
    }

    try {
      await playGitLabJob(project, jobId, token)
    } catch (e) {
      if (e instanceof GitLabApiError && e.isForbidden) {
        throw new Error(
          'GitLab refused to run the job. Running manual jobs needs a token with the "api" scope and Developer access to the project.'
        )
      }
      throw new Error(describeError(e))
    }

    await this.refresh([repository], { force: true })
    // The poll interval will now be the fast one since a job is active.
    this.scheduleNextPoll()
  }

  /* --------------------------- per-commit status -------------------------- */

  private commitKey(repository: Repository, sha: string) {
    return `${repository.id}:${sha}`
  }

  private storeCommitResult(key: string, pipeline: IGitLabPipelineInfo | null) {
    // Map iteration order is insertion order, so deleting and re-inserting
    // makes this a simple LRU.
    this.commitCache.delete(key)
    this.commitCache.set(key, { pipeline, fetchedAt: Date.now() })

    while (this.commitCache.size > MaxCommitCacheEntries) {
      const oldest = this.commitCache.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.commitCache.delete(oldest)
    }

    const listeners = this.commitListeners.get(key)
    if (listeners !== undefined) {
      for (const fn of [...listeners]) {
        fn()
      }
    }
  }

  private isCommitEntryStale(entry: ICommitCacheEntry) {
    const age = Date.now() - entry.fetchedAt
    if (entry.pipeline === null) {
      return age > CommitNoPipelineTtlMs
    }
    return isActiveStatus(entry.pipeline.status)
      ? age > CommitActiveTtlMs
      : age > CommitFinishedTtlMs
  }

  /**
   * Read the cached pipeline for a single commit. Returns `undefined` when
   * nothing is cached yet; in that case (or when the cached value is stale)
   * a background fetch is started, and listeners registered with
   * `onDidUpdateCommit` are called when it completes.
   */
  public getOrFetchCommitPipeline(
    repository: Repository,
    sha: string
  ): IGitLabPipelineInfo | null | undefined {
    const key = this.commitKey(repository, sha)
    const cached = this.commitCache.get(key)

    if (
      (cached === undefined || this.isCommitEntryStale(cached)) &&
      !this.pendingCommitKeys.has(key) &&
      this.authError === null
    ) {
      this.pendingCommitKeys.add(key)
      this.fetchCommitPipeline(repository, sha, key).finally(() =>
        this.pendingCommitKeys.delete(key)
      )
    }

    return cached?.pipeline
  }

  private async fetchCommitPipeline(
    repository: Repository,
    sha: string,
    key: string
  ): Promise<void> {
    try {
      const token = await getGitLabToken()
      if (token === null) {
        return
      }

      const project = await this.resolveProject(repository)
      if (
        project === null ||
        !(await this.ensureProjectAccessible(repository, project, token))
      ) {
        return
      }

      const pipeline = await fetchPipelineForCommit(project, sha, token)
      this.storeCommitResult(key, pipeline)
    } catch (e) {
      this.handleError(repository, e)
    }
  }
}

export const gitLabPipelineStatusStore = new GitLabPipelineStatusStore()
