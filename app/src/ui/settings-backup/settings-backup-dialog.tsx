import * as React from 'react'
import { readFile, writeFile } from 'fs/promises'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { Button } from '../lib/button'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { showOpenDialog, showSaveDialog } from '../main-process-proxy'
import { getVersion } from '../lib/app-proxy'
import {
  ILocalRepositoryRef,
  ISettingsBackup,
  SettingsSection,
  SettingsSections,
  getBackupSections,
  parseSettingsBackup,
} from '../../lib/settings-backup'
import {
  applySettingsBackup,
  buildSettingsBackup,
  describeImport,
  getLocalRepositoryRefs,
} from './settings-backup-io'

interface ISettingsBackupDialogProps {
  readonly mode: 'export' | 'import'
  readonly dispatcher: Dispatcher
  readonly repositories: ReadonlyArray<Repository>
  readonly onDismissed: () => void
}

interface ISettingsBackupDialogState {
  readonly local: ReadonlyArray<ILocalRepositoryRef> | null
  readonly selected: ReadonlySet<SettingsSection>
  /** Import: the backup read from the chosen file. */
  readonly backup: ISettingsBackup | null
  readonly fileName: string | null
  readonly busy: boolean
  readonly error: string | null
  /** Set once the export or import is done. */
  readonly done: string | null
}

const fileFilters = [{ name: 'Settings backup', extensions: ['json'] }]

/**
 * File → Export settings / Import settings: this app's own settings
 * (groups, colours, shortcuts, notification choices…, never tokens) as a
 * file, for setting up another computer.
 */
export class SettingsBackupDialog extends React.Component<
  ISettingsBackupDialogProps,
  ISettingsBackupDialogState
> {
  private mounted = false
  private readonly toggleHandlers = new Map<
    SettingsSection,
    (event: React.FormEvent<HTMLInputElement>) => void
  >()

  public constructor(props: ISettingsBackupDialogProps) {
    super(props)
    this.state = {
      local: null,
      selected: new Set(SettingsSections.map(s => s.id)),
      backup: null,
      fileName: null,
      busy: false,
      error: null,
      done: null,
    }
  }

  public async componentDidMount() {
    this.mounted = true
    const local = await getLocalRepositoryRefs(this.props.repositories)
    if (this.mounted) {
      this.setState({ local })
    }
    if (this.props.mode === 'import') {
      this.onChooseFile()
    }
  }

  public componentWillUnmount() {
    this.mounted = false
  }

  private getToggle(id: SettingsSection) {
    let handler = this.toggleHandlers.get(id)
    if (handler === undefined) {
      handler = (event: React.FormEvent<HTMLInputElement>) => {
        const checked = event.currentTarget.checked
        this.setState(prev => {
          const selected = new Set(prev.selected)
          if (checked) {
            selected.add(id)
          } else {
            selected.delete(id)
          }
          return { selected }
        })
      }
      this.toggleHandlers.set(id, handler)
    }
    return handler
  }

  private onChooseFile = async () => {
    const path = await showOpenDialog({
      title: 'Import settings',
      buttonLabel: 'Choose',
      properties: ['openFile'],
      filters: fileFilters,
    })
    if (path === null || !this.mounted) {
      return
    }
    try {
      const backup = parseSettingsBackup(await readFile(path, 'utf8'))
      this.setState({
        backup,
        fileName: path,
        selected: new Set(getBackupSections(backup)),
        error: null,
        done: null,
      })
    } catch (e) {
      this.setState({
        backup: null,
        error: e instanceof Error ? e.message : `${e}`,
      })
    }
  }

  private onSubmit = async () => {
    if (this.state.done !== null) {
      this.props.onDismissed()
      return
    }
    if (this.props.mode === 'export') {
      await this.export()
    } else {
      this.import()
    }
  }

  private async export() {
    const { local, selected } = this.state
    if (local === null) {
      return
    }
    const path = await showSaveDialog({
      title: 'Export settings',
      buttonLabel: 'Export',
      defaultPath: 'github-desktop-custom-settings.json',
      filters: fileFilters,
    })
    if (path === null || !this.mounted) {
      return
    }
    this.setState({ busy: true, error: null })
    try {
      const backup = buildSettingsBackup(selected, local, getVersion())
      await writeFile(path, JSON.stringify(backup, null, 2) + '\n', 'utf8')
      this.setState({ busy: false, done: `Saved to ${path}` })
    } catch (e) {
      this.setState({
        busy: false,
        error: `Couldn't save the file: ${e instanceof Error ? e.message : e}`,
      })
    }
  }

  private import() {
    const { backup, local, selected } = this.state
    if (backup === null || local === null) {
      return
    }
    try {
      applySettingsBackup(backup, selected, local, this.props.dispatcher)
      this.setState({
        done: selected.has('gitlab')
          ? 'Settings imported. Add tokens for the GitLab servers in Options → GitLab.'
          : 'Settings imported.',
      })
    } catch (e) {
      log.error('Failed to import settings', e)
      this.setState({
        error: `Couldn't import the settings: ${
          e instanceof Error ? e.message : e
        }`,
      })
    }
  }

  public render() {
    const isExport = this.props.mode === 'export'
    const { selected, done, busy, error, local, backup } = this.state
    const title = isExport
      ? __DARWIN__
        ? 'Export Settings'
        : 'Export settings'
      : __DARWIN__
      ? 'Import Settings'
      : 'Import settings'

    const canSubmit =
      done !== null ||
      (selected.size > 0 && local !== null && (isExport || backup !== null))

    return (
      <Dialog
        id="settings-backup"
        title={title}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={busy || local === null}
      >
        <DialogContent>
          {isExport ? this.renderExport() : this.renderImport()}
          {error !== null && (
            <p className="settings-backup-error" role="alert">
              {error}
            </p>
          )}
          {done !== null && (
            <p className="settings-backup-done" role="status">
              {done}
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={
              done !== null ? 'Done' : isExport ? 'Export…' : 'Import'
            }
            okButtonDisabled={!canSubmit}
            cancelButtonVisible={done === null}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private renderExport() {
    return (
      <>
        <p>
          Save this app's settings to a file, to use on another computer with{' '}
          <strong>Import settings</strong>. Tokens and passwords are never
          included; repositories are remembered by their remote, so they're
          found again wherever they're cloned.
        </p>
        {SettingsSections.map(s => (
          <Checkbox
            key={s.id}
            label={s.label}
            value={
              this.state.selected.has(s.id)
                ? CheckboxValue.On
                : CheckboxValue.Off
            }
            onChange={this.getToggle(s.id)}
            disabled={this.state.done !== null}
          />
        ))}
      </>
    )
  }

  private renderImport() {
    const { backup, fileName, local, done } = this.state
    if (backup === null) {
      return (
        <>
          <p>
            Choose a settings backup made with{' '}
            <strong>File → Export settings</strong>.
          </p>
          <Button onClick={this.onChooseFile}>Choose file…</Button>
        </>
      )
    }

    const sections = getBackupSections(backup)
    return (
      <>
        <p className="settings-backup-file">
          {fileName}
          {backup.appVersion !== '' &&
            ` (from version ${backup.appVersion})`}{' '}
          <Button onClick={this.onChooseFile} disabled={done !== null}>
            Choose another…
          </Button>
        </p>
        <p>Choose what to import:</p>
        {SettingsSections.filter(s => sections.includes(s.id)).map(s => (
          <div key={s.id} className="settings-backup-section">
            <Checkbox
              label={s.label}
              value={
                this.state.selected.has(s.id)
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.getToggle(s.id)}
              disabled={done !== null}
            />
            {local !== null && (
              <p className="settings-backup-detail">
                {describeImport(backup, s.id, local)}
              </p>
            )}
          </div>
        ))}
      </>
    )
  }
}
