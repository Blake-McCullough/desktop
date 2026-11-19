import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  describeMergeStatus,
  getCreateMergeRequestUrl,
  toApprovals,
  toMergeRequest,
} from '../../src/lib/gitlab/merge-requests'

describe('merge requests', () => {
  it('reads a merge request and spots forks', () => {
    const mr = toMergeRequest({
      iid: 42,
      title: 'Draft: Batch payouts',
      web_url: 'https://gitlab.com/acme/pay/-/merge_requests/42',
      source_branch: 'feature/payouts',
      target_branch: 'main',
      author: { name: 'Sam Lee', username: 'sam' },
      draft: true,
      project_id: 7,
      source_project_id: 7,
      target_project_id: 7,
      user_notes_count: 3,
    })
    assert.equal(mr.isFromFork, false)
    assert.equal(mr.draft, true)
    assert.equal(mr.authorName, 'Sam Lee')
    assert.equal(mr.commentCount, 3)

    const fork = toMergeRequest({
      iid: 43,
      source_branch: 'main',
      target_branch: 'main',
      source_project_id: 99,
      target_project_id: 7,
    })
    assert.equal(fork.isFromFork, true)
  })

  it('reads approvals', () => {
    assert.deepEqual(
      toApprovals({
        approved: false,
        approvals_required: 2,
        approvals_left: 1,
        approved_by: [{ user: { name: 'Kim' } }],
      }),
      { approved: false, required: 2, left: 1, approvedBy: ['Kim'] }
    )
  })

  it("builds GitLab's new merge request URL", () => {
    assert.equal(
      getCreateMergeRequestUrl(
        { webBaseUrl: 'https://git.example.com', projectPath: 'acme/pay' },
        'feature/a b',
        'main'
      ),
      'https://git.example.com/acme/pay/-/merge_requests/new?' +
        'merge_request%5Bsource_branch%5D=feature%2Fa+b&' +
        'merge_request%5Btarget_branch%5D=main'
    )
  })

  it('describes merge statuses', () => {
    assert.equal(describeMergeStatus('not_approved'), 'Needs approval')
    assert.equal(describeMergeStatus('checking'), null)
    assert.equal(describeMergeStatus('some_new_status'), 'some new status')
  })
})
