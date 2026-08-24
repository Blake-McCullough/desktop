import { TokenStore } from '../stores/token-store'

/** The keytar "service" key under which the GitLab personal access token is stored. */
const GitLabTokenStoreKey = 'GitHub Desktop - GitLab'

/**
 * The "account" under which the GitLab token is stored. GitHub Desktop only
 * supports a single, global GitLab token (not per-host or per-account), so
 * this is a fixed value rather than something derived from an account.
 */
const GitLabTokenStoreLogin = 'gitlab-token'

/**
 * Get the user's GitLab personal access token, if one has been configured.
 *
 * Returns `null` if no token has been set.
 */
export async function getGitLabToken(): Promise<string | null> {
  return TokenStore.getItem(GitLabTokenStoreKey, GitLabTokenStoreLogin)
}

/**
 * Set (or clear) the user's GitLab personal access token.
 *
 * Passing `null` (or an empty string) removes the stored token.
 */
export async function setGitLabToken(token: string | null): Promise<void> {
  if (token === null || token.length === 0) {
    await TokenStore.deleteItem(GitLabTokenStoreKey, GitLabTokenStoreLogin)
    return
  }

  await TokenStore.setItem(GitLabTokenStoreKey, GitLabTokenStoreLogin, token)
}
