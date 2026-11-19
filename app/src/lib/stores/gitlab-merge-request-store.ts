import { Emitter, Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { GitLabApiError, IGitLabProject } from '../gitlab/gitlab-api'
import { getGitLabToken } from '../gitlab/gitlab-token'
import {
  IMergeRequest,
  IMergeRequestDetails,
  fetchMergeRequestDetails,
  fetchOpenMergeRequests,
} from '../gitlab/merge-requests'
import { gitLabPipelineStatusStore } from './gitlab-pipeline-status-store'

export interface IRepositoryMergeRequests {
  /** null when the repository isn't on GitLab. */
  readonly project: IGitLabProject | null
  /** The branch `current` was looked up for. */
  readonly branch: string | null
  /** The current branch's open merge request, if it has one. */
  readonly current: IMergeRequestDetails | null
  /** The project's open merge requests. */
  readonly list: ReadonlyArray<IMergeRequest>
  readonly isLoading: boolean
  readonly error: string | null
  readonly updatedAt: number | null
}

const Empty: IRepositoryMergeRequests = {
  project: null,
  branch: null,
  current: null,
  list: [],
  isLoading: false,
  error: null,
  updatedAt: null,
}

function describe(e: unknown): string {
  if (e instanceof GitLabApiError) {
    if (e.isUnauthorized) {
      return 'GitLab rejected the token for this server. Check it in Options → GitLab.'
    }
    if (e.isForbidden) {
      return "The token can't read merge requests (it needs read_api or api)."
    }
  }
  return e instanceof Error ? e.message : `${e}`
}

/**
 * Open merge requests for GitLab repositories: the list, and the current
 * branch's merge request with its pipeline and approvals.
 */
class GitLabMergeRequestStore {
  private readonly emitter = new Emitter()
  private readonly states = new Map<number, IRepositoryMergeRequests>()
  private readonly inFlight = new Map<number, Promise<void>>()

  public getState(repository: Repository): IRepositoryMergeRequests {
    return this.states.get(repository.id) ?? Empty
  }

  public onDidUpdate(fn: (repositoryId: number) => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  private update(
    repository: Repository,
    changes: Partial<IRepositoryMergeRequests>
  ) {
    this.states.set(repository.id, { ...this.getState(repository), ...changes })
    this.emitter.emit('did-update', repository.id)
  }

  /**
   * Fetch the repository's open merge requests and the current branch's
   * details. Concurrent calls for the same repository share one fetch.
   */
  public refresh(repository: Repository, branch: string | null) {
    const running = this.inFlight.get(repository.id)
    if (running !== undefined) {
      return running
    }
    const promise = this.doRefresh(repository, branch).finally(() =>
      this.inFlight.delete(repository.id)
    )
    this.inFlight.set(repository.id, promise)
    return promise
  }

  private async doRefresh(repository: Repository, branch: string | null) {
    const project = await gitLabPipelineStatusStore.getGitLabProject(repository)
    if (project === null) {
      this.states.set(repository.id, Empty)
      this.emitter.emit('did-update', repository.id)
      return
    }

    const previous = this.getState(repository)
    // A branch switch makes the old "current" wrong straight away.
    const current =
      previous.branch === branch && previous.current?.sourceBranch === branch
        ? previous.current
        : null
    this.update(repository, { project, branch, current, isLoading: true })

    try {
      const token = await getGitLabToken(project.webBaseUrl)
      if (token === null) {
        this.update(repository, {
          isLoading: false,
          error: `Add a token for ${project.hostname} in Options → GitLab to see merge requests.`,
        })
        return
      }

      const list = await fetchOpenMergeRequests(project, token)
      const mine =
        branch === null
          ? undefined
          : list.find(mr => mr.sourceBranch === branch && !mr.isFromFork)
      const details =
        mine === undefined
          ? null
          : await fetchMergeRequestDetails(project, mine.iid, token)

      this.update(repository, {
        list,
        current: details,
        isLoading: false,
        error: null,
        updatedAt: Date.now(),
      })
    } catch (e) {
      log.warn(
        `[GitLab] couldn't load merge requests for ${repository.name}`,
        e
      )
      this.update(repository, { isLoading: false, error: describe(e) })
    }
  }
}

export const gitLabMergeRequestStore = new GitLabMergeRequestStore()
