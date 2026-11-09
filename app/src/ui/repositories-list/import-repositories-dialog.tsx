import * as React from 'react'
import classNames from 'classnames'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { TextBox } from '../lib/text-box'
import { Button } from '../lib/button'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { showOpenDialog } from '../main-process-proxy'
import {
  IImportPlanEntry,
  IRepositoryExportFile,
  ImportAction,
  getCommonRoot,
  planImport,
} from '../../lib/repository-import-export'
import {
  findOrCreateGroupByName,
  setGroupCollapsed,
  setRepositoryGroups,
} from './custom-repository-groups-store'

interface IImportRepositoriesDialogProps {
  readonly dispatcher: Dispatcher
  readonly data: IRepositoryExportFile
  /** Path of the file being imported, shown for reference. */
  readonly fileName: string
  readonly existingRepositories: ReadonlyArray<Repository>
  readonly onDismissed: () => void
}

type EntryProgress = 'waiting' | 'working' | 'done' | 'failed' | 'skipped'

interface IImportRepositoriesDialogState {
  /** Where repositories should go on this machine (replaces `oldRoot`). */
  readonly newRoot: string
  readonly plan: ReadonlyArray<IImportPlanEntry> | null
  /** Indexes into `plan` the user wants imported. */
  readonly selected: ReadonlySet<number>
  readonly phase: 'planning' | 'ready' | 'importing' | 'done'
  readonly progress: ReadonlyMap<number, EntryProgress>
}

const ActionLabels: Record<ImportAction, string> = {
  'already-added': 'Already added',
  add: 'Add from disk',
  clone: 'Clone',
  unavailable: 'Not found, no remote',
}

/**
 * Lets the user review an exported list of repositories, choose where they
 * should live on this machine, and then add the ones already on disk and
 * clone the rest — restoring groups, group colors and aliases as it goes.
 */
export class ImportRepositoriesDialog extends React.Component<
  IImportRepositoriesDialogProps,
  IImportRepositoriesDialogState
> {
  private readonly oldRoot = getCommonRoot(
    this.props.data.repositories.map(r => r.path)
  )
  private planVersion = 0
  private planTimer: number | null = null
  private unmounted = false
  private readonly toggleHandlers = new Map<number, () => void>()

  public constructor(props: IImportRepositoriesDialogProps) {
    super(props)

    this.state = {
      newRoot: this.oldRoot ?? '',
      plan: null,
      selected: new Set(),
      phase: 'planning',
      progress: new Map(),
    }
  }

  public componentDidMount() {
    this.updatePlan(this.state.newRoot)
  }

  public componentWillUnmount() {
    this.unmounted = true
    if (this.planTimer !== null) {
      window.clearTimeout(this.planTimer)
    }
  }

  private async updatePlan(newRoot: string) {
    const version = ++this.planVersion
    const plan = await planImport(
      this.props.data,
      this.oldRoot,
      newRoot.trim().length > 0 ? newRoot.trim() : null,
      this.props.existingRepositories
    )

    if (this.unmounted || version !== this.planVersion) {
      return
    }

    // Select everything that can actually be imported.
    const selected = new Set<number>()
    plan.forEach((entry, i) => {
      if (entry.action !== 'unavailable') {
        selected.add(i)
      }
    })

    this.setState({ plan, selected, phase: 'ready' })
  }

  private onNewRootChanged = (newRoot: string) => {
    this.setState({ newRoot, phase: 'planning' })

    // Debounce: each plan checks the disk for every repository.
    if (this.planTimer !== null) {
      window.clearTimeout(this.planTimer)
    }
    this.planTimer = window.setTimeout(() => {
      this.planTimer = null
      this.updatePlan(newRoot)
    }, 300)
  }

  private onChooseRoot = async () => {
    const path = await showOpenDialog({
      properties: ['createDirectory', 'openDirectory'],
      defaultPath: this.state.newRoot || undefined,
    })

    if (path !== null) {
      this.onNewRootChanged(path)
    }
  }

  private onToggleEntry = (index: number) => {
    const selected = new Set(this.state.selected)
    if (selected.has(index)) {
      selected.delete(index)
    } else {
      selected.add(index)
    }
    this.setState({ selected })
  }

  private getToggleHandler(index: number) {
    let handler = this.toggleHandlers.get(index)
    if (handler === undefined) {
      handler = () => this.onToggleEntry(index)
      this.toggleHandlers.set(index, handler)
    }
    return handler
  }

  private onToggleAll = () => {
    const { plan, selected } = this.state
    if (plan === null) {
      return
    }

    const importable = plan
      .map((entry, i) => (entry.action !== 'unavailable' ? i : -1))
      .filter(i => i !== -1)
    const allSelected = importable.every(i => selected.has(i))
    this.setState({ selected: new Set(allSelected ? [] : importable) })
  }

  private setProgress(index: number, progress: EntryProgress) {
    if (this.unmounted) {
      return
    }
    this.setState(prev => {
      const map = new Map(prev.progress)
      map.set(index, progress)
      return { progress: map }
    })
  }

  private onSubmit = async () => {
    const { plan, selected, phase } = this.state
    if (phase === 'done') {
      this.props.onDismissed()
      return
    }

    if (plan === null || phase !== 'ready' || selected.size === 0) {
      return
    }

    this.setState({ phase: 'importing' })
    const { dispatcher, data } = this.props

    // Recreate groups first (reusing groups that already exist by name).
    const groupIds = new Map<string, string>()
    for (const group of data.groups) {
      const created = findOrCreateGroupByName(group.name, group.color)
      groupIds.set(group.key, created.id)
      if (group.collapsed) {
        setGroupCollapsed(created.id, true)
      }
    }

    const assignments: Array<{ repositoryId: number; groupId: string | null }> =
      []

    const indexes = [...selected].sort((a, b) => a - b)
    for (const index of indexes) {
      const entry = plan[index]
      this.setProgress(index, 'working')

      try {
        let repository: Repository | null = null

        if (entry.action === 'already-added') {
          repository = entry.existing
        } else if (entry.action === 'add') {
          const added = await dispatcher.addRepositories([entry.targetPath])
          repository = added.length > 0 ? added[0] : null
        } else if (entry.action === 'clone' && entry.cloneUrl !== null) {
          repository = await dispatcher.cloneInBackground(
            entry.cloneUrl,
            entry.targetPath
          )
        }

        if (repository === null) {
          this.setProgress(index, 'failed')
          continue
        }

        if (entry.source.alias !== null && repository.alias === null) {
          await dispatcher.changeRepositoryAlias(repository, entry.source.alias)
        }

        const groupId =
          entry.source.group !== null
            ? groupIds.get(entry.source.group) ?? null
            : null
        if (groupId !== null) {
          assignments.push({ repositoryId: repository.id, groupId })
        }

        this.setProgress(index, 'done')
      } catch (e) {
        log.error(`[Import] failed to import '${entry.targetPath}'`, e)
        this.setProgress(index, 'failed')
      }
    }

    setRepositoryGroups(assignments)

    if (!this.unmounted) {
      this.setState({ phase: 'done' })
    }
  }

  private renderEntry = (entry: IImportPlanEntry, index: number) => {
    const { selected, progress, phase } = this.state
    const isUnavailable = entry.action === 'unavailable'
    const state = progress.get(index)
    const displayName = entry.source.alias ?? entry.source.name
    const group =
      entry.source.group !== null
        ? this.props.data.groups.find(g => g.key === entry.source.group)
        : undefined

    return (
      <li
        key={index}
        className={classNames('import-repository-entry', {
          unavailable: isUnavailable,
        })}
      >
        <Checkbox
          value={selected.has(index) ? CheckboxValue.On : CheckboxValue.Off}
          disabled={isUnavailable || phase !== 'ready'}
          onChange={this.getToggleHandler(index)}
          ariaLabelledBy={`import-entry-${index}`}
        />
        <div className="details" id={`import-entry-${index}`}>
          <div className="title">
            {group?.color !== undefined && (
              <span
                className="group-swatch"
                style={{ backgroundColor: group.color }}
              />
            )}
            <span className="name">{displayName}</span>
            {group !== undefined && (
              <span className="group-name">{group.name}</span>
            )}
          </div>
          <div className="path">{entry.targetPath}</div>
        </div>
        <div className={`action action-${state ?? entry.action}`}>
          {this.renderEntryStatus(entry, state)}
        </div>
      </li>
    )
  }

  private renderEntryStatus(
    entry: IImportPlanEntry,
    state: EntryProgress | undefined
  ) {
    switch (state) {
      case 'working':
        return (
          <>
            <Octicon symbol={octicons.sync} className="spin" />
            {entry.action === 'clone' ? 'Cloning…' : 'Adding…'}
          </>
        )
      case 'done':
        return (
          <>
            <Octicon symbol={octicons.check} />
            Done
          </>
        )
      case 'failed':
        return (
          <>
            <Octicon symbol={octicons.x} />
            Failed
          </>
        )
      default:
        return ActionLabels[entry.action]
    }
  }

  private renderSummary() {
    const { plan, selected } = this.state
    if (plan === null) {
      return null
    }

    const counts = { add: 0, clone: 0, existing: 0 }
    for (const index of selected) {
      const action = plan[index].action
      if (action === 'add') {
        counts.add++
      } else if (action === 'clone') {
        counts.clone++
      } else if (action === 'already-added') {
        counts.existing++
      }
    }

    const parts = []
    if (counts.add > 0) {
      parts.push(`${counts.add} to add`)
    }
    if (counts.clone > 0) {
      parts.push(`${counts.clone} to clone`)
    }
    if (counts.existing > 0) {
      parts.push(`${counts.existing} already added (groups updated)`)
    }

    return (
      <p className="import-summary">
        {parts.length > 0 ? parts.join(' · ') : 'Nothing selected'}
      </p>
    )
  }

  public render() {
    const { data, fileName } = this.props
    const { plan, phase, selected, newRoot } = this.state
    const exportedAt =
      data.exportedAt.length > 0
        ? new Date(data.exportedAt).toLocaleString()
        : 'an unknown date'
    const importable = plan?.filter(e => e.action !== 'unavailable').length ?? 0

    return (
      <Dialog
        id="import-repositories"
        title={__DARWIN__ ? 'Import Repositories' : 'Import repositories'}
        onDismissed={this.props.onDismissed}
        onSubmit={this.onSubmit}
        dismissDisabled={phase === 'importing'}
        loading={phase === 'importing'}
      >
        <DialogContent>
          <p className="import-source">
            {data.repositories.length} repositories and {data.groups.length}{' '}
            groups from <strong>{fileName}</strong>, exported {exportedAt}.
          </p>

          <div className="import-root">
            <TextBox
              label="Location for repositories on this computer"
              value={newRoot}
              onValueChanged={this.onNewRootChanged}
              disabled={phase === 'importing' || phase === 'done'}
              placeholder="Keep original paths"
            />
            <Button
              onClick={this.onChooseRoot}
              disabled={phase === 'importing' || phase === 'done'}
            >
              Choose…
            </Button>
          </div>
          {this.oldRoot !== null && (
            <p className="import-hint">
              Originally under <code>{this.oldRoot}</code>. Folder structure
              below it is kept.
            </p>
          )}

          <div className="import-list-header">
            <Checkbox
              label="Select all"
              value={
                importable > 0 && selected.size === importable
                  ? CheckboxValue.On
                  : selected.size === 0
                  ? CheckboxValue.Off
                  : CheckboxValue.Mixed
              }
              disabled={phase !== 'ready' || importable === 0}
              onChange={this.onToggleAll}
            />
            {this.renderSummary()}
          </div>

          {plan === null ? (
            <div className="import-planning">Checking repositories…</div>
          ) : (
            <ul
              className={classNames('import-repository-list', {
                stale: phase === 'planning',
              })}
            >
              {plan.map(this.renderEntry)}
            </ul>
          )}
        </DialogContent>

        <DialogFooter>
          {phase === 'done' ? (
            <OkCancelButtonGroup
              okButtonText="Close"
              cancelButtonVisible={false}
            />
          ) : (
            <OkCancelButtonGroup
              okButtonText={
                selected.size > 0
                  ? `Import ${selected.size} ${
                      selected.size === 1 ? 'repository' : 'repositories'
                    }`
                  : 'Import'
              }
              okButtonDisabled={phase !== 'ready' || selected.size === 0}
            />
          )}
        </DialogFooter>
      </Dialog>
    )
  }
}
