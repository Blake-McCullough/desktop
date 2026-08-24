import { parseRemote } from '../remote-parsing'

/** A parsed reference to a project (repository) hosted on a GitLab instance. */
export interface IGitLabProject {
  readonly hostname: string
  readonly projectPath: string
}

/**
 * Attempt to parse a git remote URL into a GitLab hostname and project path.
 *
 * The project path is built as `${owner}/${name}` using the generic
 * `parseRemote` parser. Note that GitLab supports arbitrarily nested
 * subgroups (e.g. `group/subgroup/project`), which this two-segment parser
 * cannot fully capture — projects nested more than one level deep will not
 * be parsed correctly. That's an accepted, known limitation rather than
 * something this function attempts to solve.
 */
export function parseGitLabProject(remoteUrl: string): IGitLabProject | null {
  const parsed = parseRemote(remoteUrl)
  if (parsed === null || !parsed.owner || !parsed.name) {
    return null
  }

  return {
    hostname: parsed.hostname,
    projectPath: `${parsed.owner}/${parsed.name}`,
  }
}

/**
 * Best-effort heuristic for whether a hostname looks like it belongs to a
 * GitLab instance. This covers `gitlab.com` and most self-hosted instances
 * that include "gitlab" in their hostname, but it's not authoritative — a
 * self-hosted instance with an unrelated hostname (e.g. `git.example.com`)
 * will not be recognized, and there's no attempt here to probe the host to
 * find out for sure.
 */
export function isLikelyGitLabHost(hostname: string): boolean {
  return hostname.toLowerCase().includes('gitlab')
}

/** A single CI/CD job status for a commit, as reported by GitLab. */
export interface IGitLabJobStatus {
  readonly id: number
  readonly name: string
  readonly status: string
}

/**
 * Fetch the most recent pipeline job statuses for the given commit SHA from
 * a GitLab instance.
 *
 * This is best-effort background data used purely for a UI indicator, so it
 * never throws: any network or HTTP error is caught, logged, and results in
 * `null` being returned.
 */
export async function fetchLatestCommitStatuses(
  hostname: string,
  projectPath: string,
  sha: string,
  token: string
): Promise<ReadonlyArray<IGitLabJobStatus> | null> {
  const url = `https://${hostname}/api/v4/projects/${encodeURIComponent(
    projectPath
  )}/repository/commits/${sha}/statuses`

  try {
    const response = await fetch(url, {
      headers: { 'PRIVATE-TOKEN': token },
    })

    if (!response.ok) {
      log.error(
        `fetchLatestCommitStatuses: request to ${url} failed with status ${response.status}`
      )
      return null
    }

    const body = await response.json()
    if (!Array.isArray(body)) {
      return null
    }

    return body.map(status => ({
      id: status.id,
      name: `${status.name ?? status.ref ?? 'job'}`,
      status: `${status.status ?? 'unknown'}`,
    }))
  } catch (e) {
    log.error(`fetchLatestCommitStatuses: failed to fetch ${url}`, e)
    return null
  }
}

/**
 * Trigger ("play") a manual GitLab CI/CD job so that it starts running.
 *
 * This is best-effort background data used purely for a UI action, so it
 * never throws: any network or HTTP error is caught, logged, and results in
 * `false` being returned.
 */
export async function playGitLabJob(
  hostname: string,
  projectPath: string,
  jobId: number,
  token: string
): Promise<boolean> {
  const url = `https://${hostname}/api/v4/projects/${encodeURIComponent(
    projectPath
  )}/jobs/${jobId}/play`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': token },
    })

    if (!response.ok) {
      log.error(
        `playGitLabJob: request to ${url} failed with status ${response.status}`
      )
      return false
    }

    return response.ok
  } catch (e) {
    log.error(`playGitLabJob: failed to fetch ${url}`, e)
    return false
  }
}

/** The color a job status dot should be rendered with. */
export type GitLabJobStatusColor = 'green' | 'red' | 'yellow' | 'grey'

/**
 * Map a GitLab commit/job status string to the color that should represent
 * it in the UI.
 */
export function getJobStatusColor(status: string): GitLabJobStatusColor {
  switch (status) {
    case 'success':
      return 'green'
    case 'failed':
      return 'red'
    case 'running':
      return 'yellow'
    case 'pending':
    case 'created':
      return 'yellow'
    case 'canceled':
    case 'skipped':
    case 'manual':
      return 'grey'
    default:
      return 'grey'
  }
}
