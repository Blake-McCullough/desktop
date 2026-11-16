import { CustomUpdateRepository } from './custom-update'

const repository = `https://github.com/${CustomUpdateRepository}`

/**
 * Links to this custom build's own project pages, used wherever the app
 * would otherwise send people to GitHub Desktop's (release notes, issue
 * tracker, about pages). Links to GitHub.com itself (accounts, support,
 * Git help) are left as they are.
 */
export const CustomLinks = {
  repository,
  releases: `${repository}/releases`,
  issues: `${repository}/issues`,
  newIssue: `${repository}/issues/new`,
  readme: `${repository}#readme`,
  /** A file in the repository's docs, e.g. `docs/integrations`. */
  doc: (path: string) =>
    `${repository}/${/\.[a-z]+$/i.test(path) ? 'blob' : 'tree'}/main/${path}`,
} as const
