import { TypedBaseStore } from './base-store'
import { Repository } from '../../models/repository'
import { getRemotes } from '../git/remote'
import { git } from '../git/core'
import { getGitLabToken } from '../gitlab/gitlab-token'
import {
  IGitLabJobStatus,
  IGitLabProject,
  fetchLatestCommitStatuses,
  isLikelyGitLabHost,
  parseGitLabProject,
  playGitLabJob,
} from '../gitlab/gitlab-api'

/** Latest known GitLab pipeline job statuses, keyed by repository id. */
export type IGitLabPipelineStatusMap = ReadonlyMap<
  number,
  ReadonlyArray<IGitLabJobStatus>
>

/**
 * A singleton store that owns fetching GitLab pipeline statuses for the
 * user's repositories, so that multiple UI surfaces (the repositories
 * sidebar, the GitLab preferences tab) can trigger and/or observe the same
 * fetch logic without needing a direct reference to one another.
 */
class GitLabPipelineStatusStore extends TypedBaseStore<IGitLabPipelineStatusMap> {
  private statuses: IGitLabPipelineStatusMap = new Map()

  /**
   * The resolved GitLab project (hostname/projectPath) for each repository,
   * keyed by repository id. Populated as a side effect of `refresh()`
   * resolving a repository's `origin` remote, so that follow-up actions
   * (like playing a manual job) don't need to re-resolve remotes.
   */
  private projectsByRepositoryId = new Map<number, IGitLabProject>()

  /**
   * Latest known GitLab CI/CD job statuses for individual commits, keyed by
   * `` `${repositoryId}:${sha}` ``. Populated on demand via
   * `getOrFetchCommitStatuses`, independently of the per-repository HEAD
   * statuses in `statuses`.
   */
  private commitStatuses = new Map<string, ReadonlyArray<IGitLabJobStatus>>()

  /**
   * Repository ids for which a GitLab pipeline-status fetch is currently
   * in flight. Only ever populated for repositories that have already
   * resolved to a GitLab project (see `resolveProject`) — a repository
   * that isn't hosted on GitLab never shows up here.
   */
  private fetchingRepositoryIds = new Set<number>()

  /** Read the current cached statuses without triggering a fetch. */
  public getStatuses(): IGitLabPipelineStatusMap {
    return this.statuses
  }

  /**
   * Whether a GitLab pipeline-status fetch is currently in flight for the
   * given repository. Always `false` for repositories that haven't been
   * resolved to a GitLab project.
   */
  public isFetching(repositoryId: number): boolean {
    return this.fetchingRepositoryIds.has(repositoryId)
  }

  /** Read the current cached statuses for a single repository. */
  public getStatusesForRepository(
    id: number
  ): ReadonlyArray<IGitLabJobStatus> | undefined {
    return this.statuses.get(id)
  }

  /**
   * Refresh the cached pipeline statuses for the given repositories.
   *
   * If no GitLab token is configured, this is a no-op: no network requests,
   * no git commands, and any previously cached statuses are left untouched.
   */
  public async refresh(
    repositories: ReadonlyArray<Repository>
  ): Promise<void> {
    const gitlabToken = await getGitLabToken()
    if (gitlabToken === null) {
      return
    }

    // Each repository is refreshed (and merged into `this.statuses`)
    // independently, rather than collecting every result and replacing
    // the whole map at once. That matters because `refresh` is sometimes
    // called with just a single repository (e.g. right after a branch
    // switch) — replacing the whole map with only that one repository's
    // result would wipe out the cached statuses for every other
    // repository in the sidebar.
    await Promise.all(
      repositories.map(repository =>
        this.refreshRepository(repository, gitlabToken)
      )
    )
  }

  private async refreshRepository(
    repository: Repository,
    gitlabToken: string
  ): Promise<void> {
    const result = await this.getPipelineStatusForRepository(
      repository,
      gitlabToken
    )
    if (result === null) {
      return
    }

    const statuses = new Map(this.statuses)
    statuses.set(result.repositoryId, result.statuses)
    this.statuses = statuses
    this.emitUpdate(this.statuses)
  }

  /**
   * Resolve a repository's `origin` remote to a GitLab project, if
   * possible. Callers that succeed should cache the result against the
   * repository's id (see `projectsByRepositoryId`) so that later actions
   * scoped to a single job (e.g. `playJob`) don't need to re-resolve
   * remotes.
   */
  private async resolveProject(
    repository: Repository
  ): Promise<IGitLabProject | null> {
    const remotes = await getRemotes(repository)
    const origin = remotes.find(r => r.name === 'origin')
    if (origin === undefined) {
      return null
    }

    const project = parseGitLabProject(origin.url)
    if (project === null || !isLikelyGitLabHost(project.hostname)) {
      return null
    }

    return project
  }

  private async getPipelineStatusForRepository(
    repository: Repository,
    gitlabToken: string
  ): Promise<{
    repositoryId: number
    statuses: ReadonlyArray<IGitLabJobStatus>
  } | null> {
    let markedFetching = false

    try {
      const project = await this.resolveProject(repository)
      if (project === null) {
        return null
      }

      this.projectsByRepositoryId.set(repository.id, project)

      // Only once we know this repository actually resolves to a GitLab
      // project do we surface a "fetching" state — a non-GitLab
      // repository should never flash a loading spinner.
      markedFetching = true
      this.fetchingRepositoryIds.add(repository.id)
      this.emitUpdate(this.statuses)

      const result = await git(
        ['rev-parse', 'HEAD'],
        repository.path,
        'gitlabPipelineHeadSha'
      )
      const sha = result.stdout.trim()
      if (sha.length === 0) {
        return null
      }

      const statuses = await fetchLatestCommitStatuses(
        project.hostname,
        project.projectPath,
        sha,
        gitlabToken
      )

      if (statuses === null) {
        return null
      }

      // GitLab's API doesn't guarantee the returned statuses are in
      // pipeline/stage order, so sort by job id (jobs are created in
      // stage order, so ascending id is a reliable proxy for the order
      // they should be displayed in) before handing them back.
      const sortedStatuses = [...statuses].sort((a, b) => a.id - b.id)

      return { repositoryId: repository.id, statuses: sortedStatuses }
    } catch (e) {
      // Any failure for a single repository (missing on disk, detached
      // HEAD weirdness, network issues, etc.) should never crash the
      // fetch or prevent other repositories from being refreshed.
      log.error(
        `Failed to refresh GitLab pipeline status for '${repository.name}'`,
        e
      )
      return null
    } finally {
      if (markedFetching) {
        this.fetchingRepositoryIds.delete(repository.id)
        this.emitUpdate(this.statuses)
      }
    }
  }

  /**
   * Trigger a manual GitLab CI/CD job, then re-refresh the repository's
   * pipeline statuses so the UI picks up the job's new state (typically
   * moving from `manual` to `pending`/`running`).
   *
   * Requires `refresh()` to have already resolved this repository to a
   * GitLab project (i.e. the repository's dot/statuses must have appeared
   * at least once) — if it hasn't, this is a no-op.
   */
  public async playJob(repository: Repository, jobId: number): Promise<void> {
    const gitlabToken = await getGitLabToken()
    if (gitlabToken === null) {
      return
    }

    const project = this.projectsByRepositoryId.get(repository.id)
    if (project === undefined) {
      return
    }

    try {
      await playGitLabJob(
        project.hostname,
        project.projectPath,
        jobId,
        gitlabToken
      )
    } finally {
      await this.refresh([repository])
    }
  }

  /**
   * Read the cached GitLab CI/CD job statuses for a single commit, if any
   * are cached. If none are cached yet, kicks off a background fetch (fire
   * and forget from the caller's perspective) that will populate the cache
   * and emit an update once it resolves.
   */
  public getOrFetchCommitStatuses(
    repository: Repository,
    sha: string
  ): ReadonlyArray<IGitLabJobStatus> | undefined {
    const key = `${repository.id}:${sha}`
    const cached = this.commitStatuses.get(key)
    if (cached !== undefined) {
      return cached
    }

    this.fetchCommitStatuses(repository, sha, key)
    return undefined
  }

  private async fetchCommitStatuses(
    repository: Repository,
    sha: string,
    key: string
  ): Promise<void> {
    try {
      const gitlabToken = await getGitLabToken()
      if (gitlabToken === null) {
        return
      }

      let project = this.projectsByRepositoryId.get(repository.id)
      if (project === undefined) {
        const resolved = await this.resolveProject(repository)
        if (resolved === null) {
          return
        }

        project = resolved
        this.projectsByRepositoryId.set(repository.id, project)
      }

      const statuses = await fetchLatestCommitStatuses(
        project.hostname,
        project.projectPath,
        sha,
        gitlabToken
      )

      if (statuses === null) {
        return
      }

      this.commitStatuses.set(key, statuses)

      // There's no dedicated emitter for per-commit statuses (see
      // `IGitLabPipelineStatusMap`'s single payload type), so this reuses
      // the existing `onDidUpdate` event purely as a generic "something
      // changed, re-check the cache" signal. This is cheap and infrequent
      // enough that it's not worth adding a second emitter for.
      this.emitUpdate(this.statuses)
    } catch (e) {
      log.error(
        `Failed to fetch GitLab commit statuses for '${repository.name}' at ${sha}`,
        e
      )
    }
  }
}

export const gitLabPipelineStatusStore = new GitLabPipelineStatusStore()
