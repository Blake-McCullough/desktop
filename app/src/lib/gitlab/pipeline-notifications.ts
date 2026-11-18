import { getBoolean, setBoolean } from '../local-storage'
import { IGitLabJobStatus, IGitLabPipelineInfo } from './gitlab-api'

/** Which pipeline events produce a desktop notification. */
export interface IPipelineNotificationSettings {
  /** The pipeline for your pushed commit passed. */
  readonly passed: boolean
  /** The pipeline for your pushed commit failed. */
  readonly failed: boolean
  /** The pipeline stopped at a manual job that's waiting for you. */
  readonly manual: boolean
}

export type PipelineNotificationKind = keyof IPipelineNotificationSettings

export const DefaultPipelineNotificationSettings: IPipelineNotificationSettings =
  { passed: true, failed: true, manual: true }

const DefaultKeyPrefix = 'gitlab-pipeline-notifications-'
const OverridesKey = 'gitlab-pipeline-notification-overrides'
const Kinds: ReadonlyArray<PipelineNotificationKind> = [
  'passed',
  'failed',
  'manual',
]

/** The settings used for repositories that don't override them. */
export function getDefaultPipelineNotificationSettings(): IPipelineNotificationSettings {
  return {
    passed: getBoolean(DefaultKeyPrefix + 'passed', true),
    failed: getBoolean(DefaultKeyPrefix + 'failed', true),
    manual: getBoolean(DefaultKeyPrefix + 'manual', true),
  }
}

export function setDefaultPipelineNotificationSettings(
  settings: IPipelineNotificationSettings
) {
  for (const kind of Kinds) {
    setBoolean(DefaultKeyPrefix + kind, settings[kind])
  }
}

function readOverrides(): Record<string, IPipelineNotificationSettings> {
  try {
    const raw = localStorage.getItem(OverridesKey)
    const parsed = raw === null ? null : JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function toSettings(value: unknown): IPipelineNotificationSettings | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const v = value as Record<string, unknown>
  return {
    passed: v.passed === true,
    failed: v.failed === true,
    manual: v.manual === true,
  }
}

/**
 * A repository's own settings, or null when it follows the defaults.
 */
export function getRepositoryPipelineNotificationOverride(
  repositoryId: number
): IPipelineNotificationSettings | null {
  return toSettings(readOverrides()[String(repositoryId)])
}

/** Pass null to make the repository follow the defaults again. */
export function setRepositoryPipelineNotificationOverride(
  repositoryId: number,
  settings: IPipelineNotificationSettings | null
) {
  const overrides = readOverrides()
  if (settings === null) {
    delete overrides[String(repositoryId)]
  } else {
    overrides[String(repositoryId)] = { ...settings }
  }
  localStorage.setItem(OverridesKey, JSON.stringify(overrides))
}

/** The settings that apply to a repository right now. */
export function getPipelineNotificationSettings(
  repositoryId: number
): IPipelineNotificationSettings {
  return (
    getRepositoryPipelineNotificationOverride(repositoryId) ??
    getDefaultPipelineNotificationSettings()
  )
}

/* ------------------------------------------------------------------------ */

/** What the store knew about a repository's pushed commit at one point. */
export interface IPipelineSnapshot {
  readonly pushedSha: string | null
  readonly pipeline: IGitLabPipelineInfo | null
  /** We'd just pushed and were waiting for GitLab to create a pipeline. */
  readonly awaitingPipeline: boolean
}

export interface IPipelineNotification {
  readonly kind: PipelineNotificationKind
  readonly pipeline: IGitLabPipelineInfo
  /** The manual jobs waiting to be run (for `manual`). */
  readonly manualJobs: ReadonlyArray<IGitLabJobStatus>
}

/** Jobs that are actually doing something (or about to). */
const BusyJobStatuses: ReadonlySet<string> = new Set([
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
])

function isBusy(pipeline: IGitLabPipelineInfo) {
  return (
    pipeline.status === 'running' ||
    pipeline.status === 'pending' ||
    pipeline.jobs.some(j => BusyJobStatuses.has(j.status))
  )
}

/**
 * The manual jobs a pipeline is waiting on: it has manual jobs and nothing
 * else is running, so it won't go any further until someone runs one.
 */
export function getWaitingManualJobs(
  pipeline: IGitLabPipelineInfo
): ReadonlyArray<IGitLabJobStatus> {
  if (isBusy(pipeline)) {
    return []
  }
  return pipeline.jobs.filter(j => j.status === 'manual')
}

/**
 * Whether the pipeline was still working the last time we looked, i.e. a
 * finished or waiting state now is news rather than something that was
 * already true when we started watching.
 */
function wasWorking(
  previous: IPipelineSnapshot,
  next: IGitLabPipelineInfo
): boolean {
  const prev = previous.pipeline
  if (prev === null) {
    // GitLab created this pipeline while we were waiting for it.
    return previous.awaitingPipeline
  }
  if (prev.id !== undefined && next.id !== undefined && prev.id !== next.id) {
    // A new pipeline for the same commit (e.g. run again from GitLab).
    return true
  }
  return isBusy(prev) || prev.status === 'created'
}

/**
 * Decide whether a change in a repository's pushed-commit pipeline deserves
 * a notification. Only changes we saw happen count: nothing fires for the
 * state we find at startup, after switching branches or after pulling
 * someone else's commits whose pipeline had already finished.
 */
export function getPipelineNotification(
  previous: IPipelineSnapshot | undefined,
  next: IPipelineSnapshot,
  settings: IPipelineNotificationSettings
): IPipelineNotification | null {
  const pipeline = next.pipeline
  if (
    previous === undefined ||
    pipeline === null ||
    next.pushedSha === null ||
    previous.pushedSha !== next.pushedSha ||
    // That's another commit's pipeline (the pushed one has none).
    pipeline.fallbackRef !== undefined
  ) {
    return null
  }

  const manualJobs = getWaitingManualJobs(pipeline)
  const prevManualJobs =
    previous.pipeline !== null && previous.pipeline.id === pipeline.id
      ? getWaitingManualJobs(previous.pipeline)
      : []
  const newlyWaiting =
    manualJobs.length > 0 &&
    manualJobs.some(j => !prevManualJobs.some(p => p.id === j.id))

  if (!wasWorking(previous, pipeline)) {
    return null
  }

  if (pipeline.status === 'failed') {
    return settings.failed ? { kind: 'failed', pipeline, manualJobs } : null
  }

  if (newlyWaiting && settings.manual) {
    return { kind: 'manual', pipeline, manualJobs }
  }

  if (pipeline.status === 'success' && settings.passed) {
    return { kind: 'passed', pipeline, manualJobs }
  }

  return null
}

/** Title and body for a notification. */
export function describePipelineNotification(
  notification: IPipelineNotification,
  repositoryName: string
): { readonly title: string; readonly body: string } {
  const { pipeline, kind, manualJobs } = notification
  const what =
    pipeline.id !== undefined ? `Pipeline #${pipeline.id}` : 'The pipeline'
  const commit = pipeline.sha.slice(0, 8)

  switch (kind) {
    case 'failed': {
      const failed = pipeline.jobs
        .filter(j => j.status === 'failed')
        .map(j => j.name)
      const jobs =
        failed.length === 0
          ? ''
          : failed.length <= 3
          ? ` (${failed.join(', ')})`
          : ` (${failed.slice(0, 3).join(', ')} and ${failed.length - 3} more)`
      return {
        title: `${repositoryName}: pipeline failed`,
        body: `${what} for ${commit} failed${jobs}.`,
      }
    }
    case 'manual': {
      const names = manualJobs.map(j => j.name)
      const list =
        names.length <= 3
          ? names.join(', ')
          : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
      return {
        title: `${repositoryName}: waiting for a manual job`,
        body:
          pipeline.status === 'success'
            ? `${what} for ${commit} passed and ${list} is ready to run.`
            : `${what} for ${commit} is waiting for you to run ${list}.`,
      }
    }
    case 'passed':
      return {
        title: `${repositoryName}: pipeline passed`,
        body: `${what} for ${commit} passed.`,
      }
  }
}
