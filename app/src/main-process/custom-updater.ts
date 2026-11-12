import { app, net, WebContents } from 'electron'
import * as Path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { chmod, mkdir, rename, rm } from 'fs/promises'
import {
  CustomInstallKind,
  CustomUpdateProgress,
  CustomUpdateRepository,
  ICustomRelease,
  ICustomUpdateCheckResult,
  ICustomUpdateInstallResult,
  IGitHubReleaseJson,
  isNewerVersion,
  toCustomRelease,
} from '../lib/custom-update'
import * as ipcWebContents from './ipc-webcontents'

const LinuxInstallDir = '/opt/github-desktop-custom'

/** Work out how this copy of the app was installed. */
export function getInstallKind(): CustomInstallKind {
  if (process.platform === 'win32') {
    // Squirrel installs live in …\GitHubDesktopCustom\app-<version>\ with
    // Update.exe one level up.
    const updateExe = Path.resolve(
      Path.dirname(process.execPath),
      '..',
      'Update.exe'
    )
    return existsSync(updateExe) ? 'windows-setup' : 'manual'
  }

  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) {
      return 'appimage'
    }
    if (process.execPath.startsWith(`${LinuxInstallDir}/`)) {
      return 'pacman'
    }
  }

  return 'manual'
}

/** Ask GitHub for the latest release and compare it to this version. */
export async function checkForCustomUpdate(): Promise<ICustomUpdateCheckResult> {
  const currentVersion = app.getVersion()
  const installKind = getInstallKind()

  try {
    const response = await net.fetch(
      `https://api.github.com/repos/${CustomUpdateRepository}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `GitHubDesktopCustom/${currentVersion}`,
        },
        cache: 'no-store',
      }
    )

    if (response.status === 404) {
      return {
        currentVersion,
        installKind,
        latest: null,
        isUpdateAvailable: false,
        error: null,
      }
    }

    if (!response.ok) {
      const limited =
        response.status === 403 &&
        response.headers.get('x-ratelimit-remaining') === '0'
      throw new Error(
        limited
          ? 'GitHub rate limit reached; try again later'
          : `GitHub returned ${response.status}`
      )
    }

    const json = (await response.json()) as IGitHubReleaseJson
    const latest = toCustomRelease(
      json,
      installKind,
      process.platform,
      process.arch
    )

    return {
      currentVersion,
      installKind,
      latest,
      isUpdateAvailable:
        latest !== null && isNewerVersion(latest.version, currentVersion),
      error: null,
    }
  } catch (e) {
    log.warn('[CustomUpdater] update check failed', e)
    return {
      currentVersion,
      installKind,
      latest: null,
      isUpdateAvailable: false,
      error: e instanceof Error ? e.message : `${e}`,
    }
  }
}

function sendProgress(
  webContents: WebContents,
  progress: CustomUpdateProgress
) {
  if (!webContents.isDestroyed()) {
    ipcWebContents.send(webContents, 'custom-update-progress', progress)
  }
}

/** Download a release file, reporting progress. Returns the file's path. */
async function download(
  url: string,
  destination: string,
  expectedSize: number,
  webContents: WebContents
): Promise<string> {
  await mkdir(Path.dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  await rm(partial, { force: true })

  const response = await net.fetch(url, {
    headers: { 'User-Agent': `GitHubDesktopCustom/${app.getVersion()}` },
  })
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed (${response.status})`)
  }

  const total =
    parseInt(response.headers.get('content-length') ?? '', 10) || expectedSize
  const file = createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0
  let lastReport = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.byteLength
      if (!file.write(value)) {
        await new Promise<void>(resolve => file.once('drain', () => resolve()))
      }
      const now = Date.now()
      if (now - lastReport > 200) {
        lastReport = now
        sendProgress(webContents, { phase: 'downloading', received, total })
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      file.end((err?: Error | null) => (err ? reject(err) : resolve()))
    )
  }

  if (expectedSize > 0 && received !== expectedSize) {
    await rm(partial, { force: true })
    throw new Error(
      `Download was incomplete (${received} of ${expectedSize} bytes)`
    )
  }

  sendProgress(webContents, { phase: 'downloading', received, total })
  await rename(partial, destination)
  return destination
}

/** Run a command and resolve with its exit code (or reject if it can't start). */
function runCommand(command: string, args: ReadonlyArray<string>) {
  return new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', chunk => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stderr }))
    }
  )
}

function quitAndRelaunch(execPath?: string) {
  setTimeout(() => {
    app.relaunch(execPath !== undefined ? { execPath } : undefined)
    app.exit(0)
  }, 300)
}

/**
 * Download and install a release, then restart into it. Resolves once the
 * app is about to quit, or with an error (and, where it helps, a command
 * the user can run themselves).
 */
export async function installCustomUpdate(
  release: ICustomRelease,
  webContents: WebContents
): Promise<ICustomUpdateInstallResult> {
  const kind = getInstallKind()
  const asset = release.asset

  if (asset === null || kind === 'manual') {
    return {
      ok: false,
      error:
        "This copy can't update itself; download the new version from the release page.",
      manualCommand: null,
    }
  }

  const downloadDir = Path.join(os.tmpdir(), 'github-desktop-custom-update')

  try {
    if (kind === 'windows-setup') {
      const setup = await download(
        asset.url,
        Path.join(downloadDir, asset.name),
        asset.size,
        webContents
      )
      sendProgress(webContents, {
        phase: 'installing',
        message: 'Starting the installer…',
      })
      // Squirrel's Setup.exe installs the new version over this one and
      // starts it once done; it needs this copy to have exited.
      spawn(setup, [], { detached: true, stdio: 'ignore' }).unref()
      sendProgress(webContents, { phase: 'restarting' })
      setTimeout(() => app.quit(), 500)
      return { ok: true, error: null, manualCommand: null }
    }

    if (kind === 'appimage') {
      const target = process.env.APPIMAGE
      if (target === undefined) {
        throw new Error('Could not find the AppImage file')
      }
      // Download next to the AppImage so the final rename is atomic.
      const downloaded = await download(
        asset.url,
        `${target}.update`,
        asset.size,
        webContents
      )
      sendProgress(webContents, {
        phase: 'installing',
        message: 'Replacing the AppImage…',
      })
      await chmod(downloaded, 0o755)
      // Replacing a running AppImage is fine on Linux: this process keeps
      // the old file open until it exits.
      await rename(downloaded, target)
      sendProgress(webContents, { phase: 'restarting' })
      quitAndRelaunch(target)
      return { ok: true, error: null, manualCommand: null }
    }

    // pacman
    const pkg = await download(
      asset.url,
      Path.join(downloadDir, asset.name),
      asset.size,
      webContents
    )
    const manualCommand = `sudo pacman -U ${pkg}`
    sendProgress(webContents, {
      phase: 'installing',
      message: 'Installing — enter your password if asked…',
    })

    let result: { code: number | null; stderr: string }
    try {
      // pkexec shows the desktop's graphical password prompt.
      result = await runCommand('pkexec', ['pacman', '-U', '--noconfirm', pkg])
    } catch (e) {
      log.warn('[CustomUpdater] could not run pkexec', e)
      return {
        ok: false,
        error:
          "Couldn't ask for administrator rights (pkexec isn't available).",
        manualCommand,
      }
    }

    if (result.code !== 0) {
      const cancelled = result.code === 126 || result.code === 127
      log.warn(
        `[CustomUpdater] pacman exited with ${result.code}: ${result.stderr}`
      )
      return {
        ok: false,
        error: cancelled
          ? 'The update was cancelled at the password prompt.'
          : `pacman failed (exit code ${result.code}). ${result.stderr
              .trim()
              .split('\n')
              .slice(-2)
              .join(' ')}`,
        manualCommand,
      }
    }

    sendProgress(webContents, { phase: 'restarting' })
    quitAndRelaunch()
    return { ok: true, error: null, manualCommand: null }
  } catch (e) {
    log.error('[CustomUpdater] update failed', e)
    return {
      ok: false,
      error: e instanceof Error ? e.message : `${e}`,
      manualCommand: null,
    }
  }
}
