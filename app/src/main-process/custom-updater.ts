import { app, net, WebContents } from 'electron'
import * as Path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { chmod, mkdir, readFile, rename, rm } from 'fs/promises'
import {
  findInSquirrelReleases,
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
  expectedSha256: string | null,
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
  const hash = createHash('sha256')
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
      hash.update(value)
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

  // GitHub publishes a SHA-256 for release files; refuse anything that
  // doesn't match (corrupted or tampered download).
  const actualSha256 = hash.digest('hex')
  if (expectedSha256 !== null && actualSha256 !== expectedSha256) {
    await rm(partial, { force: true })
    throw new Error(
      "The download's checksum didn't match the release; please try again."
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

function sha1File(path: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha1')
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Squirrel's Update.exe, next to the app-<version> folders. */
function getSquirrelUpdateExe() {
  return Path.resolve(Path.dirname(process.execPath), '..', 'Update.exe')
}

/**
 * Run Update.exe and collect its output (Squirrel prints progress and
 * errors there). Gives up after `timeoutMs`.
 */
function runUpdateExe(args: ReadonlyArray<string>, timeoutMs: number) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(getSquirrelUpdateExe(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let output = ''
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-20000)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('The update took too long to install.'))
      }, timeoutMs)
      child.on('error', e => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ code, output })
      })
    }
  )
}

/**
 * Windows: update in place with Squirrel, the way GitHub Desktop does.
 *
 * Update.exe installs the new version next to the running one while the app
 * is still open, so a failure is reported here instead of happening
 * silently after the app has quit. Then `--processStartAndWait` (what
 * Electron's own quitAndInstall uses) waits for this process to exit and
 * starts the new version.
 */
async function installWithSquirrel(
  release: ICustomRelease,
  downloadDir: string,
  webContents: WebContents
): Promise<ICustomUpdateInstallResult> {
  const pkg = release.squirrelPackage!

  // A folder of its own holding only this release, as Squirrel reads every
  // package listed in RELEASES from it.
  const feedDir = Path.join(downloadDir, `squirrel-${release.version}`)
  await rm(feedDir, { recursive: true, force: true })
  await mkdir(feedDir, { recursive: true })

  const releasesPath = await download(
    pkg.releases.url,
    Path.join(feedDir, 'RELEASES'),
    pkg.releases.size,
    pkg.releases.sha256,
    webContents
  )
  const entry = findInSquirrelReleases(
    await readFile(releasesPath, 'utf8'),
    pkg.nupkg.name,
    pkg.nupkg.size
  )
  if (entry === null) {
    throw new Error(
      "The release's RELEASES file doesn't list its update package."
    )
  }

  // Saved under the name RELEASES uses, which is what Squirrel looks for.
  const nupkgPath = await download(
    pkg.nupkg.url,
    Path.join(feedDir, entry.fileName),
    pkg.nupkg.size,
    pkg.nupkg.sha256,
    webContents
  )
  if ((await sha1File(nupkgPath)) !== entry.sha1) {
    throw new Error(
      "The update package doesn't match the release's RELEASES file; please try again."
    )
  }

  sendProgress(webContents, {
    phase: 'installing',
    message: 'Installing the update…',
  })

  const { code, output } = await runUpdateExe(
    ['--update', feedDir],
    5 * 60 * 1000
  )
  log.info(`[CustomUpdater] Update.exe --update exited with ${code}`)
  if (output.trim().length > 0) {
    log.info(`[CustomUpdater] Update.exe output:\n${output.slice(-4000)}`)
  }
  if (code !== 0) {
    const lastLine =
      output
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .pop() ?? ''
    const squirrelLog = Path.resolve(
      Path.dirname(process.execPath),
      '..',
      'SquirrelSetup.log'
    )
    return {
      ok: false,
      error: `Installing the update failed (Update.exe exited with ${code})${
        lastLine.length > 0 ? `: ${lastLine}` : '.'
      } Details are in ${squirrelLog}.`,
      manualCommand: null,
    }
  }

  // Squirrel's --processStartAndWait waits for its parent (this app) to
  // exit, then starts the newest installed version.
  sendProgress(webContents, { phase: 'restarting' })
  spawn(
    getSquirrelUpdateExe(),
    ['--processStartAndWait', Path.basename(process.execPath)],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref()

  setTimeout(() => {
    app.quit()
    // If something holds up a normal quit, don't leave Update.exe waiting.
    setTimeout(() => app.exit(0), 10 * 1000)
  }, 500)
  return { ok: true, error: null, manualCommand: null }
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
    if (kind === 'windows-setup' && release.squirrelPackage !== null) {
      return await installWithSquirrel(release, downloadDir, webContents)
    }

    if (kind === 'windows-setup') {
      // Older releases without a Squirrel package: run the full installer.
      const setup = await download(
        asset.url,
        Path.join(downloadDir, asset.name),
        asset.size,
        asset.sha256,
        webContents
      )
      sendProgress(webContents, {
        phase: 'installing',
        message: 'Starting the installer…',
      })
      // Squirrel's Setup.exe installs the new version and then starts it.
      // If this copy were still running at that point, the new one would
      // hand over to it (single instance) and exit — leaving the old
      // version open. So a small helper waits for this process to exit
      // before starting the installer.
      const waitThenInstall = [
        `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
        `Start-Process -FilePath '${setup.replace(/'/g, "''")}'`,
      ].join('; ')
      spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          waitThenInstall,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true }
      ).unref()
      sendProgress(webContents, { phase: 'restarting' })
      setTimeout(() => {
        app.quit()
        // If something holds up a normal quit, don't leave the installer
        // waiting forever.
        setTimeout(() => app.exit(0), 10 * 1000)
      }, 500)
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
        asset.sha256,
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
      asset.sha256,
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
