import * as React from 'react'
import { CustomLinks } from '../../lib/custom-links'

import { Row } from '../lib/row'
import { Button } from '../lib/button'
import {
  Dialog,
  DialogError,
  DialogContent,
  DefaultDialogFooter,
} from '../dialog'
import { LinkButton } from '../lib/link-button'
import { ICustomUpdateState } from '../lib/custom-update-store'
import { Loading } from '../lib/loading'
import { RelativeTime } from '../relative-time'
import { ReleaseNotesUri } from '../lib/releases'
import { encodePathAsUrl } from '../../lib/path'
import { AriaLiveContainer } from '../accessibility/aria-live-container'
import { formatDate } from '../../lib/format-date'

const logoPath = __DARWIN__
  ? 'static/logo-64x64@2x.png'
  : 'static/windows-logo-64x64@2x.png'
const DesktopLogo = encodePathAsUrl(__dirname, logoPath)

interface IAboutProps {
  /**
   * Event triggered when the dialog is dismissed by the user in the
   * ways described in the Dialog component's dismissible prop.
   */
  readonly onDismissed: () => void

  /**
   * The name of the currently installed (and running) application
   */
  readonly applicationName: string

  /**
   * The currently installed (and running) version of the app.
   */
  readonly applicationVersion: string

  /**
   * The currently installed (and running) architecture of the app.
   */
  readonly applicationArchitecture: string

  readonly onShowAcknowledgements: () => void

  /** A function to call when the user wants to see Terms and Conditions. */
  readonly onShowTermsAndConditions: () => void

  /** This build's own update checker (GitHub releases of this project). */
  readonly updateState: ICustomUpdateState
  readonly onCheckForUpdates: () => void
  /** Download and install the newer release. */
  readonly onInstallUpdate: () => void
  /** Show the newer release's notes and install options. */
  readonly onShowUpdateDetails: () => void

  /**
   * A flag to indicate whether the About dialog should ignore that
   * it's running in development mode. Used exclusively by the AboutTestDialog
   */
  readonly allowDevelopment?: boolean
}

interface IUpdateInfoProps {
  readonly message: string
  readonly richMessage?: JSX.Element
  readonly loading?: boolean
}

class UpdateInfo extends React.Component<IUpdateInfoProps> {
  public render() {
    return (
      <div className="update-status">
        <AriaLiveContainer message={this.props.message} />

        {this.props.loading && <Loading />}
        {this.props.richMessage ?? this.props.message}
      </div>
    )
  }
}

/** The official GitHub Desktop's source code, which this build is based on. */
const OfficialGitHubDesktopRepository = 'https://github.com/desktop/desktop'

/**
 * A dialog that presents information about the
 * running application such as name and version.
 */
export class About extends React.Component<IAboutProps> {
  private get canCheckForUpdates() {
    return (
      __RELEASE_CHANNEL__ !== 'development' ||
      this.props.allowDevelopment === true
    )
  }

  private renderUpdateButton() {
    if (!this.canCheckForUpdates) {
      return null
    }

    const { lastCheck, isChecking, isInstalling } = this.props.updateState
    if (lastCheck?.isUpdateAvailable && lastCheck.latest !== null) {
      return (
        <Row className="update-buttons">
          <Button
            onClick={this.props.onInstallUpdate}
            disabled={isInstalling}
          >
            {isInstalling ? 'Updating…' : 'Update now'}
          </Button>
          <Button onClick={this.props.onShowUpdateDetails}>
            See what's new
          </Button>
        </Row>
      )
    }

    return (
      <Row className="update-buttons">
        <Button
          disabled={isChecking || isInstalling}
          onClick={this.props.onCheckForUpdates}
        >
          {__DARWIN__ ? 'Check for Updates' : 'Check for updates'}
        </Button>
      </Row>
    )
  }

  private renderUpdateDetails() {
    if (!this.canCheckForUpdates) {
      return (
        <p>
          The application is currently running in development and will not
          receive any updates.
        </p>
      )
    }

    const { lastCheck, lastCheckedAt, isChecking, isInstalling } =
      this.props.updateState

    if (isInstalling) {
      return <UpdateInfo message="Installing the update…" loading={true} />
    }
    if (isChecking) {
      return <UpdateInfo message="Checking for updates…" loading={true} />
    }
    if (lastCheck === null || lastCheckedAt === null || lastCheck.error) {
      return null
    }

    if (lastCheck.isUpdateAvailable && lastCheck.latest !== null) {
      const message = `Version ${lastCheck.latest.version} is available.`
      return <UpdateInfo message={message} />
    }

    const absoluteDate = formatDate(lastCheckedAt, {
      dateStyle: 'full',
      timeStyle: 'short',
    })
    return (
      <UpdateInfo
        message={`You have the latest version (last checked ${absoluteDate})`}
        richMessage={
          <p>
            You have the latest version (last checked{' '}
            <RelativeTime date={lastCheckedAt} />)
          </p>
        }
      />
    )
  }

  private renderUpdateErrors() {
    if (!this.canCheckForUpdates) {
      return null
    }

    const { lastCheck, isChecking, installError } = this.props.updateState
    if (installError !== null) {
      return (
        <DialogError>Couldn't install the update: {installError}</DialogError>
      )
    }
    if (!isChecking && lastCheck?.error) {
      return (
        <DialogError>
          Couldn't check for updates: {lastCheck.error}. You can also get new
          versions from the{' '}
          <LinkButton uri={CustomLinks.releases}>releases page</LinkButton>.
        </DialogError>
      )
    }
    return null
  }

  private renderBetaLink() {
    if (__RELEASE_CHANNEL__ === 'beta') {
      return
    }

    return (
      <div>
        <p className="no-padding">Looking for the latest features?</p>
        <p className="no-padding">
          Every change is released automatically; see the{' '}
          <LinkButton uri={CustomLinks.releases}>releases</LinkButton>.
        </p>
      </div>
    )
  }

  public render() {
    const name = this.props.applicationName
    const version = this.props.applicationVersion
    const releaseNotesLink = (
      <LinkButton uri={ReleaseNotesUri}>release notes</LinkButton>
    )

    const versionText = __DEV__ ? `Build ${version}` : `Version ${version}`
    const titleId = 'Dialog_about'

    return (
      <Dialog
        id="about"
        titleId={titleId}
        onSubmit={this.props.onDismissed}
        onDismissed={this.props.onDismissed}
      >
        {this.renderUpdateErrors()}
        <DialogContent>
          <Row className="logo">
            <img src={DesktopLogo} alt="" width="64" height="64" />
          </Row>
          <h1 id={titleId}>About {name}</h1>
          <p className="no-padding">
            <span className="selectable-text">
              {versionText} ({this.props.applicationArchitecture})
            </span>{' '}
            ({releaseNotesLink})
          </p>
          <p className="about-custom-build">
            A custom build of the official GitHub Desktop that adds GitLab CI/CD
            pipelines, repository groups and more. It isn't made or supported by
            GitHub.
          </p>
          <p className="about-links">
            <LinkButton uri={OfficialGitHubDesktopRepository}>
              Official GitHub Desktop on GitHub
            </LinkButton>
            {' · '}
            <LinkButton uri={CustomLinks.repository}>
              This project on GitHub
            </LinkButton>
          </p>
          {this.renderUpdateDetails()}
          {this.renderUpdateButton()}
          {this.renderBetaLink()}
          <div className="terms-and-license-container">
            <p className="no-padding terms-and-license">
              <LinkButton onClick={this.props.onShowTermsAndConditions}>
                Terms and Conditions
              </LinkButton>
            </p>
            <p className="no-padding terms-and-license">
              <LinkButton onClick={this.props.onShowAcknowledgements}>
                License and Open Source Notices
              </LinkButton>
            </p>
            <p className="terms-and-license">
              <LinkButton uri="https://gh.io/copilot-for-desktop-transparency">
                Responsible use of Copilot in GitHub Desktop
              </LinkButton>
            </p>
          </div>
        </DialogContent>
        <DefaultDialogFooter />
      </Dialog>
    )
  }
}
