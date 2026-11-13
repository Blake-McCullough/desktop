import * as React from 'react'
import memoizeOne from 'memoize-one'
import { DialogContent } from '../dialog'
import { TextBox } from '../lib/text-box'
import { Row } from '../lib/row'
import { Button } from '../lib/button'
import { Select } from '../lib/select'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { LinkButton } from '../lib/link-button'
import { CallToAction } from '../lib/call-to-action'
import { Ref } from '../lib/ref'
import { HighlightText } from '../lib/highlight-text'
import { TooltippedContent } from '../lib/tooltipped-content'
import { SectionFilterList } from '../lib/section-filter-list'
import { IFilterListGroup, IFilterListItem } from '../lib/filter-list'
import { ClickSource } from '../lib/list'
import { IMatches } from '../../lib/fuzzy-find'
import { Octicon, OcticonSymbol, syncClockwise } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import {
  fetchGitLabProjects,
  GitLabApiError,
  IGitLabCloneableProject,
  IGitLabProjectList,
} from '../../lib/gitlab/gitlab-api'
import {
  getGitLabToken,
  onGitLabSettingsChanged,
} from '../../lib/gitlab/gitlab-token'
import {
  getCloneableGitLabInstances,
  getInitialGitLabInstance,
  groupGitLabProjects,
  IGitLabProjectGroup,
  setLastGitLabInstance,
} from '../../lib/gitlab/gitlab-clone'
import { Disposable } from 'event-kit'

/** What the GitLab tab reports when a project is picked. */
export interface IGitLabCloneSelection {
  readonly project: IGitLabCloneableProject
  /** The instance the project was listed from. */
  readonly instanceUrl: string
  /** The user the GitLab token belongs to on that instance. */
  readonly username: string
}

interface ICloneGitLabRepositoryProps {
  readonly path: string
  readonly onPathChanged: (path: string) => void
  readonly onChooseDirectory: () => Promise<string | undefined>

  readonly selection: IGitLabCloneSelection | null
  readonly onSelectionChanged: (selection: IGitLabCloneSelection | null) => void

  /** Called on Enter or double click on a project. */
  readonly onProjectActivated: () => void

  readonly filterText: string
  readonly onFilterTextChanged: (filterText: string) => void

  readonly useSsh: boolean
  readonly onUseSshChanged: (useSsh: boolean) => void

  readonly addToSidebarGroup: boolean
  readonly onAddToSidebarGroupChanged: (add: boolean) => void
  readonly sidebarGroupName: string
  readonly onSidebarGroupNameChanged: (name: string) => void

  readonly onOpenGitLabPreferences: () => void
}

interface ICloneGitLabRepositoryState {
  readonly instances: ReadonlyArray<string>
  readonly instanceUrl: string
  /** Undefined while we don't know yet whether a token is configured. */
  readonly hasToken: boolean | undefined
  readonly list: IGitLabProjectList | null
  readonly loading: boolean
  readonly error: string | null
}

interface IGitLabProjectListItem extends IFilterListItem {
  readonly id: string
  /** [name, path with namespace] — both are searched. */
  readonly text: ReadonlyArray<string>
  readonly project: IGitLabCloneableProject
}

const RowHeight = 31

function getIcon(project: IGitLabCloneableProject): OcticonSymbol {
  if (project.archived) {
    return octicons.archive
  }
  if (project.visibility !== null && project.visibility !== 'public') {
    return octicons.lock
  }
  return project.isFork ? octicons.repoForked : octicons.repo
}

function hostLabel(url: string) {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}

/**
 * The GitLab tab of the Clone dialog: lists every project the configured
 * GitLab token can see, grouped by GitLab group and subgroup.
 */
export class CloneGitLabRepository extends React.PureComponent<
  ICloneGitLabRepositoryProps,
  ICloneGitLabRepositoryState
> {
  private mounted = false
  private settingsSubscription: Disposable | null = null
  /** Ignore responses for an instance the user has since switched away from. */
  private requestId = 0

  private getGroups = memoizeOne((list: IGitLabProjectList | null) =>
    list === null ? [] : groupGitLabProjects(list.projects, list.username)
  )

  private getListGroups = memoizeOne(
    (
      groups: ReadonlyArray<IGitLabProjectGroup>
    ): ReadonlyArray<IFilterListGroup<IGitLabProjectListItem>> =>
      groups.map(g => ({
        identifier: g.fullPath,
        items: g.projects.map(project => ({
          id: `${project.id}`,
          text: [project.name, project.pathWithNamespace],
          project,
        })),
      }))
  )

  private getGroupByPath = memoizeOne(
    (groups: ReadonlyArray<IGitLabProjectGroup>) =>
      new Map(groups.map(g => [g.fullPath, g]))
  )

  private getSelectedListItem = memoizeOne(
    (
      groups: ReadonlyArray<IFilterListGroup<IGitLabProjectListItem>>,
      selection: IGitLabCloneSelection | null,
      instanceUrl: string
    ) => {
      if (selection === null || selection.instanceUrl !== instanceUrl) {
        return null
      }
      for (const group of groups) {
        for (const item of group.items) {
          if (item.project.id === selection.project.id) {
            return item
          }
        }
      }
      return null
    }
  )

  public constructor(props: ICloneGitLabRepositoryProps) {
    super(props)
    const instances = getCloneableGitLabInstances()
    this.state = {
      instances,
      instanceUrl:
        props.selection?.instanceUrl ?? getInitialGitLabInstance(instances),
      hasToken: undefined,
      list: null,
      loading: false,
      error: null,
    }
  }

  public componentDidMount() {
    this.mounted = true
    this.settingsSubscription = onGitLabSettingsChanged(this.onSettingsChanged)
    this.load(false)
  }

  public componentWillUnmount() {
    this.mounted = false
    this.settingsSubscription?.dispose()
    this.settingsSubscription = null
  }

  private onSettingsChanged = () => {
    const instances = getCloneableGitLabInstances()
    const instanceUrl = instances.includes(this.state.instanceUrl)
      ? this.state.instanceUrl
      : getInitialGitLabInstance(instances)
    this.setState({ instances, instanceUrl }, () => this.load(true))
  }

  private async load(refresh: boolean) {
    const id = ++this.requestId
    const { instanceUrl } = this.state
    const token = await getGitLabToken()
    if (!this.mounted || id !== this.requestId) {
      return
    }

    if (token === null) {
      this.setState({ hasToken: false, list: null, loading: false })
      return
    }

    this.setState({ hasToken: true, loading: true, error: null })
    try {
      const list = await fetchGitLabProjects(instanceUrl, token, refresh)
      if (this.mounted && id === this.requestId) {
        this.setState({ list, loading: false })
      }
    } catch (e) {
      if (!this.mounted || id !== this.requestId) {
        return
      }
      let error = e instanceof Error ? e.message : `${e}`
      if (e instanceof GitLabApiError && e.status === 401) {
        error = `Your GitLab token was rejected by ${hostLabel(
          instanceUrl
        )}. It may have expired, or be for another instance.`
      }
      this.setState({ list: null, loading: false, error })
    }
  }

  private onRefresh = () => this.load(true)

  private onInstanceChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const instanceUrl = event.currentTarget.value
    setLastGitLabInstance(instanceUrl)
    this.props.onSelectionChanged(null)
    this.props.onFilterTextChanged('')
    this.setState({ instanceUrl, list: null }, () => this.load(false))
  }

  private onProtocolChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    this.props.onUseSshChanged(event.currentTarget.value === 'ssh')
  }

  private onAddToGroupChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.props.onAddToSidebarGroupChanged(event.currentTarget.checked)
  }

  private toSelection(
    item: IGitLabProjectListItem | null
  ): IGitLabCloneSelection | null {
    return item === null
      ? null
      : {
          project: item.project,
          instanceUrl: this.state.instanceUrl,
          username: this.state.list?.username ?? '',
        }
  }

  private onListSelectionChanged = (item: IGitLabProjectListItem | null) => {
    this.props.onSelectionChanged(this.toSelection(item))
  }

  private onItemClick = (item: IGitLabProjectListItem, source: ClickSource) => {
    if (source.kind === 'keyboard' && source.event.key === 'Enter') {
      this.props.onSelectionChanged(this.toSelection(item))
      this.props.onProjectActivated()
    }
  }

  public render() {
    if (this.state.hasToken === false) {
      return (
        <DialogContent className="clone-gitlab-repository-content">
          {this.renderNoToken()}
        </DialogContent>
      )
    }

    return (
      <DialogContent className="clone-github-repository-content clone-gitlab-repository-content">
        {this.renderInstancePicker()}
        <Row>{this.renderList()}</Row>
        <Row className="local-path-field">
          <TextBox
            value={this.props.path}
            label={__DARWIN__ ? 'Local Path' : 'Local path'}
            placeholder="repository path"
            onValueChanged={this.props.onPathChanged}
          />
          <Button onClick={this.props.onChooseDirectory}>Choose…</Button>
        </Row>
        {this.renderOptions()}
      </DialogContent>
    )
  }

  private renderNoToken() {
    return (
      <CallToAction
        actionTitle={
          __DARWIN__ ? 'Open GitLab Settings' : 'Open GitLab settings'
        }
        onAction={this.props.onOpenGitLabPreferences}
      >
        <div>
          Add a GitLab personal access token (with the <Ref>read_api</Ref> or{' '}
          <Ref>api</Ref> scope) to browse and clone your GitLab projects.
        </div>
      </CallToAction>
    )
  }

  private renderInstancePicker() {
    const { instances, instanceUrl } = this.state
    if (instances.length < 2) {
      return null
    }
    return (
      <Row className="gitlab-instance-row">
        <Select
          label="GitLab instance"
          value={instanceUrl}
          onChange={this.onInstanceChanged}
        >
          {instances.map(url => (
            <option key={url} value={url}>
              {hostLabel(url)}
            </option>
          ))}
        </Select>
      </Row>
    )
  }

  private renderList() {
    const groups = this.getGroups(this.state.list)
    const listGroups = this.getListGroups(groups)
    const selectedItem = this.getSelectedListItem(
      listGroups,
      this.props.selection,
      this.state.instanceUrl
    )

    return (
      <SectionFilterList<IGitLabProjectListItem>
        className="clone-github-repo clone-gitlab-repo"
        rowHeight={RowHeight}
        selectedItem={selectedItem}
        renderItem={this.renderItem}
        renderGroupHeader={this.renderGroupHeader}
        onSelectionChanged={this.onListSelectionChanged}
        onItemClick={this.onItemClick}
        invalidationProps={listGroups}
        groups={listGroups}
        filterText={this.props.filterText}
        onFilterTextChanged={this.props.onFilterTextChanged}
        renderNoItems={this.renderNoItems}
        renderPostFilter={this.renderPostFilter}
        placeholderText="Filter your GitLab projects"
        getGroupAriaLabel={this.getGroupAriaLabel}
      />
    )
  }

  private getGroupLabel(fullPath: string) {
    const group = this.getGroupByPath(this.getGroups(this.state.list)).get(
      fullPath
    )
    if (group?.isPersonal) {
      return __DARWIN__ ? 'Your Projects' : 'Your projects'
    }
    return fullPath.length === 0 ? 'Other' : fullPath
  }

  private getGroupAriaLabel = (index: number) => {
    const groups = this.getGroups(this.state.list)
    const group = groups[index]
    return group === undefined ? undefined : this.getGroupLabel(group.fullPath)
  }

  private renderGroupHeader = (fullPath: string) => {
    const group = this.getGroupByPath(this.getGroups(this.state.list)).get(
      fullPath
    )
    const segments = fullPath.split('/')
    const isPersonal = group?.isPersonal === true

    return (
      <div className="clone-repository-list-content clone-repository-list-group-header gitlab-group-header">
        <Octicon
          className="icon"
          symbol={isPersonal ? octicons.person : octicons.organization}
        />
        {isPersonal ? (
          <span className="gitlab-group-name">
            {this.getGroupLabel(fullPath)}
          </span>
        ) : (
          <span className="gitlab-group-path">
            {segments.slice(0, -1).map((s, i) => (
              <span key={i} className="gitlab-group-parent">
                {s}
                <span className="gitlab-group-separator"> / </span>
              </span>
            ))}
            <span className="gitlab-group-name">{segments.at(-1)}</span>
          </span>
        )}
        <span className="gitlab-group-count">
          {group?.projects.length ?? 0}
        </span>
      </div>
    )
  }

  private renderItem = (item: IGitLabProjectListItem, matches: IMatches) => {
    const { project } = item
    return (
      <div className="clone-repository-list-item gitlab-project-item">
        <Octicon className="icon" symbol={getIcon(project)} />
        <TooltippedContent
          className="name"
          tooltip={project.pathWithNamespace}
          tagName="div"
        >
          <HighlightText text={project.name} highlight={matches.title} />
        </TooltippedContent>
        {project.archived && <div className="archived">Archived</div>}
      </div>
    )
  }

  private renderPostFilter = () => {
    const tooltip = 'Refresh the list of projects'
    return (
      <Button
        disabled={this.state.loading}
        onClick={this.onRefresh}
        ariaLabel={tooltip}
        tooltip={tooltip}
      >
        <Octicon
          symbol={syncClockwise}
          className={this.state.loading ? 'spin' : undefined}
        />
      </Button>
    )
  }

  private renderNoItems = () => {
    const { loading, list, error, instanceUrl } = this.state
    const host = hostLabel(instanceUrl)

    if (error !== null) {
      return (
        <div className="no-items gitlab-load-error">
          <div>{error}</div>
          <div>
            <LinkButton onClick={this.onRefresh}>Try again</LinkButton>
            {' · '}
            <LinkButton onClick={this.props.onOpenGitLabPreferences}>
              GitLab settings
            </LinkButton>
          </div>
        </div>
      )
    }

    if (loading || list === null) {
      return (
        <div className="no-items loading">{`Loading projects from ${host}…`}</div>
      )
    }

    if (this.props.filterText.length !== 0) {
      return (
        <div className="no-items no-results-found">
          <div>
            Sorry, I can't find any project matching{' '}
            <Ref>{this.props.filterText}</Ref>
          </div>
        </div>
      )
    }

    return (
      <div className="no-items empty-repository-list">
        <div>
          No projects found for <Ref>{list.username}</Ref> on {host}.{' '}
          <LinkButton onClick={this.onRefresh}>Refresh this list</LinkButton> if
          you've joined a project recently.
        </div>
      </div>
    )
  }

  private renderOptions() {
    const { useSsh, addToSidebarGroup, sidebarGroupName, selection } =
      this.props
    const truncated = this.state.list?.truncated === true

    return (
      <>
        <Row className="gitlab-clone-options">
          <Select
            label="Clone using"
            value={useSsh ? 'ssh' : 'https'}
            onChange={this.onProtocolChanged}
          >
            <option value="https">HTTPS (uses your GitLab token)</option>
            <option value="ssh">SSH</option>
          </Select>
        </Row>
        <Row className="gitlab-sidebar-group-row">
          <Checkbox
            label="Add to sidebar group"
            value={addToSidebarGroup ? CheckboxValue.On : CheckboxValue.Off}
            onChange={this.onAddToGroupChanged}
          />
          <TextBox
            className="gitlab-sidebar-group-name"
            ariaLabel="Sidebar group name"
            value={sidebarGroupName}
            placeholder={
              selection === null ? 'GitLab group' : 'Sidebar group name'
            }
            disabled={!addToSidebarGroup}
            onValueChanged={this.props.onSidebarGroupNameChanged}
          />
        </Row>
        {truncated && (
          <Row className="gitlab-truncated-note">
            Showing your 2,000 most recently active projects. Use the URL tab
            for others.
          </Row>
        )}
      </>
    )
  }
}
