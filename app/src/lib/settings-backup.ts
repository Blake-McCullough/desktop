import { IPipelineNotificationSettings } from './gitlab/pipeline-notifications'
import { ITagColorRule } from './tag-color-rules'
import {
  ShortcutOverrides,
  sanitizeShortcutOverrides,
} from '../models/shortcuts'

/**
 * A backup of this app's own settings (not GitHub Desktop's), to set up
 * another computer. Tokens are never included.
 *
 * Repositories are identified by their remote (host/path) rather than by
 * their id or folder, because those differ between computers.
 */
export interface ISettingsBackup {
  readonly format: typeof SettingsBackupFormat
  readonly version: 1
  readonly exportedAt: string
  readonly appVersion: string
  readonly groups?: IGroupsSection
  readonly notifications?: INotificationsSection
  readonly shortcuts?: IShortcutsSection
  readonly tagColors?: { readonly rules: ReadonlyArray<ITagColorRule> }
  readonly gitlab?: { readonly servers: ReadonlyArray<string> }
  readonly appearance?: IAppearanceSection
}

export const SettingsBackupFormat = 'github-desktop-custom-settings'

/** How a repository is recognised on another computer. */
export interface IRepositoryRef {
  /** e.g. `gitlab.com/acme/payments-api`, or `name:payments-api`. */
  readonly key: string
  /** Its name, shown in the import summary and used as a fallback. */
  readonly name: string
}

export interface IGroupsSection {
  /** In sidebar order. */
  readonly groups: ReadonlyArray<{
    readonly name: string
    readonly color?: string
    readonly collapsed?: boolean
  }>
  readonly repositories: ReadonlyArray<
    IRepositoryRef & { readonly group: string }
  >
}

export interface INotificationsSection {
  readonly defaults: IPipelineNotificationSettings
  readonly repositories: ReadonlyArray<
    IRepositoryRef & { readonly settings: IPipelineNotificationSettings }
  >
}

export interface IShortcutsSection {
  readonly overrides: ShortcutOverrides
  readonly quickSwitcherRepositoriesOnly: boolean
}

export interface IAppearanceSection {
  readonly showRepositoriesSidebar?: boolean
  readonly useSystemMenuBar?: boolean
}

export type SettingsSection =
  | 'groups'
  | 'notifications'
  | 'shortcuts'
  | 'tagColors'
  | 'gitlab'
  | 'appearance'

export const SettingsSections: ReadonlyArray<{
  readonly id: SettingsSection
  readonly label: string
}> = [
  {
    id: 'groups',
    label: 'Sidebar groups, colours and which repositories are in them',
  },
  {
    id: 'notifications',
    label: 'Pipeline notification choices (default and per repository)',
  },
  { id: 'shortcuts', label: 'Keyboard shortcuts and quick switcher options' },
  { id: 'tagColors', label: 'Tag colours' },
  { id: 'gitlab', label: 'GitLab servers (addresses only, no tokens)' },
  { id: 'appearance', label: 'Sidebar and menu bar options' },
]

/**
 * A repository's identity from its remote URL: `host/path` in lower case,
 * without credentials, port, scheme or `.git`. The same repository cloned
 * over SSH or HTTPS gets the same key. Without a remote, its name is used.
 */
export function repositoryKey(remoteUrl: string | null, name: string): string {
  const fallback = `name:${name.toLowerCase()}`
  if (remoteUrl === null || remoteUrl.trim().length === 0) {
    return fallback
  }
  const url = remoteUrl.trim()
  let host: string | null = null
  let path: string | null = null

  // scp-like: git@host:group/project.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url)
  if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return fallback
    }
  }
  if (host === null || path === null || host.length === 0) {
    return fallback
  }
  const cleanPath = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  return cleanPath.length === 0
    ? fallback
    : `${host.toLowerCase()}/${cleanPath}`
}

/** A repository on this computer, with the key from its remote. */
export interface ILocalRepositoryRef extends IRepositoryRef {
  readonly id: number
}

/**
 * Match backed-up repositories to ones on this computer: by remote first,
 * then by name when exactly one local repository has that name.
 */
export function matchRepositories<T extends IRepositoryRef>(
  entries: ReadonlyArray<T>,
  local: ReadonlyArray<ILocalRepositoryRef>
): {
  readonly matched: ReadonlyArray<{ readonly entry: T; readonly id: number }>
  readonly unmatched: ReadonlyArray<T>
} {
  const byKey = new Map<string, Array<ILocalRepositoryRef>>()
  const byName = new Map<string, Array<ILocalRepositoryRef>>()
  for (const repo of local) {
    byKey.set(repo.key, [...(byKey.get(repo.key) ?? []), repo])
    const name = repo.name.toLowerCase()
    byName.set(name, [...(byName.get(name) ?? []), repo])
  }

  const matched = new Array<{ entry: T; id: number }>()
  const unmatched = new Array<T>()
  for (const entry of entries) {
    const viaKey = byKey.get(entry.key) ?? []
    const viaName = byName.get(entry.name.toLowerCase()) ?? []
    // The same remote can be cloned twice (e.g. worktrees): match them all.
    const targets =
      viaKey.length > 0 ? viaKey : viaName.length === 1 ? viaName : []
    if (targets.length === 0) {
      unmatched.push(entry)
    }
    for (const target of targets) {
      matched.push({ entry, id: target.id })
    }
  }
  return { matched, unmatched }
}

/* -------------------------------- parsing -------------------------------- */

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isHexColor = (v: unknown): v is string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

function readRef(v: Record<string, unknown>): IRepositoryRef | null {
  return typeof v.key === 'string' && typeof v.name === 'string'
    ? { key: v.key, name: v.name }
    : null
}

function readNotificationSettings(
  v: unknown
): IPipelineNotificationSettings | null {
  if (!isObject(v)) {
    return null
  }
  return {
    passed: v.passed === true,
    failed: v.failed === true,
    manual: v.manual === true,
  }
}

/**
 * Read a backup file's contents, keeping only well-formed parts. Throws
 * with a readable message when it isn't a settings backup at all.
 */
export function parseSettingsBackup(text: string): ISettingsBackup {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("This file isn't a settings backup (it isn't JSON).")
  }
  if (!isObject(raw) || raw.format !== SettingsBackupFormat) {
    throw new Error(
      "This file isn't a settings backup from this app. (Repository lists are imported from the repositories sidebar instead.)"
    )
  }
  if (raw.version !== 1) {
    throw new Error(
      `This backup was made by a newer version of the app (format ${String(
        raw.version
      )}). Update the app and try again.`
    )
  }

  const backup: {
    -readonly [K in keyof ISettingsBackup]: ISettingsBackup[K]
  } = {
    format: SettingsBackupFormat,
    version: 1,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
  }

  if (isObject(raw.groups)) {
    const groups = (Array.isArray(raw.groups.groups) ? raw.groups.groups : [])
      .filter(isObject)
      .filter(g => typeof g.name === 'string' && g.name.trim().length > 0)
      .map(g => ({
        name: String(g.name).trim(),
        color: isHexColor(g.color) ? g.color : undefined,
        collapsed: g.collapsed === true,
      }))
    const repositories = (
      Array.isArray(raw.groups.repositories) ? raw.groups.repositories : []
    )
      .filter(isObject)
      .map(r => {
        const ref = readRef(r)
        return ref !== null && typeof r.group === 'string'
          ? { ...ref, group: r.group }
          : null
      })
      .filter(<T>(r: T | null): r is T => r !== null)
    backup.groups = { groups, repositories }
  }

  if (isObject(raw.notifications)) {
    const defaults = readNotificationSettings(raw.notifications.defaults)
    if (defaults !== null) {
      const repositories = (
        Array.isArray(raw.notifications.repositories)
          ? raw.notifications.repositories
          : []
      )
        .filter(isObject)
        .map(r => {
          const ref = readRef(r)
          const settings = readNotificationSettings(r.settings)
          return ref !== null && settings !== null ? { ...ref, settings } : null
        })
        .filter(<T>(r: T | null): r is T => r !== null)
      backup.notifications = { defaults, repositories }
    }
  }

  if (isObject(raw.shortcuts)) {
    backup.shortcuts = {
      overrides: sanitizeShortcutOverrides(raw.shortcuts.overrides),
      quickSwitcherRepositoriesOnly:
        raw.shortcuts.quickSwitcherRepositoriesOnly === true,
    }
  }

  if (isObject(raw.tagColors) && Array.isArray(raw.tagColors.rules)) {
    backup.tagColors = {
      rules: raw.tagColors.rules
        .filter(isObject)
        .filter(r => typeof r.pattern === 'string' && isHexColor(r.color))
        .map((r, i) => ({
          id: typeof r.id === 'string' ? r.id : `imported-${i}`,
          pattern: String(r.pattern),
          color: String(r.color),
        })),
    }
  }

  if (isObject(raw.gitlab) && Array.isArray(raw.gitlab.servers)) {
    backup.gitlab = {
      servers: raw.gitlab.servers.filter(
        (s): s is string => typeof s === 'string' && /^https?:\/\//.test(s)
      ),
    }
  }

  if (isObject(raw.appearance)) {
    const a = raw.appearance
    backup.appearance = {
      showRepositoriesSidebar:
        typeof a.showRepositoriesSidebar === 'boolean'
          ? a.showRepositoriesSidebar
          : undefined,
      useSystemMenuBar:
        typeof a.useSystemMenuBar === 'boolean'
          ? a.useSystemMenuBar
          : undefined,
    }
  }

  return backup
}

/** Which sections a backup actually has. */
export function getBackupSections(
  backup: ISettingsBackup
): ReadonlyArray<SettingsSection> {
  return SettingsSections.map(s => s.id).filter(id => backup[id] !== undefined)
}
