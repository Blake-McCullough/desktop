export interface RepoGroup {
  readonly id: string
  readonly name: string
  readonly order: number
  readonly collapsed: boolean
}

export function createRepoGroup(
  name: string,
  order: number,
  collapsed: boolean = false
): RepoGroup {
  // Use a simple timestamp-based id
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { id, name, order, collapsed }
}

export function withUpdatedName(group: RepoGroup, name: string): RepoGroup {
  return { ...group, name }
}

export function withToggledCollapsed(group: RepoGroup, collapsed?: boolean) {
  return { ...group, collapsed: collapsed ?? !group.collapsed }
}
