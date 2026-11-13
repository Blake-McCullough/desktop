import { IGitLabCloneableProject, normalizeInstanceUrl } from './gitlab-api'
import { getGitLabInstanceUrls } from './gitlab-token'
import { getBoolean, setBoolean } from '../local-storage'
import { getGenericUsername, setGenericCredential } from '../generic-git-auth'

/** The public GitLab instance, always offered in the clone dialog. */
export const GitLabDotComUrl = 'https://gitlab.com'

const SelectedInstanceKey = 'gitlab/clone-selected-instance'
const UseSshKey = 'gitlab/clone-use-ssh'
const AddToGroupKey = 'gitlab/clone-add-to-sidebar-group'

/**
 * The instances the clone dialog can list projects from: the self-hosted
 * instances configured in Preferences, then gitlab.com.
 */
export function getCloneableGitLabInstances(): ReadonlyArray<string> {
  const urls = new Set<string>()
  for (const url of getGitLabInstanceUrls()) {
    const normalized = normalizeInstanceUrl(url)
    if (normalized !== null) {
      urls.add(normalized)
    }
  }
  urls.add(GitLabDotComUrl)
  return [...urls]
}

/**
 * The instance to show when the GitLab tab opens: the last one picked if it's
 * still configured, otherwise the first self-hosted instance (the shared token
 * is most likely for that one), otherwise gitlab.com.
 */
export function getInitialGitLabInstance(
  instances: ReadonlyArray<string>
): string {
  const last = localStorage.getItem(SelectedInstanceKey)
  if (last !== null && instances.includes(last)) {
    return last
  }
  return instances[0] ?? GitLabDotComUrl
}

export function setLastGitLabInstance(url: string) {
  localStorage.setItem(SelectedInstanceKey, url)
}

export const getGitLabCloneUseSsh = () => getBoolean(UseSshKey, false)
export const setGitLabCloneUseSsh = (v: boolean) => setBoolean(UseSshKey, v)

export const getGitLabCloneAddToGroup = () => getBoolean(AddToGroupKey, true)
export const setGitLabCloneAddToGroup = (v: boolean) =>
  setBoolean(AddToGroupKey, v)

/** A GitLab group (or user namespace) and the projects directly in it. */
export interface IGitLabProjectGroup {
  /** The namespace's full path, e.g. `acme/backend`. */
  readonly fullPath: string
  /** How deep the namespace is nested; `acme` is 0, `acme/backend` is 1. */
  readonly depth: number
  /** Whether this is the signed-in user's personal namespace. */
  readonly isPersonal: boolean
  readonly projects: ReadonlyArray<IGitLabCloneableProject>
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/**
 * Group projects by their GitLab namespace.
 *
 * The user's own namespace comes first, then groups ordered by path so that
 * subgroups follow their parent (`acme`, `acme/backend`, `acme/frontend`,
 * `beta`). Projects are ordered by name within each group.
 */
export function groupGitLabProjects(
  projects: ReadonlyArray<IGitLabCloneableProject>,
  username: string
): ReadonlyArray<IGitLabProjectGroup> {
  const byNamespace = new Map<string, IGitLabCloneableProject[]>()
  for (const project of projects) {
    const list = byNamespace.get(project.namespaceFullPath)
    if (list === undefined) {
      byNamespace.set(project.namespaceFullPath, [project])
    } else {
      list.push(project)
    }
  }

  const isPersonal = (path: string) =>
    username.length > 0 && path.toLowerCase() === username.toLowerCase()

  return [...byNamespace.entries()]
    .map(([fullPath, list]) => ({
      fullPath,
      depth: fullPath.length === 0 ? 0 : fullPath.split('/').length - 1,
      isPersonal: isPersonal(fullPath),
      projects: [...list].sort((a, b) => byName(a.name, b.name)),
    }))
    .sort((a, b) => {
      if (a.isPersonal !== b.isPersonal) {
        return a.isPersonal ? -1 : 1
      }
      // Compare segment by segment so `acme/backend` sorts right after
      // `acme` rather than after `acme-tools`.
      const as = a.fullPath.split('/')
      const bs = b.fullPath.split('/')
      for (let i = 0; i < Math.min(as.length, bs.length); i++) {
        const c = byName(as[i], bs[i])
        if (c !== 0) {
          return c
        }
      }
      return as.length - bs.length
    })
}

/**
 * Remember the GitLab token as the Git credential for an HTTPS clone URL's
 * host, so cloning (and later fetching and pushing) doesn't prompt for a
 * password.
 *
 * Only done for HTTPS, and only when no credential has been saved for the
 * host yet: one the user entered themselves is never replaced. Returns
 * whether a credential was saved.
 */
export async function rememberGitLabCredential(
  cloneUrl: string,
  username: string,
  token: string
): Promise<boolean> {
  let url: URL
  try {
    url = new URL(cloneUrl)
  } catch {
    return false
  }

  if (url.protocol !== 'https:' || username.length === 0) {
    return false
  }

  // Git asks for credentials by protocol and host (Desktop doesn't set
  // credential.useHttpPath), so that's the key generic credentials use.
  const endpoint = `${url.origin}/`
  if (getGenericUsername(endpoint) !== null) {
    return false
  }

  await setGenericCredential(endpoint, username, token)
  return true
}
