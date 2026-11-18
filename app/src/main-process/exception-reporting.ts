import { app } from 'electron'

/**
 * Errors and crashes are never sent anywhere from this build; they're only
 * written to the app's log (which happens before this is called). Kept so
 * callers don't need to change.
 */
export async function reportError(
  error: Error,
  extra?: { [key: string]: string },
  nonFatal?: boolean
) {
  log.info(
    `Not reporting ${nonFatal ? 'non-fatal error' : 'crash'} "${
      error.name
    }" (error reporting is disabled in ${app.getName()})`
  )
}
