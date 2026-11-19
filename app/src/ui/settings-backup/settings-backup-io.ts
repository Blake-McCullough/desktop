import { Repository } from '../../models/repository'
import { getRemotes } from '../../lib/git'
import {
  ILocalRepositoryRef,
  ISettingsBackup,
  SettingsBackupFormat,
  SettingsSection,
  matchRepositories,
  repositoryKey,
} from '../../lib/settings-backup'
import {
  findOrCreateGroupByName,
  getCollapsedGroupIds,
  getCustomGroups,
  getRepositoryGroupAssignments,
  getShowRepositoriesSidebar,
  setGroupCollapsed,
  setRepositoryGroups,
  setShowRepositoriesSidebar,
} from '../repositories-list/custom-repository-groups-store'
import {
  getDefaultPipelineNotificationSettings,
  getRepositoryPipelineNotificationOverride,
  setDefaultPipelineNotificationSettings,
  setRepositoryPipelineNotificationOverride,
} from '../../lib/gitlab/pipeline-notifications'
import {
  getQuickSwitcherRepositoriesOnly,
  getShortcutOverrides,
  setQuickSwitcherRepositoriesOnly,
} from '../../lib/shortcut-settings'
import { getTagColorRules, setTagColorRules } from '../../lib/tag-color-rules'
import {
  getGitLabInstanceUrls,
  setGitLabInstanceUrls,
} from '../../lib/gitlab/gitlab-token'
import {
  getUseSystemMenuBar,
  setUseSystemMenuBar,
} from '../../lib/linux-menu-bar'
import { Dispatcher } from '../dispatcher'

/**
 * Each repository with the key it's known by in backups (from its origin
 * remote, or any remote, or its name).
 */
export async function getLocalRepositoryRefs(
  repositories: ReadonlyArray<Repository>
): Promise<ReadonlyArray<ILocalRepositoryRef>> {
  return Promise.all(
    repositories.map(async repository => {
      let url: string | null = null
      try {
        const remotes = await getRemotes(repository)
        url =
          (remotes.find(r => r.name === 'origin') ?? remotes[0])?.url ?? null
      } catch {
        // Missing folder or not a repository any more: use the name.
      }
      return {
        id: repository.id,
        key: repositoryKey(url, repository.name),
        name: repository.name,
      }
    })
  )
}

/** Build a backup of the chosen sections. */
export function buildSettingsBackup(
  sections: ReadonlySet<SettingsSection>,
  local: ReadonlyArray<ILocalRepositoryRef>,
  appVersion: string
): ISettingsBackup {
  const byId = new Map(local.map(r => [r.id, r]))
  const ref = (id: number) => {
    const r = byId.get(id)
    return r === undefined ? null : { key: r.key, name: r.name }
  }

  let backup: ISettingsBackup = {
    format: SettingsBackupFormat,
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion,
  }

  if (sections.has('groups')) {
    const groups = getCustomGroups()
    const collapsed = getCollapsedGroupIds()
    const names = new Map(groups.map(g => [g.id, g.name]))
    const repositories = [...getRepositoryGroupAssignments()]
      .map(([id, groupId]) => {
        const r = ref(id)
        const group = names.get(groupId)
        return r === null || group === undefined ? null : { ...r, group }
      })
      .filter(<T>(r: T | null): r is T => r !== null)
    backup = {
      ...backup,
      groups: {
        groups: groups.map(g => ({
          name: g.name,
          color: g.color,
          collapsed: collapsed.has(g.id),
        })),
        repositories,
      },
    }
  }

  if (sections.has('notifications')) {
    const repositories = local
      .map(r => {
        const settings = getRepositoryPipelineNotificationOverride(r.id)
        return settings === null ? null : { key: r.key, name: r.name, settings }
      })
      .filter(<T>(r: T | null): r is T => r !== null)
    backup = {
      ...backup,
      notifications: {
        defaults: getDefaultPipelineNotificationSettings(),
        repositories,
      },
    }
  }

  if (sections.has('shortcuts')) {
    backup = {
      ...backup,
      shortcuts: {
        overrides: getShortcutOverrides(),
        quickSwitcherRepositoriesOnly: getQuickSwitcherRepositoriesOnly(),
      },
    }
  }

  if (sections.has('tagColors')) {
    backup = { ...backup, tagColors: { rules: getTagColorRules() } }
  }

  if (sections.has('gitlab')) {
    backup = { ...backup, gitlab: { servers: getGitLabInstanceUrls() } }
  }

  if (sections.has('appearance')) {
    backup = {
      ...backup,
      appearance: {
        showRepositoriesSidebar: getShowRepositoriesSidebar(),
        useSystemMenuBar: __LINUX__ ? getUseSystemMenuBar() : undefined,
      },
    }
  }

  return backup
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** What importing a section would do, for the import dialog. */
export function describeImport(
  backup: ISettingsBackup,
  section: SettingsSection,
  local: ReadonlyArray<ILocalRepositoryRef>
): string {
  switch (section) {
    case 'groups': {
      const g = backup.groups
      if (g === undefined) {
        return ''
      }
      const { matched, unmatched } = matchRepositories(g.repositories, local)
      const found = new Set(matched.map(m => m.entry)).size
      return `${plural(g.groups.length, 'group', 'groups')}; ${found} of ${
        g.repositories.length
      } repositories found here${
        unmatched.length > 0
          ? ` (not found: ${unmatched
              .slice(0, 5)
              .map(u => u.name)
              .join(', ')}${unmatched.length > 5 ? '…' : ''})`
          : ''
      }. Groups with the same name are merged.`
    }
    case 'notifications': {
      const n = backup.notifications
      if (n === undefined) {
        return ''
      }
      const found = new Set(
        matchRepositories(n.repositories, local).matched.map(m => m.entry)
      ).size
      return `Defaults, plus ${found} of ${n.repositories.length} repository-specific choices.`
    }
    case 'shortcuts':
      return `${plural(
        Object.keys(backup.shortcuts?.overrides ?? {}).length,
        'changed shortcut',
        'changed shortcuts'
      )}. Replaces your current shortcuts.`
    case 'tagColors':
      return `${plural(
        backup.tagColors?.rules.length ?? 0,
        'rule',
        'rules'
      )}. Replaces your current tag colours.`
    case 'gitlab':
      return `${plural(
        backup.gitlab?.servers.length ?? 0,
        'server',
        'servers'
      )}, added to yours. Add their tokens afterwards in Options → GitLab.`
    case 'appearance':
      return (
        'Whether the repositories sidebar is shown' +
        (__LINUX__ ? ' and which menu bar is used.' : '.')
      )
  }
}

/** Apply the chosen sections of a backup. */
export function applySettingsBackup(
  backup: ISettingsBackup,
  sections: ReadonlySet<SettingsSection>,
  local: ReadonlyArray<ILocalRepositoryRef>,
  dispatcher: Dispatcher
) {
  if (sections.has('groups') && backup.groups !== undefined) {
    const ids = new Map<string, string>()
    for (const g of backup.groups.groups) {
      const group = findOrCreateGroupByName(g.name, g.color)
      ids.set(g.name.toLowerCase(), group.id)
      if (g.collapsed === true) {
        setGroupCollapsed(group.id, true)
      }
    }
    const { matched } = matchRepositories(backup.groups.repositories, local)
    setRepositoryGroups(
      matched.map(m => ({
        repositoryId: m.id,
        groupId:
          ids.get(m.entry.group.toLowerCase()) ??
          findOrCreateGroupByName(m.entry.group).id,
      }))
    )
  }

  if (sections.has('notifications') && backup.notifications !== undefined) {
    setDefaultPipelineNotificationSettings(backup.notifications.defaults)
    const { matched } = matchRepositories(
      backup.notifications.repositories,
      local
    )
    for (const m of matched) {
      setRepositoryPipelineNotificationOverride(m.id, m.entry.settings)
    }
  }

  if (sections.has('shortcuts') && backup.shortcuts !== undefined) {
    dispatcher.setShortcutOverrides(backup.shortcuts.overrides)
    setQuickSwitcherRepositoriesOnly(
      backup.shortcuts.quickSwitcherRepositoriesOnly
    )
  }

  if (sections.has('tagColors') && backup.tagColors !== undefined) {
    setTagColorRules(backup.tagColors.rules)
  }

  if (sections.has('gitlab') && backup.gitlab !== undefined) {
    const current = getGitLabInstanceUrls()
    const merged = [...current]
    for (const url of backup.gitlab.servers) {
      if (!merged.some(u => u.toLowerCase() === url.toLowerCase())) {
        merged.push(url)
      }
    }
    setGitLabInstanceUrls(merged)
  }

  if (sections.has('appearance') && backup.appearance !== undefined) {
    const { showRepositoriesSidebar, useSystemMenuBar } = backup.appearance
    if (showRepositoriesSidebar !== undefined) {
      setShowRepositoriesSidebar(showRepositoriesSidebar)
    }
    if (__LINUX__ && useSystemMenuBar !== undefined) {
      setUseSystemMenuBar(useSystemMenuBar)
    }
  }
}
