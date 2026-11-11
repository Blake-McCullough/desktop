import assert from 'node:assert'
import { describe, it } from 'node:test'
import * as React from 'react'

import { fireEvent, render, screen } from '../../helpers/ui/render'
import { Repository } from '../../../src/models/repository'
import { RepositoriesSidebarRow } from '../../../src/ui/repositories-list/repositories-sidebar-row'
import { IRepositoryPipelineState } from '../../../src/lib/stores/gitlab-pipeline-status-store'
import { IGitLabJobStatus } from '../../../src/lib/gitlab/gitlab-api'

const repository = new Repository('/tmp/my-app', 7, null, false)

function pipelineWith(
  jobs: ReadonlyArray<IGitLabJobStatus>
): IRepositoryPipelineState {
  return {
    pushedSha: 'abc1234def',
    awaitingPipeline: false,
    pipeline: {
      sha: 'abc1234def',
      status: 'running',
      webUrl: 'https://gitlab.com/a/b/-/pipelines/1',
      jobs,
    },
    isFetching: false,
    error: null,
    fetchedAt: 1,
  }
}

function renderRow(
  pipeline: IRepositoryPipelineState | undefined,
  handlers: {
    onClick?: (r: unknown) => void
    onPlayJob?: (r: unknown, job: IGitLabJobStatus) => void
    onOpenUrl?: (url: string) => void
  } = {}
) {
  return render(
    <RepositoriesSidebarRow
      repository={repository}
      selected={false}
      aheadBehind={null}
      changedFilesCount={0}
      pipeline={pipeline}
      playingJobIds={new Set()}
      isDragging={false}
      onClick={handlers.onClick ?? (() => {})}
      onContextMenu={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      onPlayJob={handlers.onPlayJob ?? (() => {})}
      onOpenUrl={handlers.onOpenUrl ?? (() => {})}
    />
  )
}

describe('RepositoriesSidebarRow', () => {
  it('renders the repository and selects it on Enter', () => {
    const clicked: Array<unknown> = []
    renderRow(undefined, { onClick: r => clicked.push(r) })

    assert.ok(screen.getByText('my-app'))
    const row = screen.getAllByRole('button')[0]
    fireEvent.keyDown(row, { key: 'Enter' })
    assert.deepEqual(clicked, [repository])
  })

  it('shows a dot per job and opens the job when clicked', () => {
    const opened: Array<string> = []
    renderRow(
      pipelineWith([
        {
          id: 1,
          name: 'build',
          stage: 'build',
          status: 'success',
          webUrl: 'https://gitlab.com/job/1',
        },
        { id: 2, name: 'test', stage: 'test', status: 'running' },
      ]),
      { onOpenUrl: url => opened.push(url) }
    )

    const build = screen.getByRole('button', { name: 'build › build: success' })
    assert.ok(build.className.includes('gitlab-job-dot-green'))
    assert.ok(
      screen
        .getByRole('button', { name: 'test › test: running' })
        .className.includes('running')
    )

    fireEvent.click(build)
    assert.deepEqual(opened, ['https://gitlab.com/job/1'])
  })

  it('plays manual jobs', () => {
    const played: Array<number> = []
    renderRow(pipelineWith([{ id: 9, name: 'deploy', status: 'manual' }]), {
      onPlayJob: (_r, job) => played.push(job.id),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run deploy' }))
    assert.deepEqual(played, [9])
  })

  it('collapses extra jobs into a "+N" button that opens the pipeline', () => {
    const opened: Array<string> = []
    const jobs = Array.from({ length: 11 }, (_, i) => ({
      id: i + 1,
      name: `job${i + 1}`,
      status: 'success',
    }))
    renderRow(pipelineWith(jobs), { onOpenUrl: url => opened.push(url) })

    const more = screen.getByText('+3')
    fireEvent.click(more)
    assert.deepEqual(opened, ['https://gitlab.com/a/b/-/pipelines/1'])
  })

  it("waits for the pushed commit's pipeline instead of showing an older one", () => {
    const { container } = renderRow({
      pipeline: null,
      pushedSha: 'abc1234def',
      awaitingPipeline: true,
      isFetching: false,
      error: null,
      fetchedAt: 1,
    })

    assert.ok(container.querySelector('.gitlab-pipeline-awaiting'))
    assert.equal(container.querySelector('.gitlab-job-dot'), null)
    assert.equal(container.querySelector('.gitlab-job-run-button'), null)
  })

  it('shows nothing for repositories without pipeline state', () => {
    const { container } = renderRow(undefined)
    assert.equal(container.querySelector('.gitlab-pipeline-status'), null)
  })
})
