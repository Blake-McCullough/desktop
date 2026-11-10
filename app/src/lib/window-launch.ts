/**
 * Details about how this window was launched, passed by the main process in
 * the page URL's hash (see `AppWindow.load`).
 */
function getLaunchParams(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.hash.replace(/^#/, ''))
  } catch {
    return new URLSearchParams()
  }
}

const params = typeof window !== 'undefined' ? getLaunchParams() : null

/**
 * Whether this is an additional window opened for a repository, as opposed
 * to the app's primary window. Additional windows don't overwrite app-wide
 * "last selected repository" state.
 */
export function isSecondaryWindow(): boolean {
  return params?.get('secondary') === '1'
}

/** The repository this window was opened for, if any. */
export function getLaunchRepositoryId(): number | null {
  const value = parseInt(params?.get('repo') ?? '', 10)
  return isNaN(value) ? null : value
}

/** Repositories open in other windows when this one was created. */
export function getExcludedRepositoryIds(): ReadonlySet<number> {
  return new Set(
    (params?.get('exclude') ?? '')
      .split(',')
      .map(id => parseInt(id, 10))
      .filter(id => !isNaN(id))
  )
}
