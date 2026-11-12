import { Emitter, Disposable } from 'event-kit'
import {
  CustomUpdateProgress,
  ICustomUpdateCheckResult,
} from '../../lib/custom-update'
import {
  checkForCustomUpdate,
  installCustomUpdate,
} from '../main-process-proxy'
import * as ipcRenderer from '../../lib/ipc-renderer'
import { getBoolean, setBoolean } from '../../lib/local-storage'

const AutoCheckKey = 'custom-update/auto-check'
const DismissedVersionKey = 'custom-update/dismissed-version'

/** First automatic check shortly after launch, then every few hours. */
const FirstCheckDelayMs = 15 * 1000
const CheckIntervalMs = 4 * 60 * 60 * 1000

export interface ICustomUpdateState {
  readonly lastCheck: ICustomUpdateCheckResult | null
  readonly isChecking: boolean
  readonly progress: CustomUpdateProgress | null
  readonly isInstalling: boolean
  readonly installError: string | null
  readonly manualCommand: string | null
  /** A version the user said "later" to; its banner stays hidden. */
  readonly dismissedVersion: string | null
}

/**
 * Checks this build's GitHub releases for newer versions and installs
 * them (see main-process/custom-updater.ts for the platform details).
 */
class CustomUpdateStore {
  private readonly emitter = new Emitter()
  private timer: number | null = null
  private state: ICustomUpdateState = {
    lastCheck: null,
    isChecking: false,
    progress: null,
    isInstalling: false,
    installError: null,
    manualCommand: null,
    dismissedVersion: localStorage.getItem(DismissedVersionKey),
  }

  public constructor() {
    ipcRenderer.on('custom-update-progress', (_, progress) => {
      this.update({ progress })
    })
  }

  public getState() {
    return this.state
  }

  public onDidUpdate(fn: (state: ICustomUpdateState) => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  private update(change: Partial<ICustomUpdateState>) {
    this.state = { ...this.state, ...change }
    this.emitter.emit('did-update', this.state)
  }

  /** Whether to check automatically (on by default). */
  public isAutoCheckEnabled() {
    return getBoolean(AutoCheckKey, true)
  }

  public setAutoCheckEnabled(enabled: boolean) {
    setBoolean(AutoCheckKey, enabled)
    if (enabled) {
      this.startAutoCheck()
    } else {
      this.stopAutoCheck()
    }
    this.emitter.emit('did-update', this.state)
  }

  /** Start periodic background checks (no-op if turned off). */
  public startAutoCheck() {
    this.stopAutoCheck()
    if (!this.isAutoCheckEnabled()) {
      return
    }
    this.timer = window.setTimeout(() => {
      this.check()
      this.timer = window.setInterval(() => this.check(), CheckIntervalMs)
    }, FirstCheckDelayMs)
  }

  private stopAutoCheck() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  public async check(): Promise<ICustomUpdateCheckResult | null> {
    if (this.state.isChecking || this.state.isInstalling) {
      return this.state.lastCheck
    }

    this.update({ isChecking: true })
    try {
      const lastCheck = await checkForCustomUpdate()
      this.update({ lastCheck, isChecking: false })
      return lastCheck
    } catch (e) {
      log.warn('[CustomUpdate] check failed', e)
      this.update({ isChecking: false })
      return null
    }
  }

  /** Whether the "update available" banner should show. */
  public shouldShowBanner() {
    const { lastCheck, dismissedVersion } = this.state
    return (
      lastCheck !== null &&
      lastCheck.isUpdateAvailable &&
      lastCheck.latest !== null &&
      lastCheck.latest.version !== dismissedVersion
    )
  }

  /** Hide the banner for this version (a newer one will show again). */
  public dismiss() {
    const version = this.state.lastCheck?.latest?.version ?? null
    if (version !== null) {
      localStorage.setItem(DismissedVersionKey, version)
    }
    this.update({ dismissedVersion: version })
  }

  public async install() {
    const release = this.state.lastCheck?.latest
    if (release == null || this.state.isInstalling) {
      return
    }

    this.update({
      isInstalling: true,
      installError: null,
      manualCommand: null,
      progress: null,
    })

    const result = await installCustomUpdate(release)
    if (!result.ok) {
      this.update({
        isInstalling: false,
        progress: null,
        installError: result.error,
        manualCommand: result.manualCommand,
      })
    }
    // On success the app is about to restart.
  }
}

export const customUpdateStore = new CustomUpdateStore()
