import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'
import {
  GitLabPipelineResolver,
  fetchPipelineForCommit,
  getGitLabRateLimitedUntil,
  parseGitLabProject,
  probeGitLabHost,
  resetGitLabRequestBudgets,
} from '../../src/lib/gitlab/gitlab-api'

const project = parseGitLabProject('git@gitlab.example.com:team/app.git')!
const realFetch = globalThis.fetch

type Route = (
  url: string
) =>
  | { status: number; body: unknown; headers?: Record<string, string> }
  | undefined

function mockFetch(route: Route) {
  const calls: Array<string> = []
  globalThis.fetch = (async (input: string | URL) => {
    const url = `${input}`
    calls.push(url)
    const r = route(url) ?? { status: 404, body: { message: '404 Not Found' } }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    })
  }) as typeof fetch
  return calls
}

const recentUrl = 'pipelines?order_by=id&sort=desc&per_page=100'
const pipeline = (
  id: number,
  sha: string,
  status = 'success',
  ref = 'main'
) => ({
  id,
  sha,
  ref,
  status,
  updated_at: `2026-11-10T00:00:0${id % 10}Z`,
})
const job = (id: number, status = 'success') => ({
  id,
  name: `job${id}`,
  status,
  stage: 'test',
})

describe('GitLab pipelines', () => {
  beforeEach(() => resetGitLabRequestBudgets())
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('finds a commit in the recent pipelines and loads its jobs', async () => {
    mockFetch(url =>
      url.includes(recentUrl)
        ? { status: 200, body: [pipeline(5, 'abc', 'running')] }
        : url.includes('/pipelines/5/jobs')
        ? { status: 200, body: [job(2), job(1, 'running')] }
        : undefined
    )
    const p = await fetchPipelineForCommit(project, 'abc', 't', 'main')
    assert.equal(p?.status, 'running')
    assert.deepEqual(
      p?.jobs.map(j => j.id),
      [1, 2]
    )
    assert.equal(p?.fallbackRef, undefined)
  })

  it("falls back to the branch's latest pipeline for unpushed commits", async () => {
    mockFetch(url =>
      url.includes(recentUrl)
        ? { status: 200, body: [pipeline(9, 'other', 'success', 'feature/x')] }
        : url.includes('/pipelines/9/jobs')
        ? { status: 200, body: [job(1)] }
        : undefined
    )
    const p = await fetchPipelineForCommit(project, 'abc', 't', 'feature/x')
    assert.equal(p?.fallbackRef, 'feature/x')
    assert.equal(p?.jobs.length, 1)
  })

  it('uses commit statuses when the pipelines API is forbidden', async () => {
    mockFetch(url =>
      url.includes('/pipelines?')
        ? { status: 403, body: { message: '403 Forbidden' } }
        : url.includes('/statuses')
        ? {
            status: 200,
            body: [
              { id: 1, name: 'build', status: 'failed' },
              { id: 3, name: 'build', status: 'success' },
            ],
          }
        : undefined
    )
    const p = await fetchPipelineForCommit(project, 'abc', 't', 'main')
    assert.equal(p?.status, 'success')
    assert.equal(p?.jobs.length, 1)
  })

  it('shares one recent-pipelines request and reuses unchanged jobs', async () => {
    const calls = mockFetch(url =>
      url.includes(recentUrl)
        ? {
            status: 200,
            body: [pipeline(3, 'c3'), pipeline(2, 'c2'), pipeline(1, 'c1')],
          }
        : url.includes('/jobs')
        ? { status: 200, body: [job(1)] }
        : undefined
    )

    const resolver = new GitLabPipelineResolver()
    const options = { maxAgeMs: 60000, allowShaLookup: true }
    await Promise.all(
      ['c1', 'c2', 'c3', 'c3', 'none'].map(sha =>
        resolver.resolve(project, sha, 't', options)
      )
    )
    // Asking again doesn't hit the network at all.
    await resolver.resolve(project, 'c2', 't', options)

    assert.equal(calls.filter(u => u.includes(recentUrl)).length, 1)
    assert.equal(calls.filter(u => u.includes('/jobs')).length, 3)
    // Fewer than 100 recent pipelines means "none" definitely has none, so
    // no per-commit lookup was needed.
    assert.equal(calls.filter(u => u.includes('pipelines?sha=')).length, 0)
  })

  it('pauses all requests after a 429 instead of retrying', async () => {
    const calls = mockFetch(() => ({
      status: 429,
      body: { message: 'Retry later' },
      headers: { 'Retry-After': '120' },
    }))

    await assert.rejects(
      fetchPipelineForCommit(project, 'abc', 't', null),
      (e: { status: number }) => e.status === 429
    )
    assert.equal(calls.length, 1)

    const until = getGitLabRateLimitedUntil()
    assert.ok(until !== null && until - Date.now() > 100 * 1000)

    // While paused, nothing reaches the network.
    await assert.rejects(fetchPipelineForCommit(project, 'abc', 't', null))
    assert.equal(calls.length, 1)
  })

  it('throws for a rejected token', async () => {
    mockFetch(() => ({ status: 401, body: { message: '401 Unauthorized' } }))
    await assert.rejects(
      fetchPipelineForCommit(project, 'abc', 't', null),
      (e: { status: number }) => e.status === 401
    )
  })
})

describe('probeGitLabHost', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('recognizes GitLab by its anonymous API response', async () => {
    const calls = mockFetch(() => ({
      status: 401,
      body: { message: '401 Unauthorized' },
    }))
    assert.equal(await probeGitLabHost('https://git.corp.example'), true)
    assert.equal(calls[0], 'https://git.corp.example/api/v4/version')
  })

  it('rejects other servers and never probes known non-GitLab hosts', async () => {
    const calls = mockFetch(() => ({ status: 404, body: {} }))
    assert.equal(await probeGitLabHost('https://git.other.example'), false)
    assert.equal(await probeGitLabHost('https://github.com'), false)
    assert.equal(calls.length, 1)
  })
})
