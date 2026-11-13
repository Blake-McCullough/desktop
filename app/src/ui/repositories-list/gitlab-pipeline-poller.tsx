import * as React from 'react'
import { ILocalRepositoryState, Repository } from '../../models/repository'
import { Repositoryish } from './group-repositories'
import { gitLabPipelineStatusStore } from '../../lib/stores/gitlab-pipeline-status-store'

interface IGitLabPipelinePollerProps {
  readonly repositories: ReadonlyArray<Repositoryish>
  readonly localRepositoryStateLookup: ReadonlyMap<
    number,
    ILocalRepositoryState
  >
  readonly selectedRepository: Repositoryish | null
  /**
   * The sha of the selected repository's tip commit, or `null`. Used to
   * refetch its pipeline right after a branch switch or new commit.
   */
  readonly selectedRepositoryTipSha: string | null
}

/**
 * Keeps GitLab pipeline statuses up to date for every repository. Renders
 * nothing; it lives at the app level so statuses keep updating (for the
 * repository list and History) even when the sidebar is hidden.
 */
export class GitLabPipelinePoller extends React.PureComponent<IGitLabPipelinePollerProps> {
  private repositoriesRefreshTimer: number | null = null

  public componentDidMount() {
    // The store owns the polling loop (and is a no-op without a token), so
    // it can pause while the window is hidden and back off on errors.
    gitLabPipelineStatusStore.startPolling(this.getPollableRepositories)
    this.scheduleRepositoriesRefresh()
  }

  public componentDidUpdate(prevProps: IGitLabPipelinePollerProps) {
    // Repositories load asynchronously at startup (and change when added,
    // cloned or imported). Fetch for any we haven't seen rather than
    // waiting for the next poll; the store skips ones it already knows.
    if (prevProps.repositories !== this.props.repositories) {
      this.scheduleRepositoriesRefresh()
    }

    // After a push (or pull/fetch) a repository's ahead/behind changes;
    // check its latest pushed commit right away instead of at the next tick.
    if (
      prevProps.localRepositoryStateLookup !==
      this.props.localRepositoryStateLookup
    ) {
      const changed = this.getPollableRepositories().filter(r => {
        const before = prevProps.localRepositoryStateLookup.get(r.id)
        const after = this.props.localRepositoryStateLookup.get(r.id)
        return (
          before?.aheadBehind?.ahead !== after?.aheadBehind?.ahead ||
          before?.aheadBehind?.behind !== after?.aheadBehind?.behind
        )
      })
      if (changed.length > 0) {
        gitLabPipelineStatusStore.refresh(changed)
      }
    }

    if (
      prevProps.selectedRepositoryTipSha !==
        this.props.selectedRepositoryTipSha &&
      this.props.selectedRepository instanceof Repository
    ) {
      gitLabPipelineStatusStore.refresh([this.props.selectedRepository])
    }
  }

  public componentWillUnmount() {
    gitLabPipelineStatusStore.stopPolling()
    if (this.repositoriesRefreshTimer !== null) {
      window.clearTimeout(this.repositoriesRefreshTimer)
    }
  }

  private scheduleRepositoriesRefresh() {
    if (this.repositoriesRefreshTimer !== null) {
      window.clearTimeout(this.repositoriesRefreshTimer)
    }
    this.repositoriesRefreshTimer = window.setTimeout(() => {
      this.repositoriesRefreshTimer = null
      gitLabPipelineStatusStore.refresh(this.getPollableRepositories())
    }, 1000)
  }

  private getPollableRepositories = (): ReadonlyArray<Repository> =>
    this.props.repositories.filter(
      (r): r is Repository => r instanceof Repository && !r.missing
    )

  public render() {
    return null
  }
}
