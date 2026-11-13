/* eslint-disable github/a11y-no-title-attribute */
// Native `title` tooltips are used deliberately on these small, numerous
// status elements (each also has an aria-label or visible text): the shared
// TooltippedContent component attaches a ResizeObserver and about a dozen
// event listeners per element, which adds up quickly across every job of
// every repository in the sidebar.
import * as React from 'react'
import * as Path from 'path'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import { Disposable } from 'event-kit'

import { Repository, ILocalRepositoryState } from '../../models/repository'
import { Account } from '../../models/account'
import { Repositoryish } from './group-repositories'
import { RepositoriesSidebarRow } from './repositories-sidebar-row'
import { generateRepositoryListContextMenu } from './repository-list-item-context-menu'
import {
  GroupColorPalette,
  ICustomRepositoryGroup,
  OtherGroupId,
  createCustomGroup,
  deleteCustomGroup,
  getCollapsedGroupIds,
  getCustomGroups,
  getRepositoryGroupAssignments,
  getSidebarCollapsed,
  getSidebarWidth,
  hexToRgba,
  onCustomGroupsChanged,
  renameCustomGroup,
  setGroupCollapsed,
  setGroupColor,
  setRepositoryGroup,
  setSidebarCollapsed,
  setSidebarWidth,
  DefaultSidebarWidth,
  MaxSidebarWidth,
  MinSidebarWidth,
} from './custom-repository-groups-store'
import { caseInsensitiveCompare } from '../../lib/compare'
import { Dispatcher } from '../dispatcher'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Resizable } from '../resizable'
import { showContextualMenu, IMenuItem } from '../../lib/menu-item'
import { PopupType } from '../../models/popup'
import { PreferencesTab } from '../../models/preferences'
import { Button } from '../lib/button'
import { IGitLabJobStatus } from '../../lib/gitlab/gitlab-api'
import {
  IGitLabPipelineStatusMap,
  gitLabPipelineStatusStore,
} from '../../lib/stores/gitlab-pipeline-status-store'
import { enableWorktreeSupport } from '../../lib/feature-flag'
import { showOpenDialog, showSaveDialog } from '../main-process-proxy'
import {
  buildRepositoryExport,
  readRepositoryExport,
  writeRepositoryExport,
} from '../../lib/repository-import-export'

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

  /** The signed-in accounts, used to offer repository account choices. */
  readonly accounts: ReadonlyArray<Account>
  readonly onChangeRepositoryAccount: (
    repository: Repository,
    login: string
  ) => void
  readonly onShowRepositorySettings: (repository: Repository) => void

  /**
   * The sha of the currently selected repository's tip commit, or `null`.
   * Used to refetch the selected repository's pipeline immediately after a
   * branch switch or new commit.
   */
  readonly selectedRepositoryTipSha: string | null
}

interface IGroupSection {
  readonly id: string
  readonly name: string
  /** Whether this section is the built-in "Other" (ungrouped) section */
  readonly isOther: boolean
  readonly repositories: ReadonlyArray<Repositoryish>
  /** The group's `#rrggbb` color, if any. Never set for "Other". */
  readonly color?: string
}

interface IRepositoriesSidebarState {
  readonly width: number
  readonly collapsed: boolean
  readonly customGroups: ReadonlyArray<ICustomRepositoryGroup>
  readonly repositoryGroups: ReadonlyMap<number, string>
  readonly collapsedGroupIds: ReadonlySet<string>
  readonly draggedRepositoryId: number | null
  readonly dragOverGroupId: string | null
  readonly filterText: string

  /** Latest known GitLab pipeline states, keyed by repository id. */
  readonly pipelineStatuses: IGitLabPipelineStatusMap
  readonly gitLabAuthError: string | null
  /** When GitLab requests resume after a rate limit (epoch ms), or null. */
  readonly gitLabRateLimitedUntil: number | null

  /** Ids of jobs currently being "played" (manual job run in flight). */
  readonly playingJobIds: ReadonlySet<number>

  /** A short-lived message shown at the bottom of the sidebar. */
  readonly notice: { readonly text: string; readonly isError: boolean } | null
}

const getDisplayName = (repo: Repositoryish): string =>
  (repo instanceof Repository ? repo.alias : null) ?? repo.name

const EmptyPlayingJobIds: ReadonlySet<number> = new Set()

/**
 * A persistent, always-visible list of the user's repositories to the left
 * of the main content. Resizable, collapsible, filterable, and supports
 * organizing repositories into colored groups by drag and drop.
 */
export class RepositoriesSidebar extends React.PureComponent<
  IRepositoriesSidebarProps,
  IRepositoriesSidebarState
> {
  private readonly disposables: Array<Disposable> = []
  private noticeTimer: number | null = null
  private repositoriesRefreshTimer: number | null = null
  private filterInputRef = React.createRef<HTMLInputElement>()

  private getSections = memoizeOne(
    (
      repositories: ReadonlyArray<Repositoryish>,
      customGroups: ReadonlyArray<ICustomRepositoryGroup>,
      repositoryGroups: ReadonlyMap<number, string>,
      filterText: string
    ): ReadonlyArray<IGroupSection> => {
      const groupsById = new Map(customGroups.map(g => [g.id, g]))
      const byGroup = new Map<string, Repositoryish[]>()
      const other: Repositoryish[] = []
      const filter = filterText.trim().toLowerCase()

      for (const repository of repositories) {
        if (filter.length > 0) {
          const haystack = `${getDisplayName(repository)}\n${
            repository.name
          }\n${repository.path}`.toLowerCase()
          if (!haystack.includes(filter)) {
            continue
          }
        }

        const groupId = repositoryGroups.get(repository.id)
        const group =
          groupId !== undefined ? groupsById.get(groupId) : undefined

        if (group !== undefined) {
          const repos = byGroup.get(group.id)
          if (repos === undefined) {
            byGroup.set(group.id, [repository])
          } else {
            repos.push(repository)
          }
        } else {
          other.push(repository)
        }
      }

      const sortRepos = (repos: ReadonlyArray<Repositoryish>) =>
        [...repos].sort((x, y) =>
          caseInsensitiveCompare(getDisplayName(x), getDisplayName(y))
        )

      const sections: Array<IGroupSection> = [...customGroups]
        .sort((x, y) => caseInsensitiveCompare(x.name, y.name))
        .map(group => ({
          id: group.id,
          name: group.name,
          isOther: false,
          repositories: sortRepos(byGroup.get(group.id) ?? []),
          color: group.color,
        }))

      sections.push({
        id: OtherGroupId,
        name: customGroups.length > 0 ? 'Other' : 'All repositories',
        isOther: true,
        repositories: sortRepos(other),
      })

      // While filtering, hide sections with no matches.
      return filter.length > 0
        ? sections.filter(s => s.repositories.length > 0)
        : sections
    }
  )

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
      filterText: '',
      pipelineStatuses: gitLabPipelineStatusStore.getStatuses(),
      gitLabAuthError: gitLabPipelineStatusStore.getAuthError(),
      gitLabRateLimitedUntil: gitLabPipelineStatusStore.getRateLimitedUntil(),
      playingJobIds: EmptyPlayingJobIds,
      notice: null,
    }
  }

  public componentDidMount() {
    this.disposables.push(
      gitLabPipelineStatusStore.onDidUpdate(pipelineStatuses => {
        this.setState({
          pipelineStatuses,
          gitLabAuthError: gitLabPipelineStatusStore.getAuthError(),
          gitLabRateLimitedUntil:
            gitLabPipelineStatusStore.getRateLimitedUntil(),
        })
      }),
      onCustomGroupsChanged(this.refreshFromStore)
    )

    // The store owns the polling loop (and is a no-op without a token), so
    // it can pause while the window is hidden and back off on errors.
    gitLabPipelineStatusStore.startPolling(this.getPollableRepositories)
  }

  public componentDidUpdate(prevProps: IRepositoriesSidebarProps) {
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
    for (const d of this.disposables) {
      d.dispose()
    }
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer)
    }
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

  private showNotice(text: string, isError = false) {
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer)
    }
    this.setState({ notice: { text, isError } })
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null
      this.setState({ notice: null })
    }, 5000)
  }

  /* -------------------------------- sections ------------------------------ */

  private refreshFromStore = () => {
    this.setState({
      customGroups: getCustomGroups(),
      repositoryGroups: getRepositoryGroupAssignments(),
      collapsedGroupIds: getCollapsedGroupIds(),
    })
  }

  /* ----------------------------- sidebar chrome --------------------------- */

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
    this.onResize(DefaultSidebarWidth)
  }

  private onFilterChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ filterText: event.currentTarget.value })
  }

  private onFilterKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && this.state.filterText.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      this.setState({ filterText: '' })
    } else if (event.key === 'Enter') {
      // Enter opens the first match.
      const sections = this.getSections(
        this.props.repositories,
        this.state.customGroups,
        this.state.repositoryGroups,
        this.state.filterText
      )
      const first = sections.find(s => s.repositories.length > 0)
      if (first !== undefined) {
        this.onItemClick(first.repositories[0])
      }
    }
  }

  private onClearFilter = () => {
    this.setState({ filterText: '' })
    this.filterInputRef.current?.focus()
  }

  private onToggleGroupCollapsed = (event: React.MouseEvent<HTMLElement>) => {
    const groupId = event.currentTarget.dataset.groupId
    if (groupId === undefined) {
      return
    }
    setGroupCollapsed(groupId, !this.state.collapsedGroupIds.has(groupId))
  }

  private onGroupHeaderKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const groupId = event.currentTarget.dataset.groupId
    if (groupId !== undefined && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      setGroupCollapsed(groupId, !this.state.collapsedGroupIds.has(groupId))
    }
  }

  private onCollapseAll = (collapse: boolean) => {
    const ids = [OtherGroupId, ...this.state.customGroups.map(g => g.id)]
    for (const id of ids) {
      setGroupCollapsed(id, collapse)
    }
  }

  /* --------------------------------- items -------------------------------- */

  private onItemClick = (repository: Repositoryish) => {
    this.props.dispatcher.recordRepoClicked(false)
    this.props.onSelectionChanged(repository)
  }

  private onMoveToGroup = (repository: Repositoryish, groupId: string) => {
    setRepositoryGroup(repository.id, groupId === OtherGroupId ? null : groupId)
  }

  private promptForGroupName(
    title: string,
    okButtonText: string,
    onSubmit: (name: string) => void,
    defaultValue?: string
  ) {
    this.props.dispatcher.showPopup({
      type: PopupType.RepositoryGroupNamePrompt,
      title,
      okButtonText,
      defaultValue,
      onSubmit,
    })
  }

  private onMoveToNewGroup = (repository: Repositoryish) => {
    this.promptForGroupName('New Group', 'Create', name => {
      const group = createCustomGroup(name)
      setRepositoryGroup(repository.id, group.id)
    })
  }

  private onNewGroupClick = () => {
    this.promptForGroupName('New Group', 'Create', name =>
      createCustomGroup(name)
    )
  }

  private onRenameGroup = (groupId: string, currentName: string) => {
    this.promptForGroupName(
      'Rename Group',
      'Rename',
      name => renameCustomGroup(groupId, name),
      currentName
    )
  }

  private onDeleteGroup = (section: IGroupSection) => {
    const count = section.repositories.length
    const detail =
      count > 0
        ? ` Its ${count} ${
            count === 1 ? 'repository' : 'repositories'
          } will move to "Other".`
        : ''
    if (!window.confirm(`Delete the group "${section.name}"?${detail}`)) {
      return
    }

    deleteCustomGroup(section.id)
  }

  private onCustomGroupColorClick = (section: IGroupSection) => {
    this.props.dispatcher.showPopup({
      type: PopupType.RepositoryGroupColorPrompt,
      defaultValue: section.color,
      onSubmit: hex => setGroupColor(section.id, hex),
    })
  }

  private buildGroupColorMenuItems = (section: IGroupSection): IMenuItem[] => {
    const isCustomColor =
      section.color !== undefined &&
      !GroupColorPalette.some(option => option.hex === section.color)

    const items: IMenuItem[] = [
      {
        label: 'None',
        type: 'checkbox',
        checked: section.color === undefined,
        action: () => setGroupColor(section.id, null),
      },
      { type: 'separator' },
    ]

    for (const option of GroupColorPalette) {
      items.push({
        label: option.label,
        type: 'checkbox',
        checked: section.color === option.hex,
        action: () => setGroupColor(section.id, option.hex),
      })
    }

    items.push({ type: 'separator' })
    items.push({
      label: isCustomColor ? `Custom (${section.color})…` : 'Custom color…',
      type: 'checkbox',
      checked: isCustomColor,
      action: () => this.onCustomGroupColorClick(section),
    })

    return items
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
      accounts: this.props.accounts,
      onChangeRepositoryAccount: this.props.onChangeRepositoryAccount,
      onShowRepositorySettings: this.props.onShowRepositorySettings,
      externalEditorLabel: this.props.externalEditorLabel,
      onChangeRepositoryAlias: this.onChangeRepositoryAlias,
      onRemoveRepositoryAlias: this.onRemoveRepositoryAlias,
      onViewOnGitHub: this.props.onViewOnGitHub,
      onCreateWorktree: enableWorktreeSupport()
        ? this.onCreateWorktree
        : undefined,
      onViewHistoryGraph: this.onViewHistoryGraph,
      onMoveRepository: this.onMoveRepository,
      onShowWorktrees: enableWorktreeSupport()
        ? this.onShowWorktrees
        : undefined,
      repository,
      shellLabel: this.props.shellLabel,
      customGroups: this.state.customGroups,
      currentGroupId,
      onMoveToGroup: this.onMoveToGroup,
      onMoveToNewGroup: this.onMoveToNewGroup,
    })

    showContextualMenu(items)
  }

  private onCreateWorktree = (repository: Repository) => {
    this.props.dispatcher.showPopup({ type: PopupType.AddWorktree, repository })
  }

  private onViewHistoryGraph = (repository: Repository) => {
    this.props.dispatcher.showPopup({
      type: PopupType.CommitGraph,
      repository,
    })
  }

  private onMoveRepository = (repository: Repository) => {
    this.showMoveRepositories([repository])
  }

  private showMoveRepositories(
    repositories: ReadonlyArray<Repositoryish>,
    label?: string
  ) {
    const movable = repositories.filter(
      (r): r is Repository => r instanceof Repository
    )
    if (movable.length === 0) {
      return
    }
    this.props.dispatcher.showPopup({
      type: PopupType.MoveRepositories,
      repositories: movable,
      label,
    })
  }

  /** Every repository in a group, ignoring the filter. */
  private getGroupRepositories(groupId: string) {
    return this.props.repositories.filter(
      r => (this.state.repositoryGroups.get(r.id) ?? OtherGroupId) === groupId
    )
  }

  private onShowWorktrees = (repository: Repository) => {
    this.props.dispatcher.showPopup({
      type: PopupType.WorktreeViewer,
      repository,
    })
  }

  private onGroupHeaderContextMenu = (
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    const section = this.findSection(event.currentTarget.dataset.groupId)
    if (section === undefined) {
      return
    }

    const common: IMenuItem[] = [
      { type: 'separator' },
      { label: 'New group…', action: this.onNewGroupClick },
      { label: 'Collapse all groups', action: () => this.onCollapseAll(true) },
      { label: 'Expand all groups', action: () => this.onCollapseAll(false) },
    ]

    const groupRepositories = this.getGroupRepositories(section.id)
    const moveGroup: IMenuItem = {
      label: __DARWIN__ ? 'Move Group’s Folders…' : 'Move group’s folders…',
      action: () =>
        this.showMoveRepositories(
          groupRepositories,
          section.isOther ? undefined : section.name
        ),
      enabled: groupRepositories.some(
        r => r instanceof Repository && !r.missing
      ),
    }

    if (section.isOther) {
      showContextualMenu([moveGroup, ...common])
      return
    }

    showContextualMenu([
      moveGroup,
      { type: 'separator' },
      {
        label: 'Rename group…',
        action: () => this.onRenameGroup(section.id, section.name),
      },
      { label: 'Set color', submenu: this.buildGroupColorMenuItems(section) },
      { label: 'Delete group…', action: () => this.onDeleteGroup(section) },
      ...common,
    ])
  }

  private findSection(id: string | undefined) {
    if (id === undefined) {
      return undefined
    }
    return this.getSections(
      this.props.repositories,
      this.state.customGroups,
      this.state.repositoryGroups,
      this.state.filterText
    ).find(s => s.id === id)
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

  /* ------------------------------ drag and drop --------------------------- */

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

  private onGroupDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (this.state.draggedRepositoryId === null) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    const groupId = event.currentTarget.dataset.groupId ?? null
    if (this.state.dragOverGroupId !== groupId) {
      this.setState({ dragOverGroupId: groupId })
    }
  }

  private onGroupDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    // Ignore leaving into a child element of the same group.
    const related = event.relatedTarget as Node | null
    if (related !== null && event.currentTarget.contains(related)) {
      return
    }
    if (this.state.dragOverGroupId === event.currentTarget.dataset.groupId) {
      this.setState({ dragOverGroupId: null })
    }
  }

  private onGroupDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()

    const repositoryId = this.state.draggedRepositoryId
    const groupId = event.currentTarget.dataset.groupId

    this.setState({ draggedRepositoryId: null, dragOverGroupId: null })

    if (repositoryId === null || groupId === undefined) {
      return
    }

    setRepositoryGroup(repositoryId, groupId === OtherGroupId ? null : groupId)
  }

  /* --------------------------------- GitLab ------------------------------- */

  private onPlayJob = (repository: Repositoryish, job: IGitLabJobStatus) => {
    if (
      !(repository instanceof Repository) ||
      this.state.playingJobIds.has(job.id)
    ) {
      return
    }

    this.setState(prev => ({
      playingJobIds: new Set(prev.playingJobIds).add(job.id),
    }))

    gitLabPipelineStatusStore
      .playJob(repository, job.id)
      .then(
        () => this.showNotice(`Started "${job.name}"`),
        e => {
          log.error(`Failed to play GitLab job '${job.name}'`, e)
          this.showNotice(e.message, true)
        }
      )
      .finally(() => {
        this.setState(prev => {
          const playingJobIds = new Set(prev.playingJobIds)
          playingJobIds.delete(job.id)
          return { playingJobIds }
        })
      })
  }

  private onOpenUrl = (url: string) => {
    this.props.dispatcher.openInBrowser(url)
  }

  private onOpenGitLabPreferences = () => {
    this.props.dispatcher.showPopup({
      type: PopupType.Preferences,
      initialSelectedTab: PreferencesTab.GitLab,
    })
  }

  /* ----------------------------- import / export -------------------------- */

  private onExportClick = async () => {
    const repositories = this.props.repositories.filter(
      (r): r is Repository => r instanceof Repository
    )

    const path = await showSaveDialog({
      title: 'Export repositories',
      buttonLabel: 'Export',
      defaultPath: 'github-desktop-repositories.json',
      filters: [{ name: 'Repository list', extensions: ['json'] }],
    })

    if (path === null) {
      return
    }

    try {
      const data = await buildRepositoryExport(repositories)
      await writeRepositoryExport(path, data)
      this.showNotice(
        `Exported ${data.repositories.length} repositories to ${Path.basename(
          path
        )}`
      )
    } catch (e) {
      log.error('Failed to export repositories', e)
      this.props.dispatcher.postError(
        new Error(`Couldn't export repositories: ${e.message}`)
      )
    }
  }

  private onImportClick = async () => {
    const path = await showOpenDialog({
      title: 'Import repositories',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [{ name: 'Repository list', extensions: ['json'] }],
    })

    if (path === null) {
      return
    }

    try {
      const data = await readRepositoryExport(path)
      this.props.dispatcher.showPopup({
        type: PopupType.ImportRepositories,
        data,
        fileName: Path.basename(path),
      })
    } catch (e) {
      this.props.dispatcher.postError(e)
    }
  }

  private onAddRepositoryClick = () => {
    const { dispatcher } = this.props
    const items: IMenuItem[] = [
      {
        label: __DARWIN__ ? 'Clone Repository…' : 'Clone repository…',
        action: () =>
          dispatcher.showPopup({
            type: PopupType.CloneRepository,
            initialURL: null,
          }),
      },
      {
        label: __DARWIN__ ? 'Create New Repository…' : 'Create new repository…',
        action: () =>
          dispatcher.showPopup({ type: PopupType.CreateRepository }),
      },
      {
        label: __DARWIN__
          ? 'Add Existing Repository…'
          : 'Add existing repository…',
        action: () => dispatcher.showPopup({ type: PopupType.AddRepository }),
      },
      { type: 'separator' },
      { label: 'New group…', action: this.onNewGroupClick },
      { type: 'separator' },
      {
        label: __DARWIN__ ? 'Import Repositories…' : 'Import repositories…',
        action: this.onImportClick,
      },
      {
        label: __DARWIN__ ? 'Export Repositories…' : 'Export repositories…',
        action: this.onExportClick,
        enabled: this.props.repositories.length > 0,
      },
      {
        label: __DARWIN__
          ? 'Move All Repository Folders…'
          : 'Move all repository folders…',
        action: () => this.showMoveRepositories(this.props.repositories),
        enabled: this.props.repositories.some(
          r => r instanceof Repository && !r.missing
        ),
      },
    ]

    showContextualMenu(items)
  }

  /* -------------------------------- rendering ----------------------------- */

  private renderRepositoryRow = (repository: Repositoryish) => {
    const repoState = this.props.localRepositoryStateLookup.get(repository.id)
    const { selectedRepository } = this.props

    return (
      <RepositoriesSidebarRow
        key={repository.id}
        repository={repository}
        selected={
          selectedRepository !== null && selectedRepository.id === repository.id
        }
        aheadBehind={repoState?.aheadBehind ?? null}
        changedFilesCount={repoState?.changedFilesCount ?? 0}
        pipeline={this.state.pipelineStatuses.get(repository.id)}
        playingJobIds={this.state.playingJobIds}
        isDragging={this.state.draggedRepositoryId === repository.id}
        onClick={this.onItemClick}
        onContextMenu={this.onItemContextMenu}
        onDragStart={this.onDragStart}
        onDragEnd={this.onDragEnd}
        onPlayJob={this.onPlayJob}
        onOpenUrl={this.onOpenUrl}
      />
    )
  }

  private renderGroupSection = (section: IGroupSection) => {
    const isFiltering = this.state.filterText.trim().length > 0
    const isCollapsed =
      !isFiltering && this.state.collapsedGroupIds.has(section.id)
    const isDragOver = this.state.dragOverGroupId === section.id

    const style: React.CSSProperties | undefined =
      section.color !== undefined
        ? ({
            '--group-color': section.color,
            '--group-tint': hexToRgba(section.color, 0.08),
          } as React.CSSProperties)
        : undefined

    return (
      <div
        key={section.id}
        data-group-id={section.id}
        className={classNames('repositories-sidebar-group', {
          'drag-over': isDragOver,
          colored: section.color !== undefined,
          collapsed: isCollapsed,
        })}
        style={style}
        onDragOver={this.onGroupDragOver}
        onDragLeave={this.onGroupDragLeave}
        onDrop={this.onGroupDrop}
      >
        <div
          className="repositories-sidebar-group-header"
          data-group-id={section.id}
          role="button"
          tabIndex={0}
          aria-expanded={!isCollapsed}
          onClick={this.onToggleGroupCollapsed}
          onKeyDown={this.onGroupHeaderKeyDown}
          onContextMenu={this.onGroupHeaderContextMenu}
        >
          <Octicon
            symbol={isCollapsed ? octicons.chevronRight : octicons.chevronDown}
            className="collapse-icon"
          />
          {section.color !== undefined && <span className="group-swatch" />}
          <span className="name">{section.name}</span>
          <span className="count">{section.repositories.length}</span>
        </div>

        {!isCollapsed && (
          <div className="repositories-sidebar-group-items">
            {section.repositories.length === 0 ? (
              <div className="no-repositories">Drag repositories here</div>
            ) : (
              section.repositories.map(this.renderRepositoryRow)
            )}
          </div>
        )}
      </div>
    )
  }

  private renderGitLabAuthError() {
    const { gitLabRateLimitedUntil } = this.state
    if (
      this.state.gitLabAuthError === null &&
      gitLabRateLimitedUntil !== null &&
      gitLabRateLimitedUntil > Date.now()
    ) {
      const time = new Date(gitLabRateLimitedUntil).toLocaleTimeString(
        undefined,
        { hour: '2-digit', minute: '2-digit' }
      )
      return (
        <div className="repositories-sidebar-warning" role="status">
          <Octicon symbol={octicons.clock} />
          <span>
            GitLab rate limit reached — pipeline updates resume at {time}
          </span>
        </div>
      )
    }

    if (this.state.gitLabAuthError === null) {
      return null
    }

    return (
      <button
        type="button"
        className="repositories-sidebar-warning"
        onClick={this.onOpenGitLabPreferences}
        title={this.state.gitLabAuthError}
      >
        <Octicon symbol={octicons.alert} />
        <span>GitLab token rejected — fix in Preferences</span>
      </button>
    )
  }

  private renderExpandedContent() {
    const { filterText } = this.state
    const sections = this.getSections(
      this.props.repositories,
      this.state.customGroups,
      this.state.repositoryGroups,
      filterText
    )

    return (
      <div className="repositories-sidebar-inner">
        <div className="repositories-sidebar-header">
          <span className="title">
            Repositories
            <span className="total">{this.props.repositories.length}</span>
          </span>
          <Button
            className="sidebar-icon-button add-repository-button"
            onClick={this.onAddRepositoryClick}
            tooltip="Add, import or export repositories"
            ariaLabel="Add, import or export repositories"
          >
            <Octicon symbol={octicons.plus} />
          </Button>
          <Button
            className="sidebar-icon-button collapse-sidebar-button"
            onClick={this.onToggleSidebarCollapsed}
            tooltip="Hide sidebar"
            ariaLabel="Collapse repositories sidebar"
          >
            <Octicon symbol={octicons.sidebarExpand} />
          </Button>
        </div>

        <div className="repositories-sidebar-filter">
          <Octicon symbol={octicons.search} className="search-icon" />
          <input
            ref={this.filterInputRef}
            type="search"
            placeholder="Filter"
            aria-label="Filter repositories"
            value={filterText}
            onChange={this.onFilterChanged}
            onKeyDown={this.onFilterKeyDown}
            spellCheck={false}
          />
          {filterText.length > 0 && (
            <button
              type="button"
              className="clear-filter"
              onClick={this.onClearFilter}
              aria-label="Clear filter"
            >
              <Octicon symbol={octicons.x} />
            </button>
          )}
        </div>

        {this.renderGitLabAuthError()}

        <div className="repositories-sidebar-groups">
          {sections.length === 0 ? (
            <div className="repositories-sidebar-empty">
              No repositories match “{filterText}”
            </div>
          ) : (
            sections.map(this.renderGroupSection)
          )}
        </div>

        {this.state.notice !== null && (
          <div
            className={classNames('repositories-sidebar-notice', {
              error: this.state.notice.isError,
            })}
            role="status"
          >
            {this.state.notice.text}
          </div>
        )}
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
            title="Show repositories sidebar"
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
