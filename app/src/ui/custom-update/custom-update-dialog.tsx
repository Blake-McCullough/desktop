import * as React from 'react'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { Button } from '../lib/button'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { shell } from '../../lib/app-shell'
import { writeClipboardText } from '../main-process-proxy'
import {
  ICustomUpdateState,
  customUpdateStore,
} from '../lib/custom-update-store'
import {
  CustomInstallKind,
  summarizeReleaseNotes,
} from '../../lib/custom-update'
import { Disposable } from 'event-kit'

interface ICustomUpdateDialogProps {
  readonly onDismissed: () => void
  /** Start installing straight away (from the banner's "Update now"). */
  readonly installImmediately?: boolean
}

interface ICustomUpdateDialogState {
  readonly update: ICustomUpdateState
  readonly autoCheck: boolean
}

const InstallKindLabels: Record<CustomInstallKind, string> = {
  'windows-setup': 'Installed with the Windows installer',
  pacman: 'Installed as an Arch Linux package (pacman)',
  appimage: 'Running as an AppImage',
  manual: "This copy can't update itself (not installed from a release)",
}

function formatMB(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

/** Shows the installed and latest versions and installs updates. */
export class CustomUpdateDialog extends React.Component<
  ICustomUpdateDialogProps,
  ICustomUpdateDialogState
> {
  private subscription: Disposable | null = null

  public constructor(props: ICustomUpdateDialogProps) {
    super(props)
    this.state = {
      update: customUpdateStore.getState(),
      autoCheck: customUpdateStore.isAutoCheckEnabled(),
    }
  }

  public async componentDidMount() {
    this.subscription = customUpdateStore.onDidUpdate(update =>
      this.setState({ update })
    )

    if (this.props.installImmediately) {
      customUpdateStore.install()
    } else {
      customUpdateStore.check()
    }
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
  }

  private onUpdate = () => customUpdateStore.install()

  private onCheck = () => customUpdateStore.check()

  private onOpenRelease = () => {
    const url = this.state.update.lastCheck?.latest?.htmlUrl
    if (url !== undefined) {
      shell.openExternal(url)
    }
  }

  private onCopyCommand = () => {
    const command = this.state.update.manualCommand
    if (command !== null) {
      writeClipboardText(command)
    }
  }

  private onAutoCheckChanged = (event: React.FormEvent<HTMLInputElement>) => {
    const autoCheck = event.currentTarget.checked
    customUpdateStore.setAutoCheckEnabled(autoCheck)
    this.setState({ autoCheck })
  }

  private renderStatus() {
    const { lastCheck, isChecking } = this.state.update

    if (lastCheck === null) {
      return (
        <p className="update-status">
          {isChecking ? 'Checking for updates…' : 'Not checked yet.'}
        </p>
      )
    }

    if (lastCheck.error !== null) {
      return (
        <p className="update-status error">
          <Octicon symbol={octicons.alert} />
          Couldn't check for updates: {lastCheck.error}
        </p>
      )
    }

    const { latest } = lastCheck
    if (latest === null) {
      return (
        <p className="update-status">No releases have been published yet.</p>
      )
    }

    if (!lastCheck.isUpdateAvailable) {
      return (
        <p className="update-status ok">
          <Octicon symbol={octicons.check} />
          You're on the latest version.
        </p>
      )
    }

    const notes = summarizeReleaseNotes(latest.notes)
    const published =
      latest.publishedAt.length > 0
        ? new Date(latest.publishedAt).toLocaleString()
        : null

    return (
      <div className="update-available">
        <p className="update-status available">
          <Octicon symbol={octicons.arrowUp} />
          <strong>{latest.version}</strong> is available
          {published !== null && <span className="muted"> — {published}</span>}
        </p>
        {notes.length > 0 && <pre className="release-notes">{notes}</pre>}
      </div>
    )
  }

  private renderProgress() {
    const { progress, isInstalling, installError, manualCommand } =
      this.state.update

    if (installError !== null) {
      return (
        <div className="update-error">
          <p>
            <Octicon symbol={octicons.alert} />
            {installError}
          </p>
          {manualCommand !== null && (
            <div className="manual-command">
              <span>You can run this in a terminal instead:</span>
              <code>{manualCommand}</code>
              <Button onClick={this.onCopyCommand}>Copy</Button>
            </div>
          )}
        </div>
      )
    }

    if (!isInstalling) {
      return null
    }

    if (progress === null || progress.phase === 'downloading') {
      const received = progress?.received ?? 0
      const total = progress?.total ?? 0
      const percent = total > 0 ? Math.round((received / total) * 100) : 0
      return (
        <div className="update-progress">
          <div className="label">
            Downloading…{' '}
            {total > 0 ? `${formatMB(received)} of ${formatMB(total)}` : ''}
          </div>
          <progress max={100} value={percent} />
        </div>
      )
    }

    return (
      <div className="update-progress">
        <div className="label">
          {progress.phase === 'installing'
            ? progress.message
            : 'Restarting into the new version…'}
        </div>
        <progress />
      </div>
    )
  }

  public render() {
    const { lastCheck, isChecking, isInstalling } = this.state.update
    const latest = lastCheck?.latest ?? null
    const canInstall =
      lastCheck !== null &&
      lastCheck.isUpdateAvailable &&
      lastCheck.installKind !== 'manual' &&
      latest?.asset != null

    return (
      <Dialog
        id="custom-update"
        title={__DARWIN__ ? 'Check for Updates' : 'Check for updates'}
        onDismissed={this.props.onDismissed}
        onSubmit={canInstall ? this.onUpdate : this.props.onDismissed}
        dismissDisabled={isInstalling}
        loading={isChecking}
      >
        <DialogContent>
          <p className="current-version">
            GitHub Desktop Custom{' '}
            <strong>{lastCheck?.currentVersion ?? '…'}</strong>
            {lastCheck !== null && (
              <span className="muted">
                {' '}
                · {InstallKindLabels[lastCheck.installKind]}
              </span>
            )}
          </p>

          {this.renderStatus()}
          {this.renderProgress()}

          <Checkbox
            label="Check for updates automatically"
            value={this.state.autoCheck ? CheckboxValue.On : CheckboxValue.Off}
            onChange={this.onAutoCheckChanged}
          />
        </DialogContent>

        <DialogFooter>
          <div className="custom-update-footer">
            {latest !== null && (
              <Button onClick={this.onOpenRelease}>View on GitHub</Button>
            )}
            <Button
              onClick={this.onCheck}
              disabled={isChecking || isInstalling}
            >
              Check again
            </Button>
            <span className="spacer" />
            <Button onClick={this.props.onDismissed} disabled={isInstalling}>
              Close
            </Button>
            {canInstall && (
              <Button type="submit" disabled={isInstalling}>
                {isInstalling ? 'Updating…' : 'Update and restart'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </Dialog>
    )
  }
}
