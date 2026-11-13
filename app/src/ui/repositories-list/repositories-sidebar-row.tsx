import * as React from 'react'
import classNames from 'classnames'
import { Repository } from '../../models/repository'
import { IAheadBehind } from '../../models/branch'
import { Repositoryish } from './group-repositories'
import { RepositoryListItem } from './repository-list-item'
import { IMatches } from '../../lib/fuzzy-find'
import { IGitLabJobStatus } from '../../lib/gitlab/gitlab-api'
import { RepositoryPipelineStatus } from './repository-pipeline-status'
import { IRepositoryPipelineState } from '../../lib/stores/gitlab-pipeline-status-store'

const NoMatches: IMatches = { title: [], subtitle: [] }

interface IRepositoriesSidebarRowProps {
  readonly repository: Repositoryish
  readonly selected: boolean
  readonly aheadBehind: IAheadBehind | null
  readonly changedFilesCount: number
  readonly pipeline: IRepositoryPipelineState | undefined
  readonly playingJobIds: ReadonlySet<number>
  readonly isDragging: boolean

  readonly onClick: (repository: Repositoryish) => void
  readonly onContextMenu: (
    repository: Repositoryish,
    event: React.MouseEvent<HTMLDivElement>
  ) => void
  readonly onDragStart: (
    repository: Repositoryish,
    event: React.DragEvent<HTMLDivElement>
  ) => void
  readonly onDragEnd: () => void
  readonly onPlayJob: (repository: Repositoryish, job: IGitLabJobStatus) => void
  readonly onOpenUrl: (url: string) => void
}

/**
 * One repository in the sidebar. A `PureComponent` with stable callbacks so
 * that only rows whose data actually changed re-render.
 */
export class RepositoriesSidebarRow extends React.PureComponent<IRepositoriesSidebarRowProps> {
  private onClick = () => this.props.onClick(this.props.repository)

  private onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.props.onClick(this.props.repository)
    }
  }

  private onContextMenu = (event: React.MouseEvent<HTMLDivElement>) =>
    this.props.onContextMenu(this.props.repository, event)

  private onDragStart = (event: React.DragEvent<HTMLDivElement>) =>
    this.props.onDragStart(this.props.repository, event)

  public render() {
    const { repository, selected, isDragging } = this.props

    return (
      <div
        className={classNames('repositories-sidebar-item', 'repository-list', {
          selected,
          dragging: isDragging,
        })}
        role="button"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        draggable={true}
        onDragStart={this.onDragStart}
        onDragEnd={this.props.onDragEnd}
        onClick={this.onClick}
        onKeyDown={this.onKeyDown}
        onContextMenu={this.onContextMenu}
      >
        <RepositoryListItem
          repository={repository}
          needsDisambiguation={false}
          matches={NoMatches}
          aheadBehind={this.props.aheadBehind}
          changedFilesCount={this.props.changedFilesCount}
        />
        {repository instanceof Repository && (
          <RepositoryPipelineStatus
            repository={repository}
            pipeline={this.props.pipeline}
            playingJobIds={this.props.playingJobIds}
            onPlayJob={this.props.onPlayJob}
            onOpenUrl={this.props.onOpenUrl}
          />
        )}
      </div>
    )
  }
}
