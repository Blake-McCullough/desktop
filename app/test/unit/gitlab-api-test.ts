import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  getAggregateStatus,
  getJobStatusColor,
  isActiveStatus,
  normalizeInstanceUrl,
  parseGitLabProject,
  resolveGitLabInstance,
} from '../../src/lib/gitlab/gitlab-api'

describe('GitLab API helpers', () => {
  describe('parseGitLabProject', () => {
    it('parses HTTPS remotes', () => {
      const p = parseGitLabProject('https://gitlab.com/group/project.git')
      assert.deepStrictEqual(p, {
        hostname: 'gitlab.com',
        projectPath: 'group/project',
        webBaseUrl: 'https://gitlab.com',
      })
    })

    it('keeps nested subgroups', () => {
      const p = parseGitLabProject('https://gitlab.com/a/b/c/project.git')
      assert.equal(p?.projectPath, 'a/b/c/project')
    })

    it('parses scp-style SSH remotes with subgroups', () => {
      const p = parseGitLabProject('git@gitlab.example.com:team/sub/app.git')
      assert.equal(p?.hostname, 'gitlab.example.com')
      assert.equal(p?.projectPath, 'team/sub/app')
      assert.equal(p?.webBaseUrl, 'https://gitlab.example.com')
    })

    it('ignores the SSH port when working out the web URL', () => {
      const p = parseGitLabProject(
        'ssh://git@gitlab.example.com:2222/team/app.git'
      )
      assert.equal(p?.webBaseUrl, 'https://gitlab.example.com')
      assert.equal(p?.projectPath, 'team/app')
    })

    it('keeps the scheme and port for HTTP remotes', () => {
      const p = parseGitLabProject('http://git.local:8080/team/app')
      assert.equal(p?.webBaseUrl, 'http://git.local:8080')
    })

    it('rejects remotes without a namespace', () => {
      assert.equal(parseGitLabProject('https://gitlab.com/project.git'), null)
      assert.equal(parseGitLabProject('not a url'), null)
    })
  })

  describe('resolveGitLabInstance', () => {
    it('detects hosts containing "gitlab"', () => {
      const p = parseGitLabProject('git@gitlab.com:a/b.git')!
      assert.equal(resolveGitLabInstance(p, [])?.hostname, 'gitlab.com')
    })

    it('ignores other hosts unless configured', () => {
      const p = parseGitLabProject('git@git.example.com:a/b.git')!
      assert.equal(resolveGitLabInstance(p, []), null)
      assert.equal(
        resolveGitLabInstance(p, ['https://git.example.com'])?.webBaseUrl,
        'https://git.example.com'
      )
    })

    it('strips an instance sub path from the project path', () => {
      const p = parseGitLabProject('https://example.com/gitlab/team/app.git')!
      const r = resolveGitLabInstance(p, ['https://example.com/gitlab'])
      assert.equal(r?.projectPath, 'team/app')
      assert.equal(r?.webBaseUrl, 'https://example.com/gitlab')
    })
  })

  it('normalizes instance URLs', () => {
    assert.equal(
      normalizeInstanceUrl(' git.example.com/ '),
      'https://git.example.com'
    )
    assert.equal(
      normalizeInstanceUrl('http://Example.com/gitlab/'),
      'http://example.com/gitlab'
    )
    assert.equal(normalizeInstanceUrl(''), null)
  })

  it('aggregates statuses worst-first', () => {
    assert.equal(
      getAggregateStatus([{ status: 'success' }, { status: 'failed' }]),
      'failed'
    )
    assert.equal(
      getAggregateStatus([{ status: 'success' }, { status: 'running' }]),
      'running'
    )
    assert.equal(getAggregateStatus([{ status: 'success' }]), 'success')
    assert.equal(getAggregateStatus([]), 'unknown')
  })

  it('classifies statuses', () => {
    assert.equal(isActiveStatus('running'), true)
    assert.equal(isActiveStatus('success'), false)
    assert.equal(getJobStatusColor('running'), 'blue')
    assert.equal(getJobStatusColor('waiting_for_resource'), 'yellow')
    assert.equal(getJobStatusColor('manual'), 'grey')
  })
})
