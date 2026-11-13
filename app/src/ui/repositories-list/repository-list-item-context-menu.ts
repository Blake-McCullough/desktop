import {
  Repository,
  getRepositoryAccountIdentity,
} from '../../models/repository'
import { Account, isSameAccount } from '../../models/account'
import { IMenuItem } from '../../lib/menu-item'
import { Repositoryish } from './group-repositories'
import { writeClipboardText } from '../main-process-proxy'
import {
  RevealInFileManagerLabel,
  DefaultEditorLabel,
  DefaultShellLabel,
} from '../lib/context-menu'
import {
  ICustomRepositoryGroup,
  OtherGroupId,
} from './custom-repository-groups-store'

interface IRepositoryListItemContextMenuConfig {
  repository: Repositoryish
  shellLabel: string | undefined
  externalEditorLabel: string | undefined
  askForConfirmationOnRemoveRepository: boolean
  /** The signed-in accounts. */
  accounts: ReadonlyArray<Account>
  onViewOnGitHub: (repository: Repositoryish) => void
  onOpenInShell: (repository: Repositoryish) => void
  onShowRepository: (repository: Repositoryish) => void
  onOpenInExternalEditor: (repository: Repositoryish) => void
  onRemoveRepository: (repository: Repositoryish) => void
  onChangeRepositoryAlias: (repository: Repository) => void
  onRemoveRepositoryAlias: (repository: Repository) => void
  onCreateWorktree?: (repository: Repository) => void
  onShowWorktrees?: (repository: Repository) => void
  onChangeRepositoryAccount: (repository: Repository, login: string) => void
  onShowRepositorySettings: (repository: Repository) => void
  /** Opens the history graph window; omitted where it isn't available. */
  onViewHistoryGraph?: (repository: Repository) => void
  /** Move the repository's folder somewhere else on disk. */
  onMoveRepository?: (repository: Repository) => void

  /**
   * The custom groups the repository could be moved into. When provided
   * (along with `onMoveToGroup`), a "Move to group" submenu is added to
   * the context menu.
   */
  customGroups?: ReadonlyArray<ICustomRepositoryGroup>

  /** The id of the group the repository currently belongs to, or the
   * `OtherGroupId` sentinel if it isn't assigned to a custom group. */
  currentGroupId?: string

  /** Called when the user picks a group (or "Other") to move the repository into. */
  onMoveToGroup?: (repository: Repositoryish, groupId: string) => void

  /** Called when the user selects "New group…" from the move-to-group submenu. */
  onMoveToNewGroup?: (repository: Repositoryish) => void
}

export const generateRepositoryListContextMenu = (
  config: IRepositoryListItemContextMenuConfig
) => {
  const { repository } = config
  const missing = repository instanceof Repository && repository.missing
  const github =
    repository instanceof Repository && repository.gitHubRepository != null
  const openInExternalEditor = config.externalEditorLabel
    ? `Open in ${config.externalEditorLabel}`
    : DefaultEditorLabel
  const openInShell = config.shellLabel
    ? `Open in ${config.shellLabel}`
    : DefaultShellLabel

  const onViewHistoryGraph = config.onViewHistoryGraph
  const items: ReadonlyArray<IMenuItem> = [
    ...(repository instanceof Repository && onViewHistoryGraph !== undefined
      ? [
          {
            label: __DARWIN__ ? 'View History Graph…' : 'View history graph…',
            action: () => onViewHistoryGraph(repository),
            enabled: !missing,
          },
          { type: 'separator' as const },
        ]
      : []),
    ...buildAliasMenuItems(config),
    ...buildWorktreeMenuItems(config),
    ...buildGroupMenuItems(config),
    ...buildAccountMenuItems(config),
    ...buildRepositorySettingsMenuItems(config),
    ...(repository instanceof Repository &&
    config.onMoveRepository !== undefined
      ? [
          {
            label: __DARWIN__ ? 'Move Folder…' : 'Move folder…',
            action: () => config.onMoveRepository?.(repository),
            enabled: !missing,
          },
        ]
      : []),
    {
      label: __DARWIN__ ? 'Copy Repo Name' : 'Copy repo name',
      action: () => writeClipboardText(repository.name),
    },
    {
      label: __DARWIN__ ? 'Copy Repo Path' : 'Copy repo path',
      action: () => writeClipboardText(repository.path),
    },
    { type: 'separator' },
    {
      label: 'View on GitHub',
      action: () => config.onViewOnGitHub(repository),
      enabled: github,
    },
    {
      label: openInShell,
      action: () => config.onOpenInShell(repository),
      enabled: !missing,
    },
    {
      label: RevealInFileManagerLabel,
      action: () => config.onShowRepository(repository),
      enabled: !missing,
    },
    {
      label: openInExternalEditor,
      action: () => config.onOpenInExternalEditor(repository),
      enabled: !missing,
    },
    { type: 'separator' },
    {
      label: config.askForConfirmationOnRemoveRepository ? 'Remove…' : 'Remove',
      action: () => config.onRemoveRepository(repository),
    },
  ]

  return items
}

const buildAliasMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository } = config

  if (!(repository instanceof Repository)) {
    return []
  }

  const verb = repository.alias == null ? 'Create' : 'Change'
  const items: Array<IMenuItem> = [
    {
      label: __DARWIN__ ? `${verb} Alias` : `${verb} alias`,
      action: () => config.onChangeRepositoryAlias(repository),
    },
  ]

  if (repository.alias !== null) {
    items.push({
      label: __DARWIN__ ? 'Remove Alias' : 'Remove alias',
      action: () => config.onRemoveRepositoryAlias(repository),
    })
  }

  return items
}

const buildWorktreeMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository, onCreateWorktree, onShowWorktrees } = config

  if (!(repository instanceof Repository)) {
    return []
  }

  if (onCreateWorktree === undefined && onShowWorktrees === undefined) {
    return []
  }

  const items: Array<IMenuItem> = []

  if (onShowWorktrees !== undefined) {
    items.push({
      label: __DARWIN__ ? 'View Worktrees…' : 'View worktrees…',
      action: () => onShowWorktrees(repository),
    })
  }

  if (onCreateWorktree !== undefined) {
    items.push({
      label: __DARWIN__ ? 'New Worktree…' : 'New worktree…',
      action: () => onCreateWorktree(repository),
    })
  }

  return items
}

const buildGroupMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository, customGroups, onMoveToGroup } = config

  if (customGroups === undefined || onMoveToGroup === undefined) {
    return []
  }

  const currentGroupId = config.currentGroupId ?? OtherGroupId

  const submenu: Array<IMenuItem> = [
    {
      label: 'Other',
      type: 'checkbox',
      checked: currentGroupId === OtherGroupId,
      action: () => onMoveToGroup(repository, OtherGroupId),
    },
  ]

  if (customGroups.length > 0) {
    submenu.push({ type: 'separator' })

    for (const group of customGroups) {
      submenu.push({
        label: group.name,
        type: 'checkbox',
        checked: currentGroupId === group.id,
        action: () => onMoveToGroup(repository, group.id),
      })
    }
  }

  submenu.push({ type: 'separator' })
  submenu.push({
    label: 'New group…',
    action: () => config.onMoveToNewGroup?.(repository),
  })

  return [
    {
      label: 'Move to group…',
      submenu,
    },
  ]
}

/**
 * Build the Account submenu used to reassign a repository to another
 * signed-in account on its endpoint.
 *
 * The submenu is omitted when there is nothing to choose between: when the
 * repository is assigned and its endpoint has only one retained account
 * identity, or when it's unassigned and no account is signed in on its
 * endpoint. An assigned account that has been signed out is still listed
 * (checked and disabled) so users can see the current association.
 */
const buildAccountMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository } = config

  if (
    !(repository instanceof Repository) ||
    repository.gitHubRepository === null
  ) {
    return []
  }

  const { endpoint } = repository.gitHubRepository
  const assigned = getRepositoryAccountIdentity(repository)
  const eligible = config.accounts.filter(a => a.endpoint === endpoint)
  const signedOut =
    assigned !== null && !eligible.some(a => isSameAccount(a, assigned))
  const retainedCount = eligible.length + (signedOut ? 1 : 0)

  if (assigned === null ? eligible.length === 0 : retainedCount <= 1) {
    return []
  }

  const submenu: Array<IMenuItem> = []

  if (signedOut) {
    submenu.push({
      label: `@${assigned.login} (Signed out)`,
      type: 'checkbox',
      checked: true,
      enabled: false,
    })
  }

  for (const account of eligible) {
    const checked = isSameAccount(account, assigned)
    submenu.push({
      label: `@${account.login}`,
      type: 'checkbox',
      checked,
      action: checked
        ? undefined
        : () => config.onChangeRepositoryAccount(repository, account.login),
    })
  }

  return [{ label: 'Account', submenu }]
}

const buildRepositorySettingsMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository } = config

  if (!(repository instanceof Repository) || repository.missing) {
    return []
  }

  return [
    {
      label: __DARWIN__ ? 'Repository Settings…' : 'Repository settings…',
      action: () => config.onShowRepositorySettings(repository),
    },
  ]
}
