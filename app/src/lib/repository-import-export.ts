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
export const RepositoryExportVersion = 1

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
}

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

/**
 * Build an export of the given repositories along with their groups, group
 * colors, aliases, locations and remotes.
 */
export async function buildRepositoryExport(
  repositories: ReadonlyArray<Repository>
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

  return {
    format: RepositoryExportFormat,
    version: RepositoryExportVersion,
    exportedAt: new Date().toISOString(),
    platform: process.platform,
    groups: groups.map((g: ICustomRepositoryGroup) => ({
      key: g.id,
      name: g.name,
      color: g.color,
      collapsed: collapsed.has(g.id) || undefined,
    })),
    repositories: exported,
  }
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
  newRoot: string | null
): string {
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
      const targetPath = mapImportPath(source.path, oldRoot, newRoot)
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
