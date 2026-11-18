import * as React from 'react'
import memoizeOne from 'memoize-one'
import classNames from 'classnames'
import { Dialog, DialogContent } from '../dialog'
import { TextBox } from '../lib/text-box'
import { HighlightText } from '../lib/highlight-text'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { Branch } from '../../models/branch'
import {
  IQuickSwitcherMatch,
  QuickSwitcherItem,
  buildQuickSwitcherItems,
  filterQuickSwitcherItems,
} from '../../lib/quick-switcher'
import {
  getCustomGroups,
  getRepositoryGroupAssignments,
} from '../repositories-list/custom-repository-groups-store'
import { Repositoryish } from '../repositories-list/group-repositories'
import { formatAccelerator } from '../../models/shortcuts'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import {
  getQuickSwitcherRepositoriesOnly,
  setQuickSwitcherRepositoriesOnly,
} from '../../lib/shortcut-settings'

interface IQuickSwitcherProps {
  readonly dispatcher: Dispatcher
  readonly repositories: ReadonlyArray<Repositoryish>
  readonly recentRepositories: ReadonlyArray<number>
  /** The repository you're in, whose branches are offered. */
  readonly repository: Repository | null
  readonly branches: ReadonlyArray<Branch>
  readonly currentBranch: Branch | null
  readonly recentBranches: ReadonlyArray<Branch>
  /** The switcher's shortcut, shown as a hint; null when it has none. */
  readonly accelerator: string | null
  readonly onDismissed: () => void
}

interface IQuickSwitcherState {
  readonly query: string
  readonly selectedIndex: number
  /** Only list repositories (remembered between uses). */
  readonly repositoriesOnly: boolean
}

const ListId = 'quick-switcher-results'

/**
 * Jump to another repository, or check out a branch of this one, by typing
 * part of its name.
 */
export class QuickSwitcher extends React.Component<
  IQuickSwitcherProps,
  IQuickSwitcherState
> {
  private listRef = React.createRef<HTMLUListElement>()
  private inputRef = React.createRef<TextBox>()

  private getItems = memoizeOne(
    (
      repositories: ReadonlyArray<Repositoryish>,
      recentRepositories: ReadonlyArray<number>,
      repository: Repository | null,
      branches: ReadonlyArray<Branch>,
      currentBranch: Branch | null,
      recentBranches: ReadonlyArray<Branch>,
      repositoriesOnly: boolean
    ) => {
      const groups = new Map(
        getCustomGroups().map(g => [g.id, { name: g.name, color: g.color }])
      )
      return buildQuickSwitcherItems({
        repositories: repositories.filter(
          (r): r is Repository => r instanceof Repository
        ),
        currentRepository: repository,
        groups,
        assignments: getRepositoryGroupAssignments(),
        recentRepositoryIds: recentRepositories,
        branches,
        currentBranch,
        recentBranchNames: recentBranches.map(b => b.name),
        repositoriesOnly,
      })
    }
  )

  private getMatches = memoizeOne(
    (items: ReadonlyArray<QuickSwitcherItem>, query: string) =>
      filterQuickSwitcherItems(items, query)
  )

  public constructor(props: IQuickSwitcherProps) {
    super(props)
    this.state = {
      query: '',
      selectedIndex: 0,
      repositoriesOnly: getQuickSwitcherRepositoriesOnly(),
    }
  }

  private get matches(): ReadonlyArray<IQuickSwitcherMatch> {
    const p = this.props
    const items = this.getItems(
      p.repositories,
      p.recentRepositories,
      p.repository,
      p.branches,
      p.currentBranch,
      p.recentBranches,
      this.state.repositoriesOnly
    )
    return this.getMatches(items, this.state.query)
  }

  public componentDidUpdate(
    prevProps: IQuickSwitcherProps,
    prevState: IQuickSwitcherState
  ) {
    if (prevState.selectedIndex !== this.state.selectedIndex) {
      this.listRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    }
  }

  private onRepositoriesOnlyChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const repositoriesOnly = event.currentTarget.checked
    setQuickSwitcherRepositoriesOnly(repositoriesOnly)
    this.setState({ repositoriesOnly, selectedIndex: 0 })
    // Carry on typing.
    this.inputRef.current?.focus()
  }

  private onQueryChanged = (query: string) => {
    this.setState({ query, selectedIndex: 0 })
  }

  private onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = this.matches.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (count === 0) {
        return
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1
      this.setState(s => ({
        selectedIndex: (s.selectedIndex + delta + count) % count,
      }))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const match = this.matches[this.state.selectedIndex]
      if (match !== undefined) {
        this.open(match.item)
      }
    }
  }

  private onItemClick = (event: React.MouseEvent<HTMLLIElement>) => {
    const index = Number(event.currentTarget.dataset.index)
    const match = this.matches[index]
    if (match !== undefined) {
      this.open(match.item)
    }
  }

  private onItemMouseMove = (event: React.MouseEvent<HTMLLIElement>) => {
    const index = Number(event.currentTarget.dataset.index)
    if (index !== this.state.selectedIndex) {
      this.setState({ selectedIndex: index })
    }
  }

  private open(item: QuickSwitcherItem) {
    const { dispatcher, repository } = this.props
    this.props.onDismissed()
    if (item.kind === 'repository') {
      dispatcher.selectRepository(item.repository)
    } else if (repository !== null) {
      dispatcher.checkoutBranch(repository, item.branch)
    }
  }

  private renderItem = (match: IQuickSwitcherMatch, index: number) => {
    const { item, matches } = match
    const selected = index === this.state.selectedIndex
    const isRepository = item.kind === 'repository'
    const style =
      isRepository && item.color !== undefined
        ? ({ '--group-color': item.color } as React.CSSProperties)
        : undefined

    // Keyboard selection happens in the filter box (ArrowUp/Down, Enter), so
    // the options only need to handle the mouse.
    return (
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events
      <li
        key={item.id}
        id={`quick-switcher-item-${index}`}
        role="option"
        aria-selected={selected}
        data-index={index}
        className={classNames('quick-switcher-item', {
          selected,
          'has-color': style !== undefined,
        })}
        style={style}
        onClick={this.onItemClick}
        onMouseMove={this.onItemMouseMove}
      >
        <Octicon
          className="icon"
          symbol={isRepository ? octicons.repo : octicons.gitBranch}
        />
        <span className="title">
          <HighlightText text={item.title} highlight={matches.title} />
        </span>
        {item.subtitle !== '' && (
          <span className="subtitle">
            <HighlightText text={item.subtitle} highlight={matches.subtitle} />
          </span>
        )}
        <span className="kind">
          {isRepository
            ? 'Repository'
            : item.subtitle !== ''
            ? 'Remote branch'
            : 'Branch'}
        </span>
      </li>
    )
  }

  public render() {
    const matches = this.matches
    const { accelerator, repository } = this.props
    const { repositoriesOnly } = this.state
    const what = repositoriesOnly ? 'repositories' : 'repositories or branches'
    const hint =
      accelerator === null
        ? null
        : formatAccelerator(accelerator, __DARWIN__).replace(/\+/g, ' + ')

    return (
      <Dialog
        id="quick-switcher"
        title={__DARWIN__ ? 'Quick Switcher' : 'Quick switcher'}
        onDismissed={this.props.onDismissed}
      >
        <DialogContent>
          <TextBox
            ref={this.inputRef}
            className="quick-switcher-input"
            placeholder={
              repository === null || repositoriesOnly
                ? 'Repository name'
                : `Repository, or branch of ${
                    repository.alias ?? repository.name
                  }`
            }
            ariaLabel={repositoriesOnly ? 'Repository' : 'Repository or branch'}
            ariaControls={ListId}
            prefixedIcon={octicons.search}
            value={this.state.query}
            onValueChanged={this.onQueryChanged}
            onKeyDown={this.onKeyDown}
            autoFocus={true}
            spellcheck={false}
          />
          {matches.length === 0 ? (
            <p className="quick-switcher-empty">
              No {what} match “{this.state.query.trim()}”.
            </p>
          ) : (
            <ul
              id={ListId}
              ref={this.listRef}
              className="quick-switcher-results"
              role="listbox"
              aria-label={
                repositoriesOnly ? 'Repositories' : 'Repositories and branches'
              }
            >
              {matches.map(this.renderItem)}
            </ul>
          )}
          <Checkbox
            className="quick-switcher-repositories-only"
            label="Repositories only"
            value={repositoriesOnly ? CheckboxValue.On : CheckboxValue.Off}
            onChange={this.onRepositoriesOnlyChanged}
          />
          <p className="quick-switcher-hint">
            ↑ ↓ to choose, Enter to open. Change the shortcut
            {hint !== null && <> ({hint})</>} in{' '}
            {__DARWIN__ ? 'Settings' : 'Options'} → Shortcuts.
          </p>
        </DialogContent>
      </Dialog>
    )
  }
}
