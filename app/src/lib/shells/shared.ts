import { ChildProcess } from 'child_process'

import * as Darwin from './darwin'
import * as Win32 from './win32'
import * as Linux from './linux'
import { ShellError } from './error'
import { pathExists } from '../path-exists'
import { ICustomIntegration } from '../custom-integration'

export type Shell = Darwin.Shell | Win32.Shell | Linux.Shell

export type FoundShell<T extends Shell> = {
  readonly shell: T
  readonly path: string
  readonly extraArgs?: ReadonlyArray<string>
} & (T extends Darwin.Shell
  ? {
      readonly bundleID: string
    }
  : {})

type AnyFoundShell = FoundShell<Shell>

/** The default shell. */
export const Default = (function () {
  if (__DARWIN__) {
    return Darwin.Default
  } else if (__WIN32__) {
    return Win32.Default
  } else {
    return Linux.Default
  }
})()

let shellCache: ReadonlyArray<AnyFoundShell> | null = null

/** Parse the label into the specified shell type. */
export function parse(label: string): Shell {
  if (__DARWIN__) {
    return Darwin.parse(label)
  } else if (__WIN32__) {
    return Win32.parse(label)
  } else if (__LINUX__) {
    return Linux.parse(label)
  }

  throw new Error(
    `Platform not currently supported for resolving shells: ${process.platform}`
  )
}

/** Get the shells available for the user. */
export async function getAvailableShells(): Promise<
  ReadonlyArray<AnyFoundShell>
> {
  if (shellCache) {
    return shellCache
  }

  if (__DARWIN__) {
    shellCache = await Darwin.getAvailableShells()
    return shellCache
  } else if (__WIN32__) {
    shellCache = await Win32.getAvailableShells()
    return shellCache
  } else if (__LINUX__) {
    shellCache = await Linux.getAvailableShells()
    return shellCache
  }

  return Promise.reject(
    `Platform not currently supported for resolving shells: ${process.platform}`
  )
}

/**
 * Pick the shell to use from those installed: `shell` if it's there,
 * otherwise the one that best fits this computer.
 */
export function chooseShell(
  available: ReadonlyArray<AnyFoundShell>,
  shell: Shell | null,
  preferred: ReadonlyArray<Shell> = []
): AnyFoundShell | null {
  const find = (s: Shell) => available.find(f => f.shell === s)
  return (
    (shell !== null ? find(shell) : undefined) ??
    preferred.map(find).find(f => f !== undefined) ??
    find(Default) ??
    available[0] ??
    null
  )
}

function getPreferredShells(): ReadonlyArray<Shell> {
  return __LINUX__ ? Linux.getDesktopPreferredShells() : []
}

/**
 * The shell the user picked if it's installed, otherwise the best installed
 * one (on Linux, the desktop's own terminal), or null if none are.
 */
export async function resolveShell(shell: Shell | null): Promise<Shell | null> {
  const available = await getAvailableShells()
  return chooseShell(available, shell, getPreferredShells())?.shell ?? null
}

/**
 * Find the given shell, or the best installed one if it can't be found.
 * Throws a `ShellError` when no supported terminal is installed.
 */
export async function findShellOrDefault(shell: Shell): Promise<AnyFoundShell> {
  const available = await getAvailableShells()
  const found = chooseShell(available, shell, getPreferredShells())
  if (found === null) {
    const label = __DARWIN__ ? 'Settings' : 'Options'
    throw new ShellError(
      `No supported terminal was found. Install one, or set a custom terminal in ${label} → Integrations.`
    )
  }
  return found
}

/** Launch the given shell at the path. */
export async function launchShell(
  shell: AnyFoundShell,
  path: string,
  onError: (error: Error) => void
): Promise<void> {
  // We have to manually cast the wider `Shell` type into the platform-specific
  // type. This is less than ideal, but maybe the best we can do without
  // platform-specific build targets.
  const exists = await pathExists(shell.path)
  if (!exists) {
    const label = __DARWIN__ ? 'Settings' : 'Options'
    throw new ShellError(
      `Could not find executable for '${shell.shell}' at path '${shell.path}'.  Please open ${label} and select an available shell.`
    )
  }

  let cp: ChildProcess | null = null

  if (__DARWIN__) {
    cp = Darwin.launch(shell as FoundShell<Darwin.Shell>, path)
  } else if (__WIN32__) {
    cp = Win32.launch(shell as FoundShell<Win32.Shell>, path)
  } else if (__LINUX__) {
    cp = Linux.launch(shell as FoundShell<Linux.Shell>, path)
  }

  if (cp != null) {
    addErrorTracing(shell.shell, cp, onError)
    return Promise.resolve()
  } else {
    return Promise.reject(
      `Platform not currently supported for launching shells: ${process.platform}`
    )
  }
}

/** Launch custom shell at the path. */
export async function launchCustomShell(
  customShell: ICustomIntegration,
  path: string,
  onError: (error: Error) => void
): Promise<void> {
  // We have to manually cast the wider `Shell` type into the platform-specific
  // type. This is less than ideal, but maybe the best we can do without
  // platform-specific build targets.
  const exists = await pathExists(customShell.path)
  if (!exists) {
    const label = __DARWIN__ ? 'Settings' : 'Options'
    throw new ShellError(
      `Could not find executable for custom shell at path '${customShell.path}'.  Please open ${label} and select an available shell.`
    )
  }

  let cp: ChildProcess | null = null

  if (__DARWIN__) {
    cp = Darwin.launchCustomShell(customShell, path)
  } else if (__WIN32__) {
    cp = Win32.launchCustomShell(customShell, path)
  } else if (__LINUX__) {
    cp = Linux.launchCustomShell(customShell, path)
  }

  if (cp != null) {
    addErrorTracing('Custom Shell', cp, onError)
    return Promise.resolve()
  } else {
    return Promise.reject(
      `Platform not currently supported for launching shells: ${process.platform}`
    )
  }
}

function addErrorTracing(
  shell: Shell | 'Custom Shell',
  cp: ChildProcess,
  onError: (error: Error) => void
) {
  if (cp.stderr !== null) {
    cp.stderr.on('data', chunk => {
      const text = chunk instanceof Buffer ? chunk.toString() : chunk
      log.debug(`[${shell}] stderr: '${text}'`)
    })
  }

  cp.on('error', err => {
    log.debug(`[${shell}] an error was encountered`, err)
    onError(err)
  })

  cp.on('exit', code => {
    if (code !== 0) {
      log.debug(`[${shell}] exit code: ${code}`)
    }
  })
}
