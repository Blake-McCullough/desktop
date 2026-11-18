import { Emitter, Disposable } from 'event-kit'
import { TokenStore } from '../stores/token-store'
import { getObject, setObject } from '../local-storage'
import { normalizeInstanceUrl } from './gitlab-api'

/** The keytar "service" key under which GitLab tokens are stored. */
const GitLabTokenStoreKey = 'GitHub Desktop - GitLab'

/**
 * The "account" for the default token, used for any GitLab instance that
 * doesn't have a token of its own. (Before per-instance tokens existed this
 * was the only token, so existing setups keep working unchanged.)
 */
const DefaultTokenLogin = 'gitlab-token'

/** The "account" for an instance's own token. */
const instanceLogin = (instanceUrl: string) => `instance:${instanceUrl}`

const InstanceUrlsKey = 'gitlab/instance-urls'

/** The public GitLab instance. */
export const GitLabDotComInstance = 'https://gitlab.com'

const emitter = new Emitter()

/**
 * In-memory copies of the tokens, keyed by login. Reading from the OS
 * credential store goes through IPC (and on Windows through the Credential
 * Manager), which is far too slow to do for every request.
 */
const cache = new Map<string, Promise<string | null>>()

function keyFor(instanceUrl: string | null): string | null {
  if (instanceUrl === null) {
    return DefaultTokenLogin
  }
  const normalized = normalizeInstanceUrl(instanceUrl)
  return normalized === null ? null : instanceLogin(normalized)
}

function readToken(login: string): Promise<string | null> {
  let cached = cache.get(login)
  if (cached === undefined) {
    cached = TokenStore.getItem(GitLabTokenStoreKey, login).catch(e => {
      log.error('Failed to read GitLab token', e)
      cache.delete(login)
      return null
    })
    cache.set(login, cached)
  }
  return cached
}

/**
 * The token to use for an instance: its own token if it has one, otherwise
 * the default token. With no instance, the default token.
 *
 * Returns `null` if neither is set.
 */
export async function getGitLabToken(
  instanceUrl: string | null = null
): Promise<string | null> {
  const own = await getGitLabInstanceToken(instanceUrl)
  return own ?? (instanceUrl === null ? null : readToken(DefaultTokenLogin))
}

/**
 * Only the token stored for exactly this instance (or the default token, for
 * `null`), without falling back. For the Preferences UI.
 */
export function getGitLabInstanceToken(
  instanceUrl: string | null
): Promise<string | null> {
  const login = keyFor(instanceUrl)
  return login === null ? Promise.resolve(null) : readToken(login)
}

/**
 * Set (or clear, with `null` or an empty string) the token for an instance,
 * or the default token when `instanceUrl` is `null`.
 */
export async function setGitLabToken(
  token: string | null,
  instanceUrl: string | null = null
): Promise<void> {
  const login = keyFor(instanceUrl)
  if (login === null) {
    throw new Error(`'${instanceUrl}' isn't a valid GitLab address.`)
  }

  const value = token === null ? '' : token.trim()
  if (value.length === 0) {
    await TokenStore.deleteItem(GitLabTokenStoreKey, login)
    cache.set(login, Promise.resolve(null))
  } else {
    await TokenStore.setItem(GitLabTokenStoreKey, login, value)
    cache.set(login, Promise.resolve(value))
  }

  emitter.emit('did-change', null)
}

/** Whether any token (default or per instance) is configured. */
export async function hasAnyGitLabToken(): Promise<boolean> {
  const instances = [null, GitLabDotComInstance, ...getGitLabInstanceUrls()]
  for (const instance of instances) {
    if ((await getGitLabInstanceToken(instance)) !== null) {
      return true
    }
  }
  return false
}

/**
 * Self-hosted GitLab instance base URLs configured by the user (in addition
 * to any host with "gitlab" in its name, which is detected automatically).
 */
export function getGitLabInstanceUrls(): ReadonlyArray<string> {
  const stored = getObject<ReadonlyArray<string>>(InstanceUrlsKey)
  return Array.isArray(stored)
    ? stored.filter((s): s is string => typeof s === 'string')
    : []
}

/** Persist the configured self-hosted instance URLs (normalized, de-duplicated). */
export function setGitLabInstanceUrls(urls: ReadonlyArray<string>) {
  const normalized = new Set<string>()
  for (const url of urls) {
    const n = normalizeInstanceUrl(url)
    if (n !== null) {
      normalized.add(n)
    }
  }

  setObject(InstanceUrlsKey, [...normalized])
  emitter.emit('did-change', null)
}

/**
 * Register a callback for when tokens or instance settings change, so
 * pipeline polling can start, stop or refetch without an app restart.
 */
export function onGitLabSettingsChanged(fn: () => void): Disposable {
  return emitter.on('did-change', fn)
}
