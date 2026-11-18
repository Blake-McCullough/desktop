import * as React from 'react'
import { About } from './about'
import { getName, getVersion } from '../lib/app-proxy'
import { ICustomUpdateState } from '../lib/custom-update-store'

interface IAboutTestDialogProps {
  /**
   * Event triggered when the dialog is dismissed by the user in the
   * ways described in the Dialog component's dismissible prop.
   */
  readonly onDismissed: () => void

  readonly onShowAcknowledgements: () => void

  /** A function to call when the user wants to see Terms and Conditions. */
  readonly onShowTermsAndConditions: () => void
}

interface IAboutTestDialogState {
  readonly updateState: ICustomUpdateState
}

/**
 * The About dialog with a pretend update check, for trying out its states
 * (Help → Test menu in development builds).
 */
export class AboutTestDialog extends React.Component<
  IAboutTestDialogProps,
  IAboutTestDialogState
> {
  private delayTimeoutId: number | null = null

  public constructor(props: IAboutTestDialogProps) {
    super(props)

    this.state = {
      updateState: {
        lastCheck: {
          currentVersion: getVersion(),
          installKind: 'manual',
          latest: null,
          isUpdateAvailable: false,
          error: null,
        },
        lastCheckedAt: new Date(Date.now() - 1000 * 60 * 60),
        isChecking: false,
        progress: null,
        isInstalling: false,
        installError: null,
        manualCommand: null,
        dismissedVersion: null,
      },
    }
  }

  private onCheckForUpdates = async () => {
    this.setUpdateState({ isChecking: true })
    await this.delay(3000)
    this.setUpdateState({
      isChecking: false,
      lastCheckedAt: new Date(),
      lastCheck: {
        currentVersion: getVersion(),
        installKind: 'manual',
        latest: {
          version: '99.0.0',
          tag: 'v99.0.0',
          name: 'v99.0.0',
          notes: '',
          htmlUrl: 'https://example.com',
          publishedAt: new Date().toISOString(),
          asset: null,
          squirrelPackage: null,
        },
        isUpdateAvailable: true,
        error: null,
      },
    })
  }

  private onInstallUpdate = async () => {
    this.setUpdateState({ isInstalling: true })
    await this.delay(3000)
    this.setUpdateState({
      isInstalling: false,
      installError: 'This is only a test.',
    })
  }

  private delay = (ms: number) => {
    return new Promise(resolve => {
      if (this.delayTimeoutId !== null) {
        clearTimeout(this.delayTimeoutId)
      }
      this.delayTimeoutId = window.setTimeout(resolve, ms)
    })
  }

  public render() {
    const version = __DEV__ ? __SHA__.substring(0, 10) : getVersion()

    return (
      <About
        key="about"
        onDismissed={this.props.onDismissed}
        applicationName={getName()}
        applicationVersion={version}
        applicationArchitecture={process.arch}
        onShowAcknowledgements={this.props.onShowAcknowledgements}
        onShowTermsAndConditions={this.props.onShowTermsAndConditions}
        updateState={this.state.updateState}
        onCheckForUpdates={this.onCheckForUpdates}
        onInstallUpdate={this.onInstallUpdate}
        onShowUpdateDetails={this.props.onDismissed}
        allowDevelopment={true}
      />
    )
  }

  private setUpdateState(updateState: Partial<ICustomUpdateState>) {
    this.setState({
      updateState: {
        ...this.state.updateState,
        ...updateState,
      },
    })
  }

  public componentWillUnmount(): void {
    if (this.delayTimeoutId !== null) {
      clearTimeout(this.delayTimeoutId)
    }
  }
}
