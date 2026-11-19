/** What the main process knows about the running app, for bug reports. */
export interface IMainProcessDebugInfo {
  readonly appVersion: string
  readonly electron: string
  readonly chrome: string
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly osRelease: string
  /** How this copy was installed (Windows Setup, Arch package, …). */
  readonly installKind: string
  /** The newest log file's last lines (not yet redacted). */
  readonly logTail: string
  readonly logFileName: string | null
}

export interface IDebugInfoInput {
  readonly appName: string
  readonly main: IMainProcessDebugInfo
  /** e.g. "Ubuntu 24.04" or "Windows 11". */
  readonly os: string
  readonly gitVersion: string | null
  readonly theme: string
  readonly repositoryCount: number
  readonly groupCount: number
  /** GitLab servers in use, and whether each has a token (never the token). */
  readonly gitLabServers: ReadonlyArray<{
    readonly host: string
    readonly hasToken: boolean
  }>
  readonly sidebarVisible: boolean
  readonly systemMenuBar: boolean | null
  /** The user's home folder, replaced with ~ in the log. */
  readonly homeDirectory: string
}

/** Secrets that must never end up in a bug report, and what replaces them. */
const SecretPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  // GitLab tokens (personal, project, group, deploy, CI job, runner…)
  [
    /\b(?:glpat|gloas|gldt|glrt|glcbt|glptt|glft|glimt|glagent|glsoat|glffct)-[A-Za-z0-9_-]{10,}/g,
    '[redacted]',
  ],
  // GitHub tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  // Header values: keep the header's name
  [
    /(PRIVATE-TOKEN|Authorization|JOB-TOKEN)(["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+|token\s+)?[^\s"',}]+/gi,
    '$1$2[redacted]',
  ],
  // Passwords in URLs: https://user:secret@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[redacted]@'],
]

/**
 * Remove secrets and the home folder path from log text before it's shown
 * or copied.
 */
export function redactLogText(text: string, homeDirectory: string): string {
  let result = text
  for (const [pattern, replacement] of SecretPatterns) {
    result = result.replace(pattern, replacement)
  }
  if (homeDirectory.length > 1) {
    const escaped = homeDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(escaped, 'g'), '~')
    // Windows paths also show up with forward slashes.
    if (homeDirectory.includes('\\')) {
      const forward = homeDirectory
        .replace(/\\/g, '/')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(forward, 'gi'), '~')
    }
  }
  return result
}

/** The text copied by Help → Copy debug info. */
export function formatDebugInfo(input: IDebugInfoInput): string {
  const { main } = input
  const servers =
    input.gitLabServers.length === 0
      ? 'none'
      : input.gitLabServers
          .map(s => `${s.host} (${s.hasToken ? 'token set' : 'no token'})`)
          .join(', ')

  const lines = [
    `${input.appName} ${main.appVersion}`,
    '',
    `OS: ${input.os} (${main.platform} ${main.arch}${
      input.os.includes(main.osRelease) ? '' : `, ${main.osRelease}`
    })`,
    `Installed via: ${main.installKind}`,
    `Electron ${main.electron}, Chrome ${main.chrome}, Node ${main.node}`,
    `Git: ${input.gitVersion ?? 'unknown'}`,
    `Theme: ${input.theme}`,
    `Repositories: ${input.repositoryCount} in ${input.groupCount} groups`,
    `Repositories sidebar: ${input.sidebarVisible ? 'shown' : 'hidden'}`,
    input.systemMenuBar === null
      ? null
      : `Menu bar: ${input.systemMenuBar ? 'system' : 'in-app'}`,
    `GitLab servers: ${servers}`,
  ].filter((l): l is string => l !== null)

  const tail = redactLogText(main.logTail, input.homeDirectory).trimEnd()
  if (tail.length > 0) {
    lines.push(
      '',
      `Recent log (${
        main.logFileName ?? 'latest'
      }, tokens and home folder removed):`,
      '```',
      tail,
      '```'
    )
  }
  return lines.join('\n')
}
