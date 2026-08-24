import * as React from 'react'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'

import { Repository, ILocalRepositoryState } from '../../models/repository'
import { Repositoryish } from './group-repositories'
import { RepositoryListItem } from './repository-list-item'
import { generateRepositoryListContextMenu } from './repository-list-item-context-menu'
import {
  ICustomRepositoryGroup,
  OtherGroupId,
  createCustomGroup,
  deleteCustomGroup,
  getCollapsedGroupIds,
  getCustomGroups,
  getRepositoryGroupAssignments,
  getSidebarCollapsed,
  getSidebarWidth,
  renameCustomGroup,
  setGroupCollapsed,
  setRepositoryGroup,
  setSidebarCollapsed,
  setSidebarWidth,
  MaxSidebarWidth,
  MinSidebarWidth,
} from './custom-repository-groups-store'
import { caseInsensitiveCompare } from '../../lib/compare'
import { Dispatcher } from '../dispatcher'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Resizable } from '../resizable'
import { showContextualMenu } from '../../lib/menu-item'
import { IMenuItem } from '../../lib/menu-item'
import { PopupType } from '../../models/popup'
import { Button } from '../lib/button'
import { IMatches } from '../../lib/fuzzy-find'
import { TooltippedContent } from '../lib/tooltipped-content'
import { getRemotes } from '../../lib/git/remote'
import { git } from '../../lib/git/core'
import { getGitLabToken } from '../../lib/gitlab/gitlab-token'
import {
  IGitLabJobStatus,
  fetchLatestCommitStatuses,
  getJobStatusColor,
  isLikelyGitLabHost,
  parseGitLabProject,
} from '../../lib/gitlab/gitlab-api'

const NoMatches: IMatches = { title: [], subtitle: [] }

interface IRepositoriesSidebarProps {
  readonly selectedRepository: Repositoryish | null
  readonly repositories: ReadonlyArray<Repositoryish>

  readonly localRepositoryStateLookup: ReadonlyMap<
    number,
    ILocalRepositoryState
  >

  readonly onSelectionChanged: (repository: Repositoryish) => void
  readonly askForConfirmationOnRemoveRepository: boolean
  readonly onRemoveRepository: (repository: Repositoryish) => void
  readonly onShowRepository: (repository: Repositoryish) => void
  readonly onViewOnGitHub: (repository: Repositoryish) => void
  readonly onOpenInShell: (repository: Repositoryish) => void
  readonly onOpenInExternalEditor: (repository: Repositoryish) => void
  readonly externalEditorLabel?: string
  readonly shellLabel?: string
  readonly dispatcher: Dispatcher
}

interface IGroupSection {
  readonly id: string
  readonly name: string
  /** Whether this section is the built-in "Other" (ungrouped) section */
  readonly isOther: boolean
  readonly repositories: ReadonlyArray<Repositoryish>
}

interface IRepositoriesSidebarState {
  readonly width: number
  readonly collapsed: boolean
  readonly customGroups: ReadonlyArray<ICustomRepositoryGroup>
  readonly repositoryGroups: ReadonlyMap<number, string>
  readonly collapsedGroupIds: ReadonlySet<string>
  readonly draggedRepositoryId: number | null
  readonly dragOverGroupId: string | null

  /** The user's global GitLab personal access token, or null if none is configured. */
  readonly gitlabToken: string | null

  /** Latest known GitLab pipeline job statuses, keyed by repository id. */
  readonly pipelineStatuses: ReadonlyMap<number, ReadonlyArray<IGitLabJobStatus>>
}

/**
 * A persistent, always-visible list of the user's repositories rendered to
 * the left of the main application content. Unlike `RepositoriesList` (which
 * is rendered inside the toolbar's repository foldout) this component is
 * always mounted, resizable, collapsible, and supports organizing
 * repositories into user-defined groups.
 */
export class RepositoriesSidebar extends React.Component<
  IRepositoriesSidebarProps,
  IRepositoriesSidebarState
> {
  public constructor(props: IRepositoriesSidebarProps) {
    super(props)

    this.state = {
      width: getSidebarWidth(),
      collapsed: getSidebarCollapsed(),
      customGroups: getCustomGroups(),
      repositoryGroups: getRepositoryGroupAssignments(),
      collapsedGroupIds: getCollapsedGroupIds(),
      draggedRepositoryId: null,
      dragOverGroupId: null,
      gitlabToken: null,
      pipelineStatuses: new Map(),
    }
  }

  private pipelineStatusesInterval: number | null = null

  public componentDidMount() {
    this.loadGitLabTokenAndStartPolling()
  }

  public componentWillUnmount() {
    if (this.pipelineStatusesInterval !== null) {
      window.clearInterval(this.pipelineStatusesInterval)
      this.pipelineStatusesInterval = null
    }
  }

  private async loadGitLabTokenAndStartPolling() {
    const gitlabToken = await getGitLabToken()
    this.setState({ gitlabToken })

    // If there's no token configured, this feature is fully inert: no
    // network requests, no git commands, nothing scheduled.
    if (gitlabToken === null) {
      return
    }

    this.refreshPipelineStatuses()

    const threeMinutes = 3 * 60 * 1000
    this.pipelineStatusesInterval = window.setInterval(
      this.refreshPipelineStatuses,
      threeMinutes
    )
  }

  private refreshPipelineStatuses = async () => {
    const { gitlabToken } = this.state
    if (gitlabToken === null) {
      return
    }

    const results = await Promise.all(
      this.props.repositories.map(repository =>
        this.getPipelineStatusForRepository(repository, gitlabToken)
      )
    )

    const pipelineStatuses = new Map<number, ReadonlyArray<IGitLabJobStatus>>()
    for (const result of results) {
      if (result !== null) {
        pipelineStatuses.set(result.repositoryId, result.statuses)
      }
    }

    this.setState({ pipelineStatuses })
  }

  private async getPipelineStatusForRepository(
    repository: Repositoryish,
    gitlabToken: string
  ): Promise<{
    repositoryId: number
    statuses: ReadonlyArray<IGitLabJobStatus>
  } | null> {
    if (!(repository instanceof Repository)) {
      return null
    }

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
      // sidebar or prevent other repositories from being refreshed.
      log.error(
        `Failed to refresh GitLab pipeline status for '${repository.name}'`,
        e
      )
      return null
    }
  }

  private getSections = memoizeOne(
    (
      repositories: ReadonlyArray<Repositoryish>,
      customGroups: ReadonlyArray<ICustomRepositoryGroup>,
      repositoryGroups: ReadonlyMap<number, string>
    ): ReadonlyArray<IGroupSection> => {
      const byGroup = new Map<string, Repositoryish[]>()
      const other: Repositoryish[] = []

      for (const repository of repositories) {
        const groupId = repositoryGroups.get(repository.id)
        const group =
          groupId !== undefined
            ? customGroups.find(g => g.id === groupId)
            : undefined

        if (group !== undefined) {
          const repos = byGroup.get(group.id) ?? []
          repos.push(repository)
          byGroup.set(group.id, repos)
        } else {
          other.push(repository)
        }
      }

      const sortRepos = (repos: ReadonlyArray<Repositoryish>) =>
        [...repos].sort((x, y) => caseInsensitiveCompare(x.name, y.name))

      const sections: Array<IGroupSection> = customGroups.map(group => ({
        id: group.id,
        name: group.name,
        isOther: false,
        repositories: sortRepos(byGroup.get(group.id) ?? []),
      }))

      sections.push({
        id: OtherGroupId,
        name: 'Other',
        isOther: true,
        repositories: sortRepos(other),
      })

      return sections
    }
  )

  private refreshFromStore = () => {
    this.setState({
      customGroups: getCustomGroups(),
      repositoryGroups: getRepositoryGroupAssignments(),
      collapsedGroupIds: getCollapsedGroupIds(),
    })
  }

  private onToggleSidebarCollapsed = () => {
    const collapsed = !this.state.collapsed
    setSidebarCollapsed(collapsed)
    this.setState({ collapsed })
  }

  private onResize = (width: number) => {
    setSidebarWidth(width)
    this.setState({ width })
  }

  private onResetWidth = () => {
    this.onResize(220)
  }

  private onToggleGroupCollapsed = (groupId: string) => {
    const collapsed = !this.state.collapsedGroupIds.has(groupId)
    setGroupCollapsed(groupId, collapsed)
    this.refreshFromStore()
  }

  private onItemClick = (repository: Repositoryish) => {
    this.props.dispatcher.recordRepoClicked(false)
    this.props.onSelectionChanged(repository)
  }

  private onMoveToGroup = (repository: Repositoryish, groupId: string) => {
    setRepositoryGroup(
      repository.id,
      groupId === OtherGroupId ? null : groupId
    )
    this.refreshFromStore()
  }

  private onMoveToNewGroup = (repository: Repositoryish) => {
    this.props.dispatcher.showPopup({
      type: PopupType.RepositoryGroupNamePrompt,
      title: 'New Group',
      okButtonText: 'Create',
      onSubmit: name => {
        const group = createCustomGroup(name)
        setRepositoryGroup(repository.id, group.id)
        this.refreshFromStore()
      },
    })
  }

  private onNewGroupClick = () => {
    this.props.dispatcher.showPopup({
      type: PopupType.RepositoryGroupNamePrompt,
      title: 'New Group',
      okButtonText: 'Create',
      onSubmit: name => {
        createCustomGroup(name)
        this.refreshFromStore()
      },
    })
  }

  private onRenameGroup = (groupId: string, currentName: string) => {
    this.props.dispatcher.showPopup({
      type: PopupType.RepositoryGroupNamePrompt,
      title: 'Rename Group',
      okButtonText: 'Rename',
      defaultValue: currentName,
      onSubmit: name => {
        renameCustomGroup(groupId, name)
        this.refreshFromStore()
      },
    })
  }

  private onDeleteGroup = (groupId: string, name: string) => {
    if (!window.confirm(`Delete the group "${name}"?`)) {
      return
    }

    deleteCustomGroup(groupId)
    this.refreshFromStore()
  }

  private onItemContextMenu = (
    repository: Repositoryish,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    const currentGroupId =
      this.state.repositoryGroups.get(repository.id) ?? OtherGroupId

    const items = generateRepositoryListContextMenu({
      onRemoveRepository: this.props.onRemoveRepository,
      onShowRepository: this.props.onShowRepository,
      onOpenInShell: this.props.onOpenInShell,
      onOpenInExternalEditor: this.props.onOpenInExternalEditor,
      askForConfirmationOnRemoveRepository:
        this.props.askForConfirmationOnRemoveRepository,
      externalEditorLabel: this.props.externalEditorLabel,
      onChangeRepositoryAlias: this.onChangeRepositoryAlias,
      onRemoveRepositoryAlias: this.onRemoveRepositoryAlias,
      onViewOnGitHub: this.props.onViewOnGitHub,
      repository,
      shellLabel: this.props.shellLabel,
      customGroups: this.state.customGroups,
      currentGroupId,
      onMoveToGroup: this.onMoveToGroup,
      onMoveToNewGroup: this.onMoveToNewGroup,
    })

    showContextualMenu(items)
  }

  private onGroupHeaderContextMenu = (
    section: IGroupSection,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    if (section.isOther) {
      const items: IMenuItem[] = [
        { label: 'New group…', action: this.onNewGroupClick },
      ]
      showContextualMenu(items)
      return
    }

    const items: IMenuItem[] = [
      {
        label: 'Rename group…',
        action: () => this.onRenameGroup(section.id, section.name),
      },
      {
        label: 'Delete group…',
        action: () => this.onDeleteGroup(section.id, section.name),
      },
      { type: 'separator' },
      { label: 'New group…', action: this.onNewGroupClick },
    ]
    showContextualMenu(items)
  }

  private onChangeRepositoryAlias = (repository: Repository) => {
    this.props.dispatcher.showPopup({
      type: PopupType.ChangeRepositoryAlias,
      repository,
    })
  }

  private onRemoveRepositoryAlias = (repository: Repository) => {
    this.props.dispatcher.changeRepositoryAlias(repository, null)
  }

  private onDragStart = (
    repository: Repositoryish,
    event: React.DragEvent<HTMLDivElement>
  ) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', repository.id.toString())
    this.setState({ draggedRepositoryId: repository.id })
  }

  private onDragEnd = () => {
    this.setState({ draggedRepositoryId: null, dragOverGroupId: null })
  }

  private onGroupDragOver = (
    groupId: string,
    event: React.DragEvent<HTMLDivElement>
  ) => {
    if (this.state.draggedRepositoryId === null) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    if (this.state.dragOverGroupId !== groupId) {
      this.setState({ dragOverGroupId: groupId })
    }
  }

  private onGroupDragLeave = (groupId: string) => {
    if (this.state.dragOverGroupId === groupId) {
      this.setState({ dragOverGroupId: null })
    }
  }

  private onGroupDrop = (
    groupId: string,
    event: React.DragEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    const repositoryId = this.state.draggedRepositoryId

    this.setState({ draggedRepositoryId: null, dragOverGroupId: null })

    if (repositoryId === null) {
      return
    }

    setRepositoryGroup(
      repositoryId,
      groupId === OtherGroupId ? null : groupId
    )
    this.refreshFromStore()
  }

  private renderRepositoryRow = (repository: Repositoryish) => {
    const repoState = this.props.localRepositoryStateLookup.get(
      repository.id
    )
    const selected =
      this.props.selectedRepository !== null &&
      this.props.selectedRepository.id === repository.id

    return (
      <div
        key={repository.id}
        className={classNames('repositories-sidebar-item', 'repository-list', {
          selected,
        })}
        draggable={true}
        onDragStart={event => this.onDragStart(repository, event)}
        onDragEnd={this.onDragEnd}
        onClick={() => this.onItemClick(repository)}
        onContextMenu={event => this.onItemContextMenu(repository, event)}
      >
        <RepositoryListItem
          repository={repository}
          needsDisambiguation={false}
          matches={NoMatches}
          aheadBehind={repoState?.aheadBehind ?? null}
          changedFilesCount={repoState?.changedFilesCount ?? 0}
        />
        {this.renderPipelineStatus(repository)}
      </div>
    )
  }

  private renderPipelineStatus(repository: Repositoryish) {
    const jobs = this.state.pipelineStatuses.get(repository.id)
    if (jobs === undefined || jobs.length === 0) {
      return null
    }

    return (
      <div className="gitlab-pipeline-status">
        {jobs.map((job, index) => (
          <TooltippedContent
            key={`${job.name}-${index}`}
            className="gitlab-job-dot-wrapper"
            tagName="span"
            tooltip={job.name}
          >
            <span
              className={`gitlab-job-dot gitlab-job-dot-${getJobStatusColor(
                job.status
              )}`}
            />
          </TooltippedContent>
        ))}
      </div>
    )
  }

  private renderGroupSection = (section: IGroupSection) => {
    const isCollapsed = this.state.collapsedGroupIds.has(section.id)
    const isDragOver = this.state.dragOverGroupId === section.id

    return (
      <div
        key={section.id}
        className={classNames('repositories-sidebar-group', {
          'drag-over': isDragOver,
        })}
        onDragOver={event => this.onGroupDragOver(section.id, event)}
        onDragLeave={() => this.onGroupDragLeave(section.id)}
        onDrop={event => this.onGroupDrop(section.id, event)}
      >
        <div
          className="repositories-sidebar-group-header"
          onClick={() => this.onToggleGroupCollapsed(section.id)}
          onContextMenu={event =>
            this.onGroupHeaderContextMenu(section, event)
          }
        >
          <Octicon
            symbol={isCollapsed ? octicons.chevronRight : octicons.chevronDown}
            className="collapse-icon"
          />
          <span className="name">{section.name}</span>
          <span className="count">{section.repositories.length}</span>
        </div>

        {!isCollapsed && (
          <div className="repositories-sidebar-group-items">
            {section.repositories.length === 0 ? (
              <div className="no-repositories">No repositories</div>
            ) : (
              section.repositories.map(this.renderRepositoryRow)
            )}
          </div>
        )}
      </div>
    )
  }

  private onAddRepositoryClick = () => {
    const items: IMenuItem[] = [
      {
        label: __DARWIN__ ? 'Clone Repository…' : 'Clone repository…',
        action: () =>
          this.props.dispatcher.showPopup({
            type: PopupType.CloneRepository,
            initialURL: null,
          }),
      },
      {
        label: __DARWIN__
          ? 'Create New Repository…'
          : 'Create new repository…',
        action: () =>
          this.props.dispatcher.showPopup({
            type: PopupType.CreateRepository,
          }),
      },
      {
        label: __DARWIN__
          ? 'Add Existing Repository…'
          : 'Add existing repository…',
        action: () =>
          this.props.dispatcher.showPopup({ type: PopupType.AddRepository }),
      },
      { type: 'separator' },
      { label: 'New group…', action: this.onNewGroupClick },
    ]

    showContextualMenu(items)
  }

  private renderExpandedContent() {
    const sections = this.getSections(
      this.props.repositories,
      this.state.customGroups,
      this.state.repositoryGroups
    )

    return (
      <div className="repositories-sidebar-inner">
        <div className="repositories-sidebar-header">
          <span className="title">Repositories</span>
          <Button
            className="add-repository-button"
            onClick={this.onAddRepositoryClick}
            tooltip="Add repository or group"
          >
            <Octicon symbol={octicons.plus} />
          </Button>
          <button
            type="button"
            className="collapse-sidebar-button"
            onClick={this.onToggleSidebarCollapsed}
            aria-label="Collapse repositories sidebar"
          >
            <Octicon symbol={octicons.sidebarCollapse} />
          </button>
        </div>
        <div className="repositories-sidebar-groups">
          {sections.map(this.renderGroupSection)}
        </div>
      </div>
    )
  }

  public render() {
    if (this.state.collapsed) {
      return (
        <div className="repositories-sidebar collapsed">
          <button
            type="button"
            className="expand-sidebar-button"
            onClick={this.onToggleSidebarCollapsed}
            aria-label="Expand repositories sidebar"
          >
            <Octicon symbol={octicons.sidebarCollapse} />
          </button>
        </div>
      )
    }

    return (
      <div className="repositories-sidebar">
        <Resizable
          id="repositories-sidebar-resizable"
          width={this.state.width}
          minimumWidth={MinSidebarWidth}
          maximumWidth={MaxSidebarWidth}
          onResize={this.onResize}
          onReset={this.onResetWidth}
          description="Repositories sidebar"
        >
          {this.renderExpandedContent()}
        </Resizable>
      </div>
    )
  }
}
