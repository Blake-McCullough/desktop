import { Emitter, Disposable } from 'event-kit'
import { TokenStore } from '../stores/token-store'
import { getObject, setObject } from '../local-storage'
import { normalizeInstanceUrl } from './gitlab-api'

/** The keytar "service" key under which the GitLab personal access token is stored. */
const GitLabTokenStoreKey = 'GitHub Desktop - GitLab'

/**
 * The "account" under which the GitLab token is stored. A single, global
 * GitLab token is used for every GitLab instance.
 */
const GitLabTokenStoreLogin = 'gitlab-token'

const InstanceUrlsKey = 'gitlab/instance-urls'

const emitter = new Emitter()

/**
 * In-memory copy of the token. Reading from the OS credential store goes
 * through IPC to the main process (and on Windows through the Credential
 * Manager), which is far too slow to do for every request.
 */
let cachedToken: Promise<string | null> | null = null

/**
 * Get the user's GitLab personal access token, if one has been configured.
 *
 * Returns `null` if no token has been set.
 */
export function getGitLabToken(): Promise<string | null> {
  if (cachedToken === null) {
    cachedToken = TokenStore.getItem(
      GitLabTokenStoreKey,
      GitLabTokenStoreLogin
    ).catch(e => {
      log.error('Failed to read GitLab token', e)
      cachedToken = null
      return null
    })
  }

  return cachedToken
}

/**
 * Set (or clear) the user's GitLab personal access token.
 *
 * Passing `null` (or an empty string) removes the stored token.
 */
export async function setGitLabToken(token: string | null): Promise<void> {
  const value = token === null ? '' : token.trim()

  if (value.length === 0) {
    await TokenStore.deleteItem(GitLabTokenStoreKey, GitLabTokenStoreLogin)
    cachedToken = Promise.resolve(null)
  } else {
    await TokenStore.setItem(GitLabTokenStoreKey, GitLabTokenStoreLogin, value)
    cachedToken = Promise.resolve(value)
  }

  emitter.emit('did-change', null)
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
 * Register a callback for when the token or instance settings change, so
 * pipeline polling can start, stop or refetch without an app restart.
 */
export function onGitLabSettingsChanged(fn: () => void): Disposable {
  return emitter.on('did-change', fn)
}
