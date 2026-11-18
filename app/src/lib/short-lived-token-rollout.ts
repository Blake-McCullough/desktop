import { isGHES } from './endpoint-capabilities'
import { enableShortLivedTokens } from './feature-flag'

/** Whether to ask for short-lived tokens when signing in. */
export async function shouldRequestShortLivedTokens(
  endpoint: string
): Promise<boolean> {
  // GitHub decides this rollout per install by asking its servers with the
  // install's ID; this build doesn't contact them, so it only follows the
  // feature flag (and otherwise keeps the long-lived token sign-in).
  return !isGHES(endpoint) && enableShortLivedTokens()
}
