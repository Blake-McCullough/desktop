import { Emitter, Disposable } from 'event-kit'
import { TokenStore } from '../stores/token-store'
import { getObject, setObject } from '../local-storage'
import { normalizeInstanceUrl } from './gitlab-api'

/** The keytar "service" key under which GitLab tokens are stored. */
const GitLabTokenStoreKey = 'GitHub Desktop - GitLab'

/**
 * Earlier versions had a single "default" token used for every server. It's
 * no longer offered: each server has its own token. A token saved that way
 * is copied to a server the first time that server needs one (once per
 * server, so clearing a server's token later doesn't bring it back), and
 * removed for good when you save Preferences → GitLab.
 */
const LegacyDefaultTokenLogin = 'gitlab-token'
const LegacyMigratedLoginsKey = 'gitlab/default-token-migrated-to'

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

function keyFor(instanceUrl: string): string | null {
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

function getMigratedLogins(): Set<string> {
  const stored = getObject<ReadonlyArray<string>>(LegacyMigratedLoginsKey)
  return new Set(Array.isArray(stored) ? stored : [])
}

/** Give a server the old default token, if there is one and it hasn't yet. */
async function adoptLegacyDefaultToken(login: string): Promise<string | null> {
  const migrated = getMigratedLogins()
  if (migrated.has(login)) {
    return null
  }
  const legacy = await readToken(LegacyDefaultTokenLogin)
  if (legacy === null) {
    return null
  }
  migrated.add(login)
  setObject(LegacyMigratedLoginsKey, [...migrated])
  try {
    await TokenStore.setItem(GitLabTokenStoreKey, login, legacy)
  } catch (e) {
    log.error('Failed to copy the default GitLab token to a server', e)
  }
  cache.set(login, Promise.resolve(legacy))
  return legacy
}

/**
 * The token for a GitLab server (its base URL), or `null` if it has none.
 */
export async function getGitLabToken(
  instanceUrl: string
): Promise<string | null> {
  const login = keyFor(instanceUrl)
  if (login === null) {
    return null
  }
  return (await readToken(login)) ?? adoptLegacyDefaultToken(login)
}

/**
 * Set (or clear, with `null` or an empty string) a server's token.
 */
export async function setGitLabToken(
  token: string | null,
  instanceUrl: string
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

/**
 * Delete the old default token (see `LegacyDefaultTokenLogin`) once the
 * servers you can see in Preferences have taken it over.
 */
export async function forgetLegacyDefaultGitLabToken(): Promise<void> {
  if ((await readToken(LegacyDefaultTokenLogin)) === null) {
    return
  }
  await TokenStore.deleteItem(GitLabTokenStoreKey, LegacyDefaultTokenLogin)
  cache.set(LegacyDefaultTokenLogin, Promise.resolve(null))
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
