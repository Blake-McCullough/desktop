import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'
import {
  clearGitLabProjectCache,
  fetchGitLabProjects,
  IGitLabCloneableProject,
  resetGitLabRequestBudgets,
  toCloneableProject,
} from '../../src/lib/gitlab/gitlab-api'
import {
  getCloneableGitLabInstances,
  getInitialGitLabInstance,
  GitLabDotComUrl,
  groupGitLabProjects,
  rememberGitLabCredential,
  setLastGitLabInstance,
} from '../../src/lib/gitlab/gitlab-clone'
import { setGitLabInstanceUrls } from '../../src/lib/gitlab/gitlab-token'
import {
  getGenericUsername,
  setGenericUsername,
} from '../../src/lib/generic-git-auth'

const realFetch = globalThis.fetch

const apiProject = (id: number, path: string, kind = 'group') => {
  const ns = path.slice(0, path.lastIndexOf('/'))
  return {
    id,
    name: path.split('/').at(-1) ?? path,
    path_with_namespace: path,
    http_url_to_repo: `https://gitlab.example.com/${path}.git`,
    ssh_url_to_repo: `git@gitlab.example.com:${path}.git`,
    web_url: `https://gitlab.example.com/${path}`,
    default_branch: 'main',
    visibility: 'private',
    namespace: { name: ns, full_path: ns, kind },
  }
}

let nextId = 100
const project = (path: string, kind = 'group') =>
  toCloneableProject(apiProject(nextId++, path, kind))!

describe('GitLab project listing', () => {
  beforeEach(() => {
    resetGitLabRequestBudgets()
    clearGitLabProjectCache()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('pages through every membership project', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(`${input}`)
      calls.push(url.toString())
      if (url.pathname.endsWith('/user')) {
        return Response.json({ username: 'blake' })
      }
      const page = url.searchParams.get('page')
      assert.equal(url.searchParams.get('membership'), 'true')
      const body =
        page === '1'
          ? [apiProject(1, 'acme/api'), apiProject(2, 'acme/web')]
          : [apiProject(3, 'blake/dotfiles', 'user'), apiProject(1, 'acme/api')]
      return Response.json(body, {
        headers: { 'x-next-page': page === '1' ? '2' : '' },
      })
    }) as typeof fetch

    const list = await fetchGitLabProjects(
      'https://gitlab.example.com',
      'token'
    )
    assert.equal(list.username, 'blake')
    assert.deepEqual(list.projects.map(p => p.pathWithNamespace).sort(), [
      'acme/api',
      'acme/web',
      'blake/dotfiles',
    ])
    assert.equal(list.truncated, false)
    assert.equal(calls.filter(c => c.includes('/projects?')).length, 2)

    // Cached: no more requests.
    await fetchGitLabProjects('https://gitlab.example.com', 'token')
    assert.equal(calls.length, 3)

    // A different token isn't served from the cache.
    await fetchGitLabProjects('https://gitlab.example.com', 'other')
    assert.equal(calls.length, 6)
  })

  it('does not cache failures', async () => {
    let fail = true
    globalThis.fetch = (async (input: string | URL) => {
      if (fail) {
        return Response.json({ message: '401 Unauthorized' }, { status: 401 })
      }
      return `${input}`.endsWith('/user')
        ? Response.json({ username: 'blake' })
        : Response.json([])
    }) as typeof fetch

    await assert.rejects(
      fetchGitLabProjects('https://gitlab.example.com', 'token')
    )
    fail = false
    const list = await fetchGitLabProjects(
      'https://gitlab.example.com',
      'token'
    )
    assert.equal(list.projects.length, 0)
  })

  it('skips malformed entries', () => {
    assert.equal(toCloneableProject({ id: 'x' } as any), null)
    const p = toCloneableProject({
      id: 9,
      name: 'svc',
      path_with_namespace: 'a/b/svc',
      http_url_to_repo: 'https://h/a/b/svc.git',
    })
    assert.equal(p?.namespaceFullPath, 'a/b')
    assert.equal(p?.isFork, false)
  })
})

describe('groupGitLabProjects', () => {
  it('puts the personal namespace first and subgroups after parents', () => {
    const projects: IGitLabCloneableProject[] = [
      project('beta/z'),
      project('acme-tools/x'),
      project('acme/backend/b'),
      project('acme/a2'),
      project('acme/a1'),
      project('blake/dots', 'user'),
    ]
    const groups = groupGitLabProjects(projects, 'Blake')
    assert.deepEqual(
      groups.map(g => g.fullPath),
      ['blake', 'acme', 'acme/backend', 'acme-tools', 'beta']
    )
    assert.equal(groups[0].isPersonal, true)
    assert.equal(groups[2].depth, 1)
    assert.deepEqual(
      groups[1].projects.map(p => p.name),
      ['a1', 'a2']
    )
  })
})

describe('GitLab instances', () => {
  afterEach(() => {
    setGitLabInstanceUrls([])
    localStorage.clear()
  })

  it('offers configured instances, then gitlab.com', () => {
    setGitLabInstanceUrls(['git.example.com/', 'https://gitlab.com'])
    const instances = getCloneableGitLabInstances()
    assert.deepEqual(instances, ['https://git.example.com', GitLabDotComUrl])
    assert.equal(getInitialGitLabInstance(instances), 'https://git.example.com')
    setLastGitLabInstance(GitLabDotComUrl)
    assert.equal(getInitialGitLabInstance(instances), GitLabDotComUrl)
  })
})

describe('rememberGitLabCredential', () => {
  afterEach(() => localStorage.clear())

  it('never saves a credential for plain HTTP or SSH', async () => {
    assert.equal(
      await rememberGitLabCredential('http://h.example/a/b.git', 'u', 't'),
      false
    )
    assert.equal(
      await rememberGitLabCredential('git@h.example:a/b.git', 'u', 't'),
      false
    )
  })

  it("doesn't replace a credential the user saved", async () => {
    setGenericUsername('https://h.example/', 'someone')
    assert.equal(
      await rememberGitLabCredential('https://h.example/a/b.git', 'u', 't'),
      false
    )
    assert.equal(getGenericUsername('https://h.example/'), 'someone')
  })
})
