/** What the pipeline window shows, sent from the app to the main process. */
export interface IPipelineWindowRequest {
  /** e.g. `https://gitlab.com` or `https://example.com/gitlab`. */
  readonly webBaseUrl: string
  readonly hostname: string
  /** e.g. `group/subgroup/project`. */
  readonly projectPath: string
  readonly pipelineId: number
  /** The job to select when the window opens, if any. */
  readonly jobId: number | null
  /** For the window title. */
  readonly repositoryName: string
}

/** Validate a request that crossed a process boundary. */
export function parsePipelineWindowRequest(
  value: unknown
): IPipelineWindowRequest | null {
  const v = value as Partial<IPipelineWindowRequest> | null
  if (
    v === null ||
    typeof v !== 'object' ||
    typeof v.webBaseUrl !== 'string' ||
    !/^https?:\/\//.test(v.webBaseUrl) ||
    typeof v.hostname !== 'string' ||
    typeof v.projectPath !== 'string' ||
    typeof v.pipelineId !== 'number' ||
    !Number.isInteger(v.pipelineId)
  ) {
    return null
  }
  return {
    webBaseUrl: v.webBaseUrl,
    hostname: v.hostname,
    projectPath: v.projectPath,
    pipelineId: v.pipelineId,
    jobId: typeof v.jobId === 'number' ? v.jobId : null,
    repositoryName:
      typeof v.repositoryName === 'string' ? v.repositoryName : v.projectPath,
  }
}

/** The pipeline a window is for, so the same pipeline reuses its window. */
export function pipelineWindowKey(r: IPipelineWindowRequest) {
  return `${r.webBaseUrl}|${r.projectPath}|${r.pipelineId}`
}
