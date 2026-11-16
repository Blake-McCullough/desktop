import * as Path from 'path'
import { stat, readFile, writeFile } from 'fs/promises'
import { Repository } from '../models/repository'
import { getRemotes } from './git/remote'
import {
  ICustomRepositoryGroup,
  getCollapsedGroupIds,
  getCustomGroups,
  getRepositoryGroupAssignments,
} from '../ui/repositories-list/custom-repository-groups-store'

/** Identifies files written by `exportRepositories`. */
export const RepositoryExportFormat = 'github-desktop-custom/repositories'
/**
 * Version 2 adds `relativePaths`. Files without relative paths are still
 * written as version 1 so older versions of the app can import them.
 */
export const RepositoryExportVersion = 2

export interface IExportedRemote {
  readonly name: string
  readonly url: string
}

export interface IExportedGroup {
  /** Identifier used to link repositories to this group within the file. */
  readonly key: string
  readonly name: string
  readonly color?: string
  readonly collapsed?: boolean
}

export interface IExportedRepository {
  readonly name: string
  readonly alias: string | null
  /** Absolute path on the machine the export was made on. */
  readonly path: string
  /** `key` of the group this repository was in, or `null`. */
  readonly group: string | null
  readonly remotes: ReadonlyArray<IExportedRemote>
}

export interface IRepositoryExportFile {
  readonly format: typeof RepositoryExportFormat
  readonly version: number
  readonly exportedAt: string
  readonly platform: string
  readonly groups: ReadonlyArray<IExportedGroup>
  readonly repositories: ReadonlyArray<IExportedRepository>
  /**
   * When true, repository paths are relative (with `/` separators), and the
   * importer chooses the folder they go under.
   */
  readonly relativePaths?: boolean
}

/** What to put in an export. */
export interface IRepositoryExportOptions {
  /**
   * `full`: absolute paths. `relative`: paths below the repositories'
   * shared folder, which keeps the layout without revealing where it was.
   */
  readonly location: 'full' | 'relative'
  /** Every remote, only `origin` (or the first), or none. */
  readonly remotes: 'all' | 'origin' | 'none'
  /** Drop usernames, passwords and tokens embedded in remote URLs. */
  readonly stripRemoteCredentials: boolean
  readonly groups: boolean
  /** Group colors and collapsed state (only with `groups`). */
  readonly groupStyle: boolean
  readonly aliases: boolean
  /** Leave out groups none of the exported repositories are in. */
  readonly onlyUsedGroups: boolean
}

/** Everything, as the quick "Export repositories…" has always written. */
export const FullRepositoryExport: IRepositoryExportOptions = {
  location: 'full',
  remotes: 'all',
  stripRemoteCredentials: false,
  groups: true,
  groupStyle: true,
  aliases: true,
  onlyUsedGroups: false,
}

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

/**
 * Build an export of the given repositories along with their groups, group
 * colors, aliases, locations and remotes.
 */
export async function buildRepositoryExport(
  repositories: ReadonlyArray<Repository>,
  options: IRepositoryExportOptions = FullRepositoryExport
): Promise<IRepositoryExportFile> {
  const groups = getCustomGroups()
  const assignments = getRepositoryGroupAssignments()
  const collapsed = getCollapsedGroupIds()
  const validGroupIds = new Set(groups.map(g => g.id))

  const exported: Array<IExportedRepository> = []
  // A handful at a time — each one spawns git.
  const queue = [...repositories]
  const worker = async () => {
    for (let r = queue.shift(); r !== undefined; r = queue.shift()) {
      exported.push(await exportRepository(r, assignments, validGroupIds))
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))

  exported.sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
  )

  return applyExportOptions(
    {
      format: RepositoryExportFormat,
      version: 1,
      exportedAt: new Date().toISOString(),
      platform: process.platform,
      groups: groups.map((g: ICustomRepositoryGroup) => ({
        key: g.id,
        name: g.name,
        color: g.color,
        collapsed: collapsed.has(g.id) || undefined,
      })),
      repositories: exported,
    },
    options
  )
}

/** Remove `user:password@` from a URL; other URLs are returned unchanged. */
export function stripUrlCredentials(url: string): string {
  // scp-style `git@host:path` has a user but never a secret; leave it.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url
  }
  try {
    const parsed = new URL(url)
    if (parsed.username === '' && parsed.password === '') {
      return url
    }
    // Keep `ssh://git@host/...`'s user, which is part of the address.
    if (parsed.protocol === 'ssh:' && parsed.password === '') {
      return url
    }
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return url
  }
}

/** Express `path` relative to `root`, with `/` separators. */
function relativeTo(path: string, root: string | null): string {
  const parts = splitPath(path)
  const rootParts = root === null ? [] : splitPath(root)
  const isUnder =
    rootParts.length > 0 &&
    rootParts.length < parts.length &&
    rootParts.every((segment, i) => samePathSegment(segment, parts[i]))
  return isUnder
    ? parts.slice(rootParts.length).join('/')
    : parts[parts.length - 1] ?? path
}

/** Trim a full export down to what the options ask for. Exported for tests. */
export function applyExportOptions(
  data: IRepositoryExportFile,
  options: IRepositoryExportOptions
): IRepositoryExportFile {
  const root =
    options.location === 'relative'
      ? getCommonRoot(data.repositories.map(r => r.path))
      : null

  const repositories = data.repositories.map(r => {
    let remotes = r.remotes
    if (options.remotes === 'none') {
      remotes = []
    } else if (options.remotes === 'origin' && remotes.length > 0) {
      remotes = [remotes.find(x => x.name === 'origin') ?? remotes[0]]
    }
    if (options.stripRemoteCredentials) {
      remotes = remotes.map(x => ({ ...x, url: stripUrlCredentials(x.url) }))
    }

    return {
      name: r.name,
      alias: options.aliases ? r.alias : null,
      path: options.location === 'relative' ? relativeTo(r.path, root) : r.path,
      group: options.groups ? r.group : null,
      remotes,
    }
  })

  const usedGroups = new Set(repositories.map(r => r.group))
  const groups = !options.groups
    ? []
    : data.groups
        .filter(g => !options.onlyUsedGroups || usedGroups.has(g.key))
        .map(g => (options.groupStyle ? g : { key: g.key, name: g.name }))

  const relative = options.location === 'relative'
  return {
    ...data,
    // Older versions can't import relative paths, so only those files need
    // the newer version.
    version: relative ? RepositoryExportVersion : 1,
    groups,
    repositories,
    ...(relative ? { relativePaths: true } : {}),
  }
}

/** The CSV columns for an export, in order. */
export function getCsvColumns(
  options: IRepositoryExportOptions
): ReadonlyArray<string> {
  return [
    'Name',
    ...(options.aliases ? ['Alias'] : []),
    'Path',
    ...(options.groups ? ['Group'] : []),
    ...(options.groups && options.groupStyle ? ['Group color'] : []),
    ...(options.remotes === 'origin' ? ['Remote URL'] : []),
    ...(options.remotes === 'all' ? ['Remotes'] : []),
  ]
}

function csvCell(value: string): string {
  // Spreadsheets run cells starting with these as formulas.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * The export as CSV (for spreadsheets), with the columns the options
 * include. Not importable.
 */
export function buildRepositoryCsv(
  data: IRepositoryExportFile,
  options: IRepositoryExportOptions
): string {
  const groups = new Map(data.groups.map(g => [g.key, g]))
  const rows = data.repositories.map(r => {
    const group = r.group === null ? undefined : groups.get(r.group)
    return [
      r.name,
      ...(options.aliases ? [r.alias ?? ''] : []),
      r.path,
      ...(options.groups ? [group?.name ?? ''] : []),
      ...(options.groups && options.groupStyle ? [group?.color ?? ''] : []),
      ...(options.remotes === 'origin' ? [r.remotes[0]?.url ?? ''] : []),
      ...(options.remotes === 'all'
        ? [r.remotes.map(x => `${x.name}=${x.url}`).join(' ')]
        : []),
    ]
  })
  return (
    [getCsvColumns(options), ...rows]
      .map(row => row.map(csvCell).join(','))
      .join('\r\n') + '\r\n'
  )
}

async function exportRepository(
  repository: Repository,
  assignments: ReadonlyMap<number, string>,
  validGroupIds: ReadonlySet<string>
): Promise<IExportedRepository> {
  let remotes: ReadonlyArray<IExportedRemote> = []

  if (!repository.missing) {
    try {
      remotes = (await getRemotes(repository)).map(r => ({
        name: r.name,
        url: r.url,
      }))
    } catch (e) {
      log.warn(`[Export] couldn't read remotes for '${repository.name}'`, e)
    }
  }

  // Fall back to what we know about the GitHub repository, e.g. when the
  // repository is missing on disk.
  if (remotes.length === 0 && repository.gitHubRepository?.cloneURL) {
    remotes = [{ name: 'origin', url: repository.gitHubRepository.cloneURL }]
  }

  const groupId = assignments.get(repository.id)

  return {
    name: repository.name,
    alias: repository.alias,
    path: repository.path,
    group: groupId !== undefined && validGroupIds.has(groupId) ? groupId : null,
    remotes,
  }
}

/** Write an export to disk as pretty-printed JSON. */
export async function writeRepositoryExport(
  path: string,
  data: IRepositoryExportFile
) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/* ---------------------------------------------------------------------------
 * Import
 * ------------------------------------------------------------------------- */

/**
 * Read and validate an export file. Throws with a user-presentable message
 * when the file isn't a valid export.
 */
export async function readRepositoryExport(
  path: string
): Promise<IRepositoryExportFile> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    throw new Error(`That file isn't valid JSON: ${e.message}`)
  }

  return parseRepositoryExport(raw)
}

const isString = (v: unknown): v is string => typeof v === 'string'

/** Validate parsed JSON as an export file. Exported for tests. */
export function parseRepositoryExport(raw: unknown): IRepositoryExportFile {
  const data = raw as Partial<IRepositoryExportFile> | null
  if (
    data === null ||
    typeof data !== 'object' ||
    data.format !== RepositoryExportFormat
  ) {
    throw new Error("That file isn't a repository export from GitHub Desktop.")
  }

  if (
    typeof data.version !== 'number' ||
    data.version > RepositoryExportVersion
  ) {
    throw new Error(
      'That export was made by a newer version of the app. Update and try again.'
    )
  }

  const groups: Array<IExportedGroup> = []
  for (const g of Array.isArray(data.groups) ? data.groups : []) {
    if (g && isString(g.key) && isString(g.name) && g.name.trim().length > 0) {
      groups.push({
        key: g.key,
        name: g.name.trim(),
        color:
          isString(g.color) && /^#[0-9a-f]{6}$/i.test(g.color)
            ? g.color
            : undefined,
        collapsed: g.collapsed === true,
      })
    }
  }

  const groupKeys = new Set(groups.map(g => g.key))
  const repositories: Array<IExportedRepository> = []
  for (const r of Array.isArray(data.repositories) ? data.repositories : []) {
    if (!r || !isString(r.path) || r.path.length === 0) {
      continue
    }
    repositories.push({
      name: isString(r.name) ? r.name : basename(r.path),
      alias: isString(r.alias) && r.alias.length > 0 ? r.alias : null,
      path: r.path,
      group: isString(r.group) && groupKeys.has(r.group) ? r.group : null,
      remotes: (Array.isArray(r.remotes)
        ? (r.remotes as ReadonlyArray<unknown>)
        : []
      ).filter(
        (x: any): x is IExportedRemote =>
          !!x && isString(x.name) && isString(x.url) && x.url.length > 0
      ),
    })
  }

  return {
    format: RepositoryExportFormat,
    version: data.version,
    exportedAt: isString(data.exportedAt) ? data.exportedAt : '',
    platform: isString(data.platform) ? data.platform : '',
    groups,
    repositories,
    relativePaths: data.relativePaths === true,
  }
}

/** Split a path from any platform into its segments. */
function splitPath(path: string): Array<string> {
  return path.split(/[\\/]+/).filter(s => s.length > 0)
}

function basename(path: string) {
  const parts = splitPath(path)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/** Whether paths on this platform should be compared case-insensitively. */
const caseInsensitivePaths = __WIN32__ || __DARWIN__

function samePathSegment(a: string, b: string) {
  return caseInsensitivePaths ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The deepest folder that contains every exported repository, as it was on
 * the exporting machine (e.g. `C:\Users\Blake\Documents\GitHub`). `null`
 * when there's no common parent.
 */
export function getCommonRoot(paths: ReadonlyArray<string>): string | null {
  if (paths.length === 0) {
    return null
  }

  const split = paths.map(p => splitPath(Path.dirname(p.replace(/\\/g, '/'))))
  const first = split[0]
  let length = first.length

  for (const parts of split.slice(1)) {
    let i = 0
    while (
      i < length &&
      i < parts.length &&
      samePathSegment(parts[i], first[i])
    ) {
      i++
    }
    length = i
  }

  if (length === 0) {
    return null
  }

  // Rebuild using the original string so drive letters/leading slashes and
  // separators look the way they did on the exporting machine.
  const original = paths[0]
  const separator = original.includes('\\') ? '\\' : '/'
  const prefix = original.startsWith('/') ? '/' : ''
  return prefix + first.slice(0, length).join(separator)
}

/**
 * Work out where an exported repository should live on this machine.
 *
 * If `newRoot` is given, the repository's path relative to `oldRoot` is
 * placed under `newRoot` (so `C:\code\a\b` exported with root `C:\code`
 * becomes `/Users/me/src/a/b` when imported with root `/Users/me/src`).
 * Otherwise the original path is used as is.
 */
export function mapImportPath(
  originalPath: string,
  oldRoot: string | null,
  newRoot: string | null,
  relative = false
): string {
  if (relative) {
    // Relative paths always go under the chosen folder (`..` can't escape).
    const parts = splitPath(originalPath).filter(p => p !== '.' && p !== '..')
    return newRoot === null || newRoot.trim().length === 0
      ? parts.join(Path.sep)
      : Path.join(newRoot, ...parts)
  }

  if (oldRoot === null || newRoot === null || newRoot.trim().length === 0) {
    return Path.normalize(originalPath)
  }

  const original = splitPath(originalPath)
  const root = splitPath(oldRoot)
  const isUnderRoot =
    root.length <= original.length &&
    root.every((segment, i) => samePathSegment(segment, original[i]))

  if (!isUnderRoot) {
    return Path.normalize(originalPath)
  }

  return Path.join(newRoot, ...original.slice(root.length))
}

/** What importing a single repository will do. */
export type ImportAction =
  /** Already in the app — only the group/alias will be applied. */
  | 'already-added'
  /** Found on disk — will be added. */
  | 'add'
  /** Not on disk — will be cloned from its remote. */
  | 'clone'
  /** Not on disk and there's no remote to clone from. */
  | 'unavailable'

export interface IImportPlanEntry {
  readonly source: IExportedRepository
  readonly targetPath: string
  readonly action: ImportAction
  readonly cloneUrl: string | null
  /** The repository already in the app at `targetPath`, if any. */
  readonly existing: Repository | null
}

function normalizeForCompare(path: string) {
  const normalized = Path.resolve(path).replace(/[\\/]+$/, '')
  return caseInsensitivePaths ? normalized.toLowerCase() : normalized
}

async function isGitRepository(path: string): Promise<boolean> {
  try {
    // `.git` is a directory for regular repositories and a file for
    // worktrees and submodules.
    await stat(Path.join(path, '.git'))
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Decide what to do with each repository in an export. */
export async function planImport(
  data: IRepositoryExportFile,
  oldRoot: string | null,
  newRoot: string | null,
  existingRepositories: ReadonlyArray<Repository>
): Promise<ReadonlyArray<IImportPlanEntry>> {
  const existingByPath = new Map<string, Repository>()
  for (const repository of existingRepositories) {
    existingByPath.set(normalizeForCompare(repository.path), repository)
  }

  return Promise.all(
    data.repositories.map(async source => {
      const relative = data.relativePaths === true
      const targetPath = mapImportPath(source.path, oldRoot, newRoot, relative)
      if (relative && (newRoot === null || newRoot.trim().length === 0)) {
        // Nowhere to put it until a folder is chosen.
        return {
          source,
          targetPath,
          action: 'unavailable' as const,
          cloneUrl: null,
          existing: null,
        }
      }
      const existing =
        existingByPath.get(normalizeForCompare(targetPath)) ?? null
      const origin =
        source.remotes.find(r => r.name === 'origin') ?? source.remotes[0]
      const cloneUrl = origin?.url ?? null

      let action: ImportAction
      if (existing !== null && !existing.missing) {
        action = 'already-added'
      } else if (await isGitRepository(targetPath)) {
        action = 'add'
      } else if (cloneUrl !== null && !(await pathExists(targetPath))) {
        action = 'clone'
      } else {
        // Either no remote, or something that isn't a repository is
        // already in the way at the target path.
        action = 'unavailable'
      }

      return { source, targetPath, action, cloneUrl, existing }
    })
  )
}
