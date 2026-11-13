import * as Path from 'path'
import { cp, lstat, mkdir, rename, rm } from 'fs/promises'
import { getCommonRoot, mapImportPath } from './repository-import-export'

/** A repository to move: just what planning needs. */
export interface IMovableRepository {
  readonly id: number
  readonly name: string
  readonly path: string
}

/** What will happen to one repository. */
export type RepositoryMoveAction =
  /** Its folder will be moved. */
  | 'move'
  /**
   * Its folder lives inside another repository that is being moved, so it
   * moves along with that one and only its recorded path changes.
   */
  | 'carried'
  /** It's already at the target. */
  | 'unchanged'
  /** It can't be moved; see `problem`. */
  | 'blocked'

export interface IRepositoryMovePlan<T extends IMovableRepository> {
  readonly repository: T
  readonly from: string
  readonly to: string
  readonly action: RepositoryMoveAction
  /** Why the move is blocked. */
  readonly problem: string | null
}

const caseInsensitive = () => __WIN32__ || __DARWIN__

/** Normalize a path for comparison: resolved, no trailing separator. */
export function comparablePath(path: string) {
  const resolved = Path.resolve(path)
  const trimmed =
    resolved.length > 1 &&
    /[\\/]$/.test(resolved) &&
    !/^[A-Za-z]:[\\/]$/.test(resolved)
      ? resolved.slice(0, -1)
      : resolved
  return caseInsensitive() ? trimmed.toLowerCase() : trimmed
}

export function isSamePath(a: string, b: string) {
  return comparablePath(a) === comparablePath(b)
}

/** Whether `child` is strictly inside `parent`. */
export function isPathInside(child: string, parent: string) {
  const c = comparablePath(child)
  const p = comparablePath(parent)
  const prefix = p.endsWith(Path.sep) ? p : p + Path.sep
  return c.startsWith(prefix)
}

/**
 * The folder the repositories are moved relative to: their common parent
 * folder, so the layout underneath is kept.
 */
export function getMoveRoot(paths: ReadonlyArray<string>): string | null {
  if (paths.length === 1) {
    return Path.dirname(Path.resolve(paths[0]))
  }
  const root = getCommonRoot(paths)
  return root === null ? null : Path.resolve(root)
}

/**
 * Work out where each repository goes when moving them from `oldRoot` to
 * `newRoot`, keeping the folder layout below `oldRoot`. Repositories outside
 * `oldRoot` (or when there's no common root) go straight into `newRoot`.
 *
 * `exists` reports whether a path is already taken on disk. Pass
 * `singleTarget` to move a single repository to an exact path instead (which
 * also allows renaming its folder).
 */
export async function planRepositoryMoves<T extends IMovableRepository>(
  repositories: ReadonlyArray<T>,
  oldRoot: string | null,
  newRoot: string,
  exists: (path: string) => Promise<boolean>,
  singleTarget?: string
): Promise<ReadonlyArray<IRepositoryMovePlan<T>>> {
  const target = (r: T) => {
    if (singleTarget !== undefined && repositories.length === 1) {
      return Path.resolve(singleTarget)
    }
    const mapped =
      oldRoot !== null && isPathInside(r.path, oldRoot)
        ? mapImportPath(r.path, oldRoot, newRoot)
        : Path.join(newRoot, Path.basename(r.path))
    return Path.resolve(mapped)
  }

  // Outer folders first, so nested repositories can see that they're carried.
  const sorted = [...repositories].sort(
    (a, b) => comparablePath(a.path).length - comparablePath(b.path).length
  )

  const plans: IRepositoryMovePlan<T>[] = []
  const movingFolders: Array<{ from: string; to: string }> = []
  const claimedTargets = new Map<string, string>()

  for (const repository of sorted) {
    const from = Path.resolve(repository.path)
    const to = target(repository)
    const plan = (
      action: RepositoryMoveAction,
      problem: string | null = null
    ) => plans.push({ repository, from, to, action, problem })

    if (to.trim().length === 0 || !Path.isAbsolute(to)) {
      plan('blocked', 'The new location must be a full path.')
      continue
    }

    if (from === to) {
      plan('unchanged')
      continue
    }

    const carrier = movingFolders.find(m => isPathInside(from, m.from))
    if (carrier !== undefined) {
      // Expected location once the outer folder has moved.
      const expected = Path.join(carrier.to, Path.relative(carrier.from, from))
      if (isSamePath(expected, to)) {
        plans.push({ repository, from, to, action: 'carried', problem: null })
        continue
      }
      plan(
        'blocked',
        'It is inside another repository that is being moved, so it has to stay where it is inside that folder.'
      )
      continue
    }

    if (isPathInside(to, from)) {
      plan('blocked', "A folder can't be moved inside itself.")
      continue
    }

    const claimedBy = claimedTargets.get(comparablePath(to))
    if (claimedBy !== undefined) {
      plan('blocked', `“${claimedBy}” is being moved to the same place.`)
      continue
    }

    // On case-insensitive file systems renaming `Repo` to `repo` "exists".
    const caseOnlyRename =
      comparablePath(from) === comparablePath(to) && from !== to
    if (!caseOnlyRename && (await exists(to))) {
      plan('blocked', 'Something already exists at the new location.')
      continue
    }

    claimedTargets.set(comparablePath(to), repository.name)
    movingFolders.push({ from, to })
    plan('move')
  }

  // Back to the order the caller gave.
  const order = new Map(repositories.map((r, i) => [r.id, i]))
  return plans.sort(
    (a, b) =>
      (order.get(a.repository.id) ?? 0) - (order.get(b.repository.id) ?? 0)
  )
}

const pathTaken = (path: string) =>
  lstat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) =>
      e.code === 'ENOENT' ? false : Promise.reject(e)
  )

export const pathIsTaken = (path: string) => pathTaken(path).catch(() => true)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Errors Windows gives while another program has a file open. */
const isBusy = (e: NodeJS.ErrnoException) =>
  e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'

/** Thrown when a folder couldn't be moved; the message is for the user. */
export class MoveFolderError extends Error {
  public constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'MoveFolderError'
  }
}

/** The result of moving a folder. */
export interface IMoveFolderResult {
  /** The folder was copied to another drive, and the original remains. */
  readonly leftOriginalBehind: boolean
}

/**
 * Move a folder to a new path that must not exist yet. Creates missing
 * parent folders.
 *
 * Uses a rename when possible. A move to another drive or file system is
 * done by copying and then deleting the original; if the copy fails, the
 * partial copy is removed and the original is untouched.
 */
export async function moveFolder(
  from: string,
  to: string
): Promise<IMoveFolderResult> {
  const stat = await lstat(from).catch(() => null)
  if (stat === null || !stat.isDirectory()) {
    throw new MoveFolderError(`The folder ${from} doesn't exist.`)
  }

  const caseOnlyRename =
    comparablePath(from) === comparablePath(to) && from !== to
  if (!caseOnlyRename && (await pathTaken(to))) {
    throw new MoveFolderError(`Something already exists at ${to}.`)
  }

  await mkdir(Path.dirname(to), { recursive: true })

  // Windows refuses to rename a folder while anything (an editor, a
  // terminal, antivirus, the search indexer) has a file in it open, which is
  // often momentary. Retry for a few seconds before giving up.
  const delays = __WIN32__ ? [100, 250, 500, 1000, 2000] : []
  for (let attempt = 0; ; attempt++) {
    try {
      if (caseOnlyRename) {
        // Some file systems need a detour to change only the case.
        const temporary = `${from}.moving-${Date.now()}`
        await rename(from, temporary)
        await rename(temporary, to)
      } else {
        await rename(from, to)
      }
      return { leftOriginalBehind: false }
    } catch (e) {
      const error = e as NodeJS.ErrnoException
      if (error.code === 'EXDEV') {
        return copyThenRemove(from, to)
      }
      if (isBusy(error) && attempt < delays.length) {
        await sleep(delays[attempt])
        continue
      }
      if (isBusy(error)) {
        throw new MoveFolderError(
          `Couldn't move ${from} because a file in it is in use. Close any editors, terminals or other programs using it and try again.`,
          error
        )
      }
      throw new MoveFolderError(
        `Couldn't move ${from}: ${error.message}`,
        error
      )
    }
  }
}

async function copyThenRemove(
  from: string,
  to: string
): Promise<IMoveFolderResult> {
  try {
    await cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
  } catch (e) {
    // We created `to`, so clean up the partial copy. The original is intact.
    await rm(to, { recursive: true, force: true }).catch(() => undefined)
    throw new MoveFolderError(
      `Couldn't copy ${from} to ${to}: ${(e as Error).message}`,
      e
    )
  }

  try {
    await rm(from, { recursive: true, maxRetries: 5, retryDelay: 200 })
    return { leftOriginalBehind: false }
  } catch (e) {
    log.warn(`moveFolder: copied ${from} but couldn't remove it`, e)
    return { leftOriginalBehind: true }
  }
}

/**
 * Where `path` is now, given folders that have been moved: if it was inside
 * (or was) a moved folder, the same place under the new location. Otherwise
 * `path` unchanged.
 */
export function movedPath(
  path: string,
  moves: ReadonlyArray<{ readonly from: string; readonly to: string }>
): string {
  // The innermost move wins (it ran later or is more specific).
  let best: { from: string; to: string } | null = null
  for (const move of moves) {
    if (isSamePath(path, move.from) || isPathInside(path, move.from)) {
      if (best === null || move.from.length > best.from.length) {
        best = move
      }
    }
  }
  if (best === null) {
    return path
  }
  const rest = Path.relative(Path.resolve(best.from), Path.resolve(path))
  return rest.length === 0 ? best.to : Path.join(best.to, rest)
}

/** What happened to one repository that was moved (or carried along). */
export interface IRepositoryMoveResult<
  T extends IMovableRepository = IMovableRepository
> {
  readonly repository: T
  readonly to: string
  /** Why the move failed, or null if it worked. */
  readonly error: string | null
  /**
   * The folder was copied to another drive but the original couldn't be
   * fully deleted.
   */
  readonly leftOriginalBehind: boolean
}
