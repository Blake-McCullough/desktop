import { RepoGroup, createRepoGroup, withToggledCollapsed } from '../models/repo-group'

// Simple client-side store for repo groups persisted to localStorage.
// Keying / shape:
// - repoGroups: JSON array of RepoGroup
// - repoGroupAssignments: JSON object map repoId -> groupId

const GroupsKey = 'desktop:repoGroups:v1'
const AssignmentsKey = 'desktop:repoGroupAssignments:v1'

type Subscriber = () => void

let subscribers: Subscriber[] = []

function notify() {
  for (const s of subscribers) {
    try {
      s()
    } catch (e) {
      console.error('repo-groups-store subscriber error', e)
    }
  }
}

function loadGroups(): RepoGroup[] {
  try {
    const raw = localStorage.getItem(GroupsKey)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as RepoGroup[]
    return parsed
  } catch (e) {
    console.error('Failed to load repo groups', e)
    return []
  }
}

function saveGroups(groups: RepoGroup[]) {
  try {
    localStorage.setItem(GroupsKey, JSON.stringify(groups))
  } catch (e) {
    console.error('Failed to save repo groups', e)
  }
}

function loadAssignments(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AssignmentsKey)
    if (!raw) {
      return {}
    }
    return JSON.parse(raw) as Record<string, string>
  } catch (e) {
    console.error('Failed to load repo group assignments', e)
    return {}
  }
}

function saveAssignments(assignments: Record<string, string>) {
  try {
    localStorage.setItem(AssignmentsKey, JSON.stringify(assignments))
  } catch (e) {
    console.error('Failed to save repo group assignments', e)
  }
}

export const RepoGroupsStore = {
  getGroups(): RepoGroup[] {
    return loadGroups().sort((a, b) => a.order - b.order)
  },

  getAssignmentMap(): Record<string, string> {
    return loadAssignments()
  },

  subscribe(fn: Subscriber) {
    subscribers.push(fn)
    return () => {
      const i = subscribers.indexOf(fn)
      if (i >= 0) subscribers.splice(i, 1)
    }
  },

  createGroup(name: string): RepoGroup {
    const groups = loadGroups()
    const order = groups.length ? Math.max(...groups.map(g => g.order)) + 1 : 0
    const group = createRepoGroup(name, order, false)
    groups.push(group)
    saveGroups(groups)
    notify()
    return group
  },

  renameGroup(id: string, name: string) {
    const groups = loadGroups()
    const i = groups.findIndex(g => g.id === id)
    if (i === -1) return
    groups[i] = { ...groups[i], name }
    saveGroups(groups)
    notify()
  },

  deleteGroup(id: string) {
    const groups = loadGroups().filter(g => g.id !== id)
    saveGroups(groups)

    const assignments = loadAssignments()
    let changed = false
    for (const key of Object.keys(assignments)) {
      if (assignments[key] === id) {
        delete assignments[key]
        changed = true
      }
    }
    if (changed) saveAssignments(assignments)

    notify()
  },

  setRepositoryGroup(repoId: number, groupId: string | null) {
    const assignments = loadAssignments()
    const key = String(repoId)
    if (groupId === null) {
      if (assignments[key] !== undefined) {
        delete assignments[key]
        saveAssignments(assignments)
        notify()
      }
      return
    }
    assignments[key] = groupId
    saveAssignments(assignments)
    notify()
  },

  toggleGroupCollapsed(groupId: string, collapsed?: boolean) {
    const groups = loadGroups()
    const i = groups.findIndex(g => g.id === groupId)
    if (i === -1) return
    groups[i] = withToggledCollapsed(groups[i], collapsed)
    saveGroups(groups)
    notify()
  },

  reorderGroups(newOrder: string[]) {
    const groups = loadGroups()
    const byId = new Map(groups.map(g => [g.id, g]))
    const reordered: RepoGroup[] = []
    let order = 0
    for (const id of newOrder) {
      const g = byId.get(id)
      if (g) {
        reordered.push({ ...g, order: order++ })
        byId.delete(id)
      }
    }
    // append any remaining groups not included
    for (const g of byId.values()) {
      reordered.push({ ...g, order: order++ })
    }
    saveGroups(reordered)
    notify()
  },
}

// Expose storage keys for debugging/testing
export const _internal = { GroupsKey, AssignmentsKey }
