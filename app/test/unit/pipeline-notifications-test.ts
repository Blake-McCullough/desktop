import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  DefaultPipelineNotificationSettings,
  IPipelineSnapshot,
  describePipelineNotification,
  getPipelineNotification,
  getWaitingManualJobs,
} from '../../src/lib/gitlab/pipeline-notifications'
import {
  IGitLabJobStatus,
  IGitLabPipelineInfo,
} from '../../src/lib/gitlab/gitlab-api'

const all = DefaultPipelineNotificationSettings

function job(id: number, name: string, status: string): IGitLabJobStatus {
  return { id, name, status }
}

function pipeline(
  status: string,
  jobs: ReadonlyArray<IGitLabJobStatus>,
  extra: Partial<IGitLabPipelineInfo> = {}
): IGitLabPipelineInfo {
  return { id: 7, sha: 'abcdef1234567890', status, jobs, ...extra }
}

function snap(
  p: IGitLabPipelineInfo | null,
  extra: Partial<IPipelineSnapshot> = {}
): IPipelineSnapshot {
  return {
    pushedSha: 'abcdef1234567890',
    pipeline: p,
    awaitingPipeline: false,
    ...extra,
  }
}

const running = pipeline('running', [
  job(1, 'build', 'success'),
  job(2, 'test', 'running'),
])

describe('getPipelineNotification', () => {
  it('stays quiet for the state found at startup', () => {
    const failed = pipeline('failed', [job(2, 'test', 'failed')])
    assert.equal(getPipelineNotification(undefined, snap(failed), all), null)
  })

  it('notifies when a running pipeline passes or fails', () => {
    const passed = pipeline('success', [job(2, 'test', 'success')])
    assert.equal(
      getPipelineNotification(snap(running), snap(passed), all)?.kind,
      'passed'
    )
    const failed = pipeline('failed', [job(2, 'test', 'failed')])
    assert.equal(
      getPipelineNotification(snap(running), snap(failed), all)?.kind,
      'failed'
    )
  })

  it('does not repeat a notification for an unchanged pipeline', () => {
    const failed = pipeline('failed', [job(2, 'test', 'failed')])
    assert.equal(getPipelineNotification(snap(failed), snap(failed), all), null)
  })

  it('ignores pipelines that finished before the pushed commit changed', () => {
    const passed = pipeline('success', [job(2, 'test', 'success')])
    const previous = snap(running, { pushedSha: 'older' })
    assert.equal(getPipelineNotification(previous, snap(passed), all), null)
  })

  it('notifies for a pipeline created and finished while waiting', () => {
    const passed = pipeline('success', [job(2, 'test', 'success')])
    const previous = snap(null, { awaitingPipeline: true })
    assert.equal(
      getPipelineNotification(previous, snap(passed), all)?.kind,
      'passed'
    )
  })

  it('ignores a branch fallback pipeline', () => {
    const passed = pipeline('success', [], { fallbackRef: 'main' })
    assert.equal(
      getPipelineNotification(snap(running), snap(passed), all),
      null
    )
  })

  it('notifies once when the pipeline stops at a manual job', () => {
    const before = pipeline('running', [
      job(2, 'test', 'running'),
      job(3, 'deploy', 'manual'),
    ])
    const waiting = pipeline('manual', [
      job(2, 'test', 'success'),
      job(3, 'deploy', 'manual'),
    ])
    const n = getPipelineNotification(snap(before), snap(waiting), all)
    assert.equal(n?.kind, 'manual')
    assert.deepEqual(
      n?.manualJobs.map(j => j.name),
      ['deploy']
    )
    assert.equal(
      getPipelineNotification(snap(waiting), snap(waiting), all),
      null
    )
  })

  it('reports a waiting manual job ahead of a pass', () => {
    const passedWithManual = pipeline('success', [
      job(2, 'test', 'success'),
      job(3, 'deploy', 'manual'),
    ])
    assert.equal(
      getPipelineNotification(snap(running), snap(passedWithManual), all)?.kind,
      'manual'
    )
    assert.equal(
      getPipelineNotification(snap(running), snap(passedWithManual), {
        ...all,
        manual: false,
      })?.kind,
      'passed'
    )
  })

  it('respects the settings', () => {
    const failed = pipeline('failed', [job(2, 'test', 'failed')])
    const none = { passed: false, failed: false, manual: false }
    assert.equal(
      getPipelineNotification(snap(running), snap(failed), none),
      null
    )
  })

  it('treats a new pipeline for the same commit as a fresh run', () => {
    const oldFailed = pipeline('failed', [job(2, 'test', 'failed')])
    const newPassed = pipeline('success', [job(9, 'test', 'success')], {
      id: 8,
    })
    assert.equal(
      getPipelineNotification(snap(oldFailed), snap(newPassed), all)?.kind,
      'passed'
    )
  })
})

describe('getWaitingManualJobs', () => {
  it('is empty while other jobs are still running', () => {
    const p = pipeline('running', [
      job(2, 'test', 'running'),
      job(3, 'deploy', 'manual'),
    ])
    assert.deepEqual(getWaitingManualJobs(p), [])
  })
})

describe('describePipelineNotification', () => {
  it('names the failed jobs', () => {
    const failed = pipeline('failed', [
      job(1, 'lint', 'failed'),
      job(2, 'test', 'failed'),
    ])
    const text = describePipelineNotification(
      { kind: 'failed', pipeline: failed, manualJobs: [] },
      'payments-api'
    )
    assert.equal(text.title, 'payments-api: pipeline failed')
    assert.equal(text.body, 'Pipeline #7 for abcdef12 failed (lint, test).')
  })
})
