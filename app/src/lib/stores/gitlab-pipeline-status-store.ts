import { TypedBaseStore } from './base-store'
import { Repository } from '../../models/repository'
import { getRemotes } from '../git/remote'
import { git } from '../git/core'
import { getGitLabToken } from '../gitlab/gitlab-token'
import {
  IGitLabJobStatus,
  fetchLatestCommitStatuses,
  isLikelyGitLabHost,
  parseGitLabProject,
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

  /** Read the current cached statuses without triggering a fetch. */
  public getStatuses(): IGitLabPipelineStatusMap {
    return this.statuses
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

    const results = await Promise.all(
      repositories.map(repository =>
        this.getPipelineStatusForRepository(repository, gitlabToken)
      )
    )

    const statuses = new Map<number, ReadonlyArray<IGitLabJobStatus>>()
    for (const result of results) {
      if (result !== null) {
        statuses.set(result.repositoryId, result.statuses)
      }
    }

    this.statuses = statuses
    this.emitUpdate(this.statuses)
  }

  private async getPipelineStatusForRepository(
    repository: Repository,
    gitlabToken: string
  ): Promise<{
    repositoryId: number
    statuses: ReadonlyArray<IGitLabJobStatus>
  } | null> {
    try {
      const remotes = await getRemotes(repository)
      const origin = remotes.find(r => r.name === 'origin')
      if (origin === undefined) {
        return null
      }

      const project = parseGitLabProject(origin.url)
      if (project === null || !isLikelyGitLabHost(project.hostname)) {
        return null
      }

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

      return { repositoryId: repository.id, statuses }
    } catch (e) {
      // Any failure for a single repository (missing on disk, detached
      // HEAD weirdness, network issues, etc.) should never crash the
      // fetch or prevent other repositories from being refreshed.
      log.error(
        `Failed to refresh GitLab pipeline status for '${repository.name}'`,
        e
      )
      return null
    }
  }
}

export const gitLabPipelineStatusStore = new GitLabPipelineStatusStore()
