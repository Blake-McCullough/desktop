import * as semver from 'semver'

/**
 * Updates for this custom build come from this repository's GitHub
 * releases (published by the "Auto release (main)" workflow), not from
 * GitHub's own update server.
 */
export const CustomUpdateRepository = 'Blake-McCullough/desktop'

/**
 * How this copy of the app was installed, which decides what an update
 * downloads and how it's installed.
 */
export type CustomInstallKind =
  /** Windows, installed with GitHubDesktopCustomSetup-x64.exe. */
  | 'windows-setup'
  /** Arch Linux / CachyOS package in /opt/github-desktop-custom. */
  | 'pacman'
  /** Linux AppImage. */
  | 'appimage'
  /** Anything else (unpacked tarball, a local build, macOS): open the release page. */
  | 'manual'

export interface ICustomReleaseAsset {
  readonly name: string
  readonly url: string
  readonly size: number
  /** Lower-case hex SHA-256 from GitHub, when it provides one. */
  readonly sha256: string | null
}

export interface ICustomRelease {
  readonly version: string
  readonly tag: string
  readonly name: string
  readonly notes: string
  readonly htmlUrl: string
  readonly publishedAt: string
  /** The file to install for this install kind, if the release has one. */
  readonly asset: ICustomReleaseAsset | null
  /**
   * Windows: the Squirrel package and its RELEASES index, used to update in
   * place with Update.exe (the way GitHub Desktop updates itself). Null when
   * the release doesn't have them; then the Setup.exe in `asset` is used.
   */
  readonly squirrelPackage: ISquirrelPackage | null
}

export interface ISquirrelPackage {
  readonly nupkg: ICustomReleaseAsset
  readonly releases: ICustomReleaseAsset
}

export interface ICustomUpdateCheckResult {
  readonly currentVersion: string
  readonly installKind: CustomInstallKind
  readonly latest: ICustomRelease | null
  readonly isUpdateAvailable: boolean
  readonly error: string | null
}

export type CustomUpdateProgress =
  | {
      readonly phase: 'downloading'
      readonly received: number
      readonly total: number
    }
  | { readonly phase: 'installing'; readonly message: string }
  | { readonly phase: 'restarting' }

export interface ICustomUpdateInstallResult {
  /** Whether the app is about to quit/restart into the new version. */
  readonly ok: boolean
  readonly error: string | null
  /** A command the user can run themselves if installing failed. */
  readonly manualCommand: string | null
}

/** The bits of a GitHub release (REST API) that we use. */
export interface IGitHubReleaseJson {
  readonly tag_name: string
  readonly name: string | null
  readonly body: string | null
  readonly html_url: string
  readonly published_at: string | null
  readonly draft: boolean
  readonly prerelease: boolean
  readonly assets: ReadonlyArray<{
    readonly name: string
    readonly browser_download_url: string
    readonly size: number
    /** e.g. "sha256:1f2e…" (GitHub fills this in for newer uploads). */
    readonly digest?: string | null
  }>
}

/** `v3.6.11-custom1-b00006` → `3.6.11-custom1-b00006`, or null if not a version. */
export function versionFromTag(tag: string): string | null {
  const version = tag.replace(/^v/, '')
  return semver.valid(version)
}

/**
 * Whether `latest` is newer than `current`. Build numbers are zero-padded,
 * so they also compare correctly as prerelease text.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const l = semver.valid(latest)
  const c = semver.valid(current)
  if (l === null || c === null) {
    return false
  }
  return semver.gt(l, c)
}

/** Pick the release file that fits how the app is installed. */
export function selectAsset(
  assets: IGitHubReleaseJson['assets'],
  kind: CustomInstallKind,
  platform: NodeJS.Platform,
  arch: string
): ICustomReleaseAsset | null {
  const linuxArch = arch === 'arm64' ? 'arm64' : 'x64'
  const pattern =
    kind === 'windows-setup' || (kind === 'manual' && platform === 'win32')
      ? /^GitHubDesktopCustomSetup-x64\.exe$/
      : kind === 'pacman'
      ? /\.pkg\.tar\.zst$/
      : kind === 'appimage'
      ? new RegExp(`-${linuxArch}\\.AppImage$`)
      : platform === 'linux'
      ? new RegExp(`-linux-${linuxArch}\\.tar\\.gz$`)
      : null

  if (pattern === null) {
    return null
  }

  const asset = assets.find(a => pattern.test(a.name))
  return asset === undefined ? null : toAsset(asset)
}

function toAsset(
  asset: IGitHubReleaseJson['assets'][number]
): ICustomReleaseAsset {
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: digest !== null ? digest[1].toLowerCase() : null,
  }
}

/** The full Squirrel package and RELEASES file, for in-place Windows updates. */
export function selectSquirrelPackage(
  assets: IGitHubReleaseJson['assets'],
  kind: CustomInstallKind,
  arch: string
): ISquirrelPackage | null {
  if (kind !== 'windows-setup' || arch !== 'x64') {
    return null
  }
  const nupkg = assets.find(a => /-x64-full\.nupkg$/.test(a.name))
  const releases = assets.find(a => a.name === 'RELEASES')
  return nupkg === undefined || releases === undefined
    ? null
    : { nupkg: toAsset(nupkg), releases: toAsset(releases) }
}

/** A package entry in a Squirrel RELEASES file. */
export interface ISquirrelReleaseEntry {
  readonly sha1: string
  /** The file name Squirrel will look for next to RELEASES. */
  readonly fileName: string
  readonly size: number
}

/**
 * Find the full package we downloaded in a Squirrel RELEASES file, whose
 * lines are `<SHA1> <file name> <size>`.
 *
 * The release uploads the package with an architecture in its name
 * (`…-x64-full.nupkg`) while RELEASES uses the name Squirrel built it with
 * (`…-full.nupkg`), so it's matched on size and being a full package, and the
 * download must be saved as `fileName`. Returns null if nothing matches.
 */
export function findInSquirrelReleases(
  releasesText: string,
  nupkgName: string,
  nupkgSize: number
): ISquirrelReleaseEntry | null {
  const entries: ISquirrelReleaseEntry[] = []
  for (const line of releasesText.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\s+(\S+)\s+(\d+)$/i.exec(line.trim())
    if (match !== null) {
      entries.push({
        sha1: match[1].toLowerCase(),
        fileName: match[2],
        size: Number(match[3]),
      })
    }
  }

  const sized = entries.filter(
    e =>
      e.size === nupkgSize &&
      /-full\.nupkg$/.test(e.fileName) &&
      // Only a plain file name; never a path.
      /^[\w.+-]+$/.test(e.fileName)
  )
  return (
    sized.find(e => e.fileName === nupkgName) ??
    (sized.length === 1 ? sized[0] : null)
  )
}

/** Turn a GitHub release into what the update UI needs. */
export function toCustomRelease(
  json: IGitHubReleaseJson,
  kind: CustomInstallKind,
  platform: NodeJS.Platform,
  arch: string
): ICustomRelease | null {
  const version = versionFromTag(json.tag_name)
  if (version === null || json.draft) {
    return null
  }

  return {
    version,
    tag: json.tag_name,
    name: json.name ?? json.tag_name,
    notes: json.body ?? '',
    htmlUrl: json.html_url,
    publishedAt: json.published_at ?? '',
    asset: selectAsset(json.assets, kind, platform, arch),
    squirrelPackage: selectSquirrelPackage(json.assets, kind, arch),
  }
}

/**
 * The part of a release's notes worth showing in the app: the list of
 * changes (not the install instructions), with Markdown emphasis removed.
 */
export function summarizeReleaseNotes(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const changes = lines.findIndex(l => /^#{1,6}\s.*change/i.test(l))
  const relevant = changes === -1 ? lines : lines.slice(changes + 1)

  return relevant
    .map(l =>
      l
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*[-*]\s+/, '• ')
    )
    .join('\n')
    .trim()
}
