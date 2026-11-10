import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert'
import {
  fetchPipelineForCommit,
  parseGitLabProject,
  probeGitLabHost,
} from '../../src/lib/gitlab/gitlab-api'

const project = parseGitLabProject('git@gitlab.example.com:team/app.git')!
const realFetch = globalThis.fetch

type Route = (url: string) => { status: number; body: unknown } | undefined

function mockFetch(route: Route) {
  const calls: Array<string> = []
  globalThis.fetch = (async (input: string | URL) => {
    const url = `${input}`
    calls.push(url)
    const r = route(url) ?? { status: 404, body: { message: '404 Not Found' } }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

const job = (id: number, status = 'success') => ({
  id,
  name: `job${id}`,
  status,
  stage: 'test',
})

describe('fetchPipelineForCommit', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('uses the commit pipeline when there is one', async () => {
    mockFetch(url =>
      url.includes('pipelines?sha=')
        ? { status: 200, body: [{ id: 5, status: 'running' }] }
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

  it('falls back to commit statuses when pipelines are forbidden', async () => {
    mockFetch(url =>
      url.includes('pipelines?sha=')
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

  it("falls back to the branch's latest pipeline for unpushed commits", async () => {
    mockFetch(url =>
      url.includes('pipelines?sha=')
        ? { status: 200, body: [] }
        : url.includes('/statuses')
        ? { status: 404, body: { message: '404 Commit Not Found' } }
        : url.includes('pipelines?ref=feature%2Fx')
        ? { status: 200, body: [{ id: 9, status: 'success' }] }
        : url.includes('/pipelines/9/jobs')
        ? { status: 200, body: [job(1)] }
        : undefined
    )
    const p = await fetchPipelineForCommit(project, 'abc', 't', 'feature/x')
    assert.equal(p?.fallbackRef, 'feature/x')
    assert.equal(p?.jobs.length, 1)
  })

  it('returns null when nothing exists, without throwing', async () => {
    mockFetch(url =>
      url.includes('/pipelines?') ? { status: 200, body: [] } : undefined
    )
    assert.equal(await fetchPipelineForCommit(project, 'abc', 't', null), null)
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
