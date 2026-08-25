import {
  getBoolean,
  setBoolean,
  getNumber,
  setNumber,
  getObject,
  setObject,
} from '../../lib/local-storage'

/** A user-defined group used to organize repositories in the sidebar. */
export interface ICustomRepositoryGroup {
  readonly id: string
  readonly name: string
  /**
   * A hex color (e.g. `'#e53935'`) used to tint the group's background in
   * the sidebar, or `undefined` if the group has no color set. One of
   * `GroupColorPalette`'s `hex` values, though nothing enforces that.
   */
  readonly color?: string
}

/** A preset color choice offered when setting a group's color. */
export interface IGroupColorOption {
  readonly id: string
  readonly label: string
  readonly hex: string
}

/**
 * The preset colors offered for tinting a group's background. Kept to a
 * small, curated palette (rather than a free-form color picker) since
 * group colors are rendered as light background tints, not full-strength
 * swatches — an arbitrary color could easily end up unreadable against
 * the app's light/dark themes.
 */
export const GroupColorPalette: ReadonlyArray<IGroupColorOption> = [
  { id: 'red', label: 'Red', hex: '#e53935' },
  { id: 'orange', label: 'Orange', hex: '#f4511e' },
  { id: 'yellow', label: 'Yellow', hex: '#f9a825' },
  { id: 'green', label: 'Green', hex: '#43a047' },
  { id: 'teal', label: 'Teal', hex: '#00897b' },
  { id: 'blue', label: 'Blue', hex: '#1e88e5' },
  { id: 'purple', label: 'Purple', hex: '#8e24aa' },
  { id: 'pink', label: 'Pink', hex: '#d81b60' },
  { id: 'grey', label: 'Grey', hex: '#757575' },
]

/**
 * Convert a `#rrggbb` hex color into an `rgba(...)` string at the given
 * alpha, for use as a light background tint. Falls back to fully
 * transparent if `hex` isn't a recognizable `#rrggbb` string.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (match === null) {
    return 'rgba(0, 0, 0, 0)'
  }

  const value = match[1]
  const r = parseInt(value.substring(0, 2), 16)
  const g = parseInt(value.substring(2, 4), 16)
  const b = parseInt(value.substring(4, 6), 16)

  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * The identifier used for the built-in group that contains repositories
 * which haven't been assigned to a custom group.
 */
export const OtherGroupId = 'other'

interface IPersistedGroupsData {
  readonly groups: ReadonlyArray<ICustomRepositoryGroup>
  /** Maps a repository id (as a string) to the id of the group it belongs to */
  readonly repositoryGroups: { readonly [repositoryId: string]: string }
}

const GroupsStorageKey = 'repositories-sidebar/custom-groups'
const CollapsedGroupsStorageKey = 'repositories-sidebar/collapsed-groups'
const SidebarWidthKey = 'repositories-sidebar/width'
const SidebarCollapsedKey = 'repositories-sidebar/collapsed'

export const DefaultSidebarWidth = 220
export const MinSidebarWidth = 150
export const MaxSidebarWidth = 400

const emptyData: IPersistedGroupsData = { groups: [], repositoryGroups: {} }

function readData(): IPersistedGroupsData {
  return getObject<IPersistedGroupsData>(GroupsStorageKey) ?? emptyData
}

function writeData(data: IPersistedGroupsData) {
  setObject(GroupsStorageKey, data)
}

/** Get all user-defined groups, in the order they were created. */
export function getCustomGroups(): ReadonlyArray<ICustomRepositoryGroup> {
  return readData().groups
}

/** Create a new, empty custom group with the given name. */
export function createCustomGroup(name: string): ICustomRepositoryGroup {
  const data = readData()
  const group: ICustomRepositoryGroup = { id: createGroupId(), name }
  writeData({ ...data, groups: [...data.groups, group] })
  return group
}

/** Rename an existing custom group. */
export function renameCustomGroup(groupId: string, name: string) {
  const data = readData()
  writeData({
    ...data,
    groups: data.groups.map(g => (g.id === groupId ? { ...g, name } : g)),
  })
}

/**
 * Set (or, passing `null`, clear) a custom group's background tint color.
 */
export function setGroupColor(groupId: string, color: string | null) {
  const data = readData()
  writeData({
    ...data,
    groups: data.groups.map(g =>
      g.id === groupId ? { ...g, color: color ?? undefined } : g
    ),
  })
}

/**
 * Delete a custom group. Repositories that were assigned to this group
 * become ungrouped (i.e. they'll show up in the "Other" section).
 */
export function deleteCustomGroup(groupId: string) {
  const data = readData()
  const repositoryGroups: { [repositoryId: string]: string } = {
    ...data.repositoryGroups,
  }

  for (const key of Object.keys(repositoryGroups)) {
    if (repositoryGroups[key] === groupId) {
      delete repositoryGroups[key]
    }
  }

  writeData({
    groups: data.groups.filter(g => g.id !== groupId),
    repositoryGroups,
  })
}

/** Get a map of repository id -> group id for all assigned repositories. */
export function getRepositoryGroupAssignments(): ReadonlyMap<number, string> {
  const { repositoryGroups } = readData()
  const map = new Map<number, string>()

  for (const [repositoryId, groupId] of Object.entries(repositoryGroups)) {
    const id = parseInt(repositoryId, 10)
    if (!isNaN(id)) {
      map.set(id, groupId)
    }
  }

  return map
}

/**
 * Assign a repository to a custom group, or remove it from any custom
 * group (making it "ungrouped") by passing `null`.
 */
export function setRepositoryGroup(
  repositoryId: number,
  groupId: string | null
) {
  const data = readData()
  const repositoryGroups: { [repositoryId: string]: string } = {
    ...data.repositoryGroups,
  }

  if (groupId === null) {
    delete repositoryGroups[repositoryId.toString()]
  } else {
    repositoryGroups[repositoryId.toString()] = groupId
  }

  writeData({ ...data, repositoryGroups })
}

function createGroupId(): string {
  return `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Get the set of group ids (including the built-in "Other" group) which are collapsed. */
export function getCollapsedGroupIds(): ReadonlySet<string> {
  const ids = getObject<ReadonlyArray<string>>(CollapsedGroupsStorageKey)
  return new Set(ids ?? [])
}

/** Persist the collapsed state of a single group. */
export function setGroupCollapsed(groupId: string, collapsed: boolean) {
  const collapsedIds = new Set(getCollapsedGroupIds())

  if (collapsed) {
    collapsedIds.add(groupId)
  } else {
    collapsedIds.delete(groupId)
  }

  setObject(CollapsedGroupsStorageKey, Array.from(collapsedIds))
}

/** Get the persisted width of the repositories sidebar. */
export function getSidebarWidth(): number {
  return getNumber(SidebarWidthKey, DefaultSidebarWidth)
}

/** Persist the width of the repositories sidebar. */
export function setSidebarWidth(width: number) {
  setNumber(SidebarWidthKey, width)
}

/** Get whether the repositories sidebar is collapsed. */
export function getSidebarCollapsed(): boolean {
  return getBoolean(SidebarCollapsedKey, false)
}

/** Persist whether the repositories sidebar is collapsed. */
export function setSidebarCollapsed(collapsed: boolean) {
  setBoolean(SidebarCollapsedKey, collapsed)
}
