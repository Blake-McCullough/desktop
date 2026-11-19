import { IGitLabProject, gitLabProjectRequest } from './gitlab-api'

/** An open merge request, as listed. */
export interface IMergeRequest {
  /** The project-scoped number, shown as `!iid`. */
  readonly iid: number
  readonly title: string
  readonly webUrl: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly authorName: string
  readonly authorUsername: string
  readonly draft: boolean
  readonly updatedAt: string | null
  /** True when the source branch lives in a fork. */
  readonly isFromFork: boolean
  readonly hasConflicts: boolean
  readonly commentCount: number
}

/** The current branch's merge request, with what decides if it can merge. */
export interface IMergeRequestDetails extends IMergeRequest {
  /**
   * GitLab's verdict, e.g. `mergeable`, `not_approved`, `ci_must_pass`,
   * `conflict`, `draft_status`, `discussions_not_resolved`, `checking`.
   */
  readonly mergeStatus: string | null
  readonly pipeline: {
    readonly id: number
    readonly status: string
    readonly webUrl: string
    readonly sha: string
  } | null
  readonly approvals: IMergeRequestApprovals | null
}

export interface IMergeRequestApprovals {
  readonly approved: boolean
  readonly required: number
  readonly left: number
  readonly approvedBy: ReadonlyArray<string>
}

interface IApiMergeRequest {
  readonly iid: number
  readonly title?: string
  readonly web_url?: string
  readonly source_branch: string
  readonly target_branch: string
  readonly author?: { readonly name?: string; readonly username?: string }
  readonly draft?: boolean
  readonly work_in_progress?: boolean
  readonly updated_at?: string
  readonly project_id?: number
  readonly source_project_id?: number
  readonly target_project_id?: number
  readonly has_conflicts?: boolean
  readonly user_notes_count?: number
  readonly detailed_merge_status?: string
  readonly merge_status?: string
  readonly head_pipeline?: {
    readonly id: number
    readonly status: string
    readonly web_url?: string
    readonly sha?: string
  } | null
  readonly pipeline?: IApiMergeRequest['head_pipeline']
}

interface IApiApprovals {
  readonly approved?: boolean
  readonly approvals_required?: number
  readonly approvals_left?: number
  readonly approved_by?: ReadonlyArray<{
    readonly user?: { readonly name?: string; readonly username?: string }
  }>
}

export function toMergeRequest(api: IApiMergeRequest): IMergeRequest {
  const target = api.target_project_id ?? api.project_id
  return {
    iid: api.iid,
    title: api.title ?? `!${api.iid}`,
    webUrl: api.web_url ?? '',
    sourceBranch: api.source_branch,
    targetBranch: api.target_branch,
    authorName: api.author?.name ?? api.author?.username ?? '',
    authorUsername: api.author?.username ?? '',
    draft: api.draft === true || api.work_in_progress === true,
    updatedAt: api.updated_at ?? null,
    isFromFork:
      api.source_project_id !== undefined &&
      target !== undefined &&
      api.source_project_id !== target,
    hasConflicts: api.has_conflicts === true,
    commentCount: api.user_notes_count ?? 0,
  }
}

export function toApprovals(api: IApiApprovals): IMergeRequestApprovals {
  return {
    approved: api.approved === true,
    required: api.approvals_required ?? 0,
    left: api.approvals_left ?? 0,
    approvedBy: (api.approved_by ?? [])
      .map(a => a.user?.name ?? a.user?.username)
      .filter((n): n is string => typeof n === 'string'),
  }
}

/** At most this many open merge requests are listed. */
const MaxMergeRequests = 100

/** The project's open merge requests, most recently updated first. */
export async function fetchOpenMergeRequests(
  project: IGitLabProject,
  token: string
): Promise<ReadonlyArray<IMergeRequest>> {
  const list = await gitLabProjectRequest<ReadonlyArray<IApiMergeRequest>>(
    project,
    `/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${MaxMergeRequests}`,
    token
  )
  return (list ?? []).map(toMergeRequest)
}

/**
 * One merge request with its pipeline and approvals. Approvals need GitLab
 * Premium on some versions; without them they're simply `null`.
 */
export async function fetchMergeRequestDetails(
  project: IGitLabProject,
  iid: number,
  token: string
): Promise<IMergeRequestDetails> {
  const [api, approvals] = await Promise.all([
    gitLabProjectRequest<IApiMergeRequest>(
      project,
      `/merge_requests/${iid}`,
      token
    ),
    gitLabProjectRequest<IApiApprovals>(
      project,
      `/merge_requests/${iid}/approvals`,
      token
    ).catch(() => null),
  ])
  const pipeline = api.head_pipeline ?? api.pipeline ?? null
  return {
    ...toMergeRequest(api),
    mergeStatus: api.detailed_merge_status ?? api.merge_status ?? null,
    pipeline:
      pipeline === null
        ? null
        : {
            id: pipeline.id,
            status: pipeline.status,
            webUrl: pipeline.web_url ?? '',
            sha: pipeline.sha ?? '',
          },
    approvals: approvals === null ? null : toApprovals(approvals),
  }
}

/**
 * GitLab's "New merge request" page for a branch, with the source (and
 * optionally target) branch filled in. Like GitHub Desktop's "Create pull
 * request", the merge request is written on GitLab.
 */
export function getCreateMergeRequestUrl(
  project: Pick<IGitLabProject, 'webBaseUrl' | 'projectPath'>,
  sourceBranch: string,
  targetBranch?: string
): string {
  const params = new URLSearchParams()
  params.set('merge_request[source_branch]', sourceBranch)
  if (targetBranch !== undefined) {
    params.set('merge_request[target_branch]', targetBranch)
  }
  return `${project.webBaseUrl}/${
    project.projectPath
  }/-/merge_requests/new?${params.toString()}`
}

/** A short, human description of GitLab's `detailed_merge_status`. */
export function describeMergeStatus(status: string | null): string | null {
  switch (status) {
    case null:
    case 'unchecked':
    case 'checking':
    case 'preparing':
      return null
    case 'mergeable':
      return 'Ready to merge'
    case 'not_approved':
      return 'Needs approval'
    case 'ci_must_pass':
      return 'Pipeline must pass'
    case 'ci_still_running':
      return 'Pipeline still running'
    case 'conflict':
      return 'Has conflicts'
    case 'draft_status':
      return 'Draft'
    case 'discussions_not_resolved':
      return 'Unresolved threads'
    case 'need_rebase':
      return 'Needs a rebase'
    case 'blocked_status':
      return 'Blocked by another merge request'
    case 'requested_changes':
      return 'Changes requested'
    case 'not_open':
      return 'Not open'
    default:
      return status.replace(/_/g, ' ')
  }
}
