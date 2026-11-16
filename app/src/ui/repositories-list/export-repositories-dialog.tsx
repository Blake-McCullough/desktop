import * as React from 'react'
import * as Path from 'path'
import { writeFile } from 'fs/promises'
import { Dialog, DialogContent, DialogFooter, DialogError } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { Select } from '../lib/select'
import { TextBox } from '../lib/text-box'
import { Repository } from '../../models/repository'
import { showSaveDialog } from '../main-process-proxy'
import {
  buildRepositoryCsv,
  buildRepositoryExport,
  getCommonRoot,
  IRepositoryExportOptions,
  writeRepositoryExport,
} from '../../lib/repository-import-export'
import {
  getCustomGroups,
  getRepositoryGroupAssignments,
  hexToRgba,
  OtherGroupId,
} from './custom-repository-groups-store'

type ExportFormat = 'json' | 'csv'

interface IExportRepositoriesDialogProps {
  readonly repositories: ReadonlyArray<Repository>
  /** Repositories ticked when the dialog opens; all of them if undefined. */
  readonly initialSelection?: ReadonlyArray<number>
  readonly onExported: (message: string) => void
  readonly onDismissed: () => void
}

interface IExportRepositoriesDialogState {
  readonly selected: ReadonlySet<number>
  readonly filterText: string
  readonly options: IRepositoryExportOptions
  readonly format: ExportFormat
  readonly isExporting: boolean
  readonly error: string | null
}

interface IListGroup {
  readonly id: string
  readonly name: string
  readonly color?: string
  readonly repositories: ReadonlyArray<Repository>
}

const OptionsKey = 'repositories-export/options'

const DefaultOptions: IRepositoryExportOptions & { format: ExportFormat } = {
  location: 'full',
  remotes: 'all',
  stripRemoteCredentials: true,
  groups: true,
  groupStyle: true,
  aliases: true,
  onlyUsedGroups: true,
  format: 'json',
}

/** The last choices made in this dialog. */
function loadSavedOptions() {
  try {
    const raw = JSON.parse(localStorage.getItem(OptionsKey) ?? '{}')
    const pick = <T,>(value: unknown, allowed: ReadonlyArray<T>, fallback: T) =>
      allowed.includes(value as T) ? (value as T) : fallback
    const bool = (value: unknown, fallback: boolean) =>
      typeof value === 'boolean' ? value : fallback
    return {
      location: pick(raw.location, ['full', 'relative'] as const, 'full'),
      remotes: pick(raw.remotes, ['all', 'origin', 'none'] as const, 'all'),
      stripRemoteCredentials: bool(raw.stripRemoteCredentials, true),
      groups: bool(raw.groups, true),
      groupStyle: bool(raw.groupStyle, true),
      aliases: bool(raw.aliases, true),
      onlyUsedGroups: true,
      format: pick(raw.format, ['json', 'csv'] as const, 'json'),
    }
  } catch {
    return DefaultOptions
  }
}

const matches = (repository: Repository, filter: string) => {
  const f = filter.trim().toLowerCase()
  return (
    f.length === 0 ||
    repository.name.toLowerCase().includes(f) ||
    (repository.alias ?? '').toLowerCase().includes(f) ||
    repository.path.toLowerCase().includes(f)
  )
}

/**
 * Export a chosen set of repositories with a chosen set of fields, as JSON
 * (which can be imported again) or CSV (for spreadsheets).
 */
export class ExportRepositoriesDialog extends React.Component<
  IExportRepositoriesDialogProps,
  IExportRepositoriesDialogState
> {
  private readonly groups: ReadonlyArray<IListGroup>
  private mounted = false
  private readonly groupToggles = new Map<
    string,
    (event: React.FormEvent<HTMLInputElement>) => void
  >()
  private readonly repositoryToggles = new Map<
    number,
    (event: React.FormEvent<HTMLInputElement>) => void
  >()

  public constructor(props: IExportRepositoriesDialogProps) {
    super(props)

    const assignments = getRepositoryGroupAssignments()
    const byName = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
    const sortRepos = (repos: ReadonlyArray<Repository>) =>
      [...repos].sort((a, b) => byName(a.alias ?? a.name, b.alias ?? b.name))

    const custom = [...getCustomGroups()]
      .sort((a, b) => byName(a.name, b.name))
      .map(g => ({
        id: g.id,
        name: g.name,
        color: g.color,
        repositories: sortRepos(
          props.repositories.filter(r => assignments.get(r.id) === g.id)
        ),
      }))
    const grouped = new Set(custom.flatMap(g => g.repositories.map(r => r.id)))
    const other = sortRepos(props.repositories.filter(r => !grouped.has(r.id)))

    this.groups = [
      ...custom,
      {
        id: OtherGroupId,
        name: custom.length > 0 ? 'Other' : 'All repositories',
        repositories: other,
      },
    ].filter(g => g.repositories.length > 0)

    const { format, ...options } = loadSavedOptions()
    this.state = {
      selected: new Set(
        props.initialSelection ?? props.repositories.map(r => r.id)
      ),
      filterText: '',
      options,
      format,
      isExporting: false,
      error: null,
    }
  }

  public componentDidMount() {
    this.mounted = true
  }

  public componentWillUnmount() {
    this.mounted = false
  }

  private setOptions(changes: Partial<IRepositoryExportOptions>) {
    this.setState(
      prev => ({ options: { ...prev.options, ...changes } }),
      this.saveOptions
    )
  }

  private saveOptions = () => {
    localStorage.setItem(
      OptionsKey,
      JSON.stringify({ ...this.state.options, format: this.state.format })
    )
  }

  private get selectedRepositories() {
    return this.props.repositories.filter(r => this.state.selected.has(r.id))
  }

  private setSelected(ids: ReadonlyArray<number>, on: boolean) {
    this.setState(prev => {
      const selected = new Set(prev.selected)
      for (const id of ids) {
        if (on) {
          selected.add(id)
        } else {
          selected.delete(id)
        }
      }
      return { selected }
    })
  }

  private visible(repositories: ReadonlyArray<Repository>) {
    return repositories.filter(r => matches(r, this.state.filterText))
  }

  private checkboxValue(repositories: ReadonlyArray<Repository>) {
    const count = repositories.filter(r => this.state.selected.has(r.id)).length
    return count === 0
      ? CheckboxValue.Off
      : count === repositories.length
      ? CheckboxValue.On
      : CheckboxValue.Mixed
  }

  private onToggleAll = () => {
    const visible = this.visible(this.props.repositories)
    this.setSelected(
      visible.map(r => r.id),
      this.checkboxValue(visible) !== CheckboxValue.On
    )
  }

  private getGroupToggle(group: IListGroup) {
    let handler = this.groupToggles.get(group.id)
    if (handler === undefined) {
      handler = event =>
        this.setSelected(
          this.visible(group.repositories).map(r => r.id),
          event.currentTarget.checked
        )
      this.groupToggles.set(group.id, handler)
    }
    return handler
  }

  private getRepositoryToggle(id: number) {
    let handler = this.repositoryToggles.get(id)
    if (handler === undefined) {
      handler = event => this.setSelected([id], event.currentTarget.checked)
      this.repositoryToggles.set(id, handler)
    }
    return handler
  }

  private onFilterChanged = (filterText: string) => {
    this.setState({ filterText })
  }

  private onLocationChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    this.setOptions({
      location: event.currentTarget.value === 'relative' ? 'relative' : 'full',
    })
  }

  private onRemotesChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    this.setOptions({
      remotes: value === 'origin' || value === 'none' ? value : 'all',
    })
  }

  private onStripChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.setOptions({ stripRemoteCredentials: event.currentTarget.checked })
  }

  private onGroupsChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.setOptions({ groups: event.currentTarget.checked })
  }

  private onGroupStyleChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.setOptions({ groupStyle: event.currentTarget.checked })
  }

  private onAliasesChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.setOptions({ aliases: event.currentTarget.checked })
  }

  private onFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const format = event.currentTarget.value === 'csv' ? 'csv' : 'json'
    this.setState({ format }, this.saveOptions)
  }

  private onSubmit = async () => {
    const repositories = this.selectedRepositories
    if (repositories.length === 0) {
      return
    }
    const { options, format } = this.state

    const path = await showSaveDialog({
      title: 'Export repositories',
      buttonLabel: 'Export',
      defaultPath:
        format === 'csv'
          ? 'github-desktop-repositories.csv'
          : 'github-desktop-repositories.json',
      filters:
        format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'Repository list', extensions: ['json'] }],
    })
    if (path === null || !this.mounted) {
      return
    }

    this.setState({ isExporting: true, error: null })
    try {
      const data = await buildRepositoryExport(repositories, options)
      if (format === 'csv') {
        await writeFile(path, buildRepositoryCsv(data, options), 'utf8')
      } else {
        await writeRepositoryExport(path, data)
      }
      const count = data.repositories.length
      this.props.onExported(
        `Exported ${count} ${
          count === 1 ? 'repository' : 'repositories'
        } to ${Path.basename(path)}`
      )
      this.props.onDismissed()
    } catch (e) {
      log.error('Failed to export repositories', e)
      if (this.mounted) {
        this.setState({
          isExporting: false,
          error: `Couldn't export repositories: ${
            e instanceof Error ? e.message : e
          }`,
        })
      }
    }
  }

  public render() {
    const count = this.state.selected.size
    return (
      <Dialog
        id="export-repositories"
        title="Export repositories"
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={this.state.isExporting}
        disabled={this.state.isExporting}
      >
        {this.state.error !== null && (
          <DialogError>{this.state.error}</DialogError>
        )}
        <DialogContent>
          {this.renderRepositoryPicker()}
          {this.renderFields()}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={
              count === 1
                ? 'Export 1 repository…'
                : `Export ${count} repositories…`
            }
            okButtonDisabled={count === 0 || this.state.isExporting}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private renderRepositoryPicker() {
    const visibleAll = this.visible(this.props.repositories)
    return (
      <section className="export-repositories-picker">
        <div className="export-picker-header">
          <Checkbox
            label={`Repositories (${this.state.selected.size} of ${this.props.repositories.length})`}
            value={this.checkboxValue(visibleAll)}
            onChange={this.onToggleAll}
          />
          <TextBox
            className="export-filter"
            ariaLabel="Filter repositories"
            placeholder="Filter"
            type="search"
            value={this.state.filterText}
            onValueChanged={this.onFilterChanged}
          />
        </div>
        <div className="export-picker-list">
          {this.groups.map(group => this.renderGroup(group))}
          {visibleAll.length === 0 && (
            <div className="export-picker-empty">
              No repositories match “{this.state.filterText}”.
            </div>
          )}
        </div>
      </section>
    )
  }

  private renderGroup(group: IListGroup) {
    const visible = this.visible(group.repositories)
    if (visible.length === 0) {
      return null
    }
    const style =
      group.color !== undefined
        ? ({
            '--group-color': group.color,
            '--group-tint': hexToRgba(group.color, 0.1),
          } as React.CSSProperties)
        : undefined

    return (
      <div key={group.id} className="export-picker-group">
        <div
          className={
            group.color !== undefined
              ? 'export-picker-group-header colored'
              : 'export-picker-group-header'
          }
          style={style}
        >
          <Checkbox
            label={group.name}
            value={this.checkboxValue(visible)}
            onChange={this.getGroupToggle(group)}
          />
        </div>
        {visible.map(r => (
          <div key={r.id} className="export-picker-repository">
            <Checkbox
              label={r.alias ?? r.name}
              value={
                this.state.selected.has(r.id)
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.getRepositoryToggle(r.id)}
            />
            <span className="export-picker-path">{r.path}</span>
          </div>
        ))}
      </div>
    )
  }

  private renderFields() {
    const { options, format } = this.state
    const root =
      options.location === 'relative'
        ? getCommonRoot(this.selectedRepositories.map(r => r.path))
        : null

    return (
      <section className="export-repositories-fields">
        <h3>Include</h3>
        <div className="export-field-row">
          <Select
            label="Location"
            value={options.location}
            onChange={this.onLocationChanged}
          >
            <option value="full">Full path</option>
            <option value="relative">Relative to their shared folder</option>
          </Select>
          <Select
            label="Remotes"
            value={options.remotes}
            onChange={this.onRemotesChanged}
          >
            <option value="all">All remotes</option>
            <option value="origin">Origin only</option>
            <option value="none">None</option>
          </Select>
        </div>
        {options.location === 'relative' && (
          <p className="export-field-hint">
            {root !== null ? (
              <>
                Paths are saved relative to <code>{root}</code>; whoever imports
                chooses where they go.
              </>
            ) : (
              <>
                These repositories don't share a folder, so only folder names
                are saved.
              </>
            )}
          </p>
        )}
        <Checkbox
          label="Remove usernames, passwords and tokens from remote URLs"
          value={
            options.stripRemoteCredentials && options.remotes !== 'none'
              ? CheckboxValue.On
              : CheckboxValue.Off
          }
          onChange={this.onStripChanged}
          disabled={options.remotes === 'none'}
        />
        <Checkbox
          label="Groups"
          value={options.groups ? CheckboxValue.On : CheckboxValue.Off}
          onChange={this.onGroupsChanged}
        />
        <div className="export-field-indent">
          <Checkbox
            label={
              format === 'csv'
                ? 'Group colors'
                : 'Group colors and collapsed state'
            }
            value={
              options.groups && options.groupStyle
                ? CheckboxValue.On
                : CheckboxValue.Off
            }
            onChange={this.onGroupStyleChanged}
            disabled={!options.groups}
          />
        </div>
        <Checkbox
          label="Aliases"
          value={options.aliases ? CheckboxValue.On : CheckboxValue.Off}
          onChange={this.onAliasesChanged}
        />
        <div className="export-field-row">
          <Select label="Format" value={format} onChange={this.onFormatChanged}>
            <option value="json">JSON (can be imported again)</option>
            <option value="csv">CSV (for spreadsheets)</option>
          </Select>
        </div>
      </section>
    )
  }
}
