import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import * as React from 'react'
import * as Path from 'path'
import { writeFile } from 'fs/promises'
import { exec } from 'dugite'

import { fireEvent, render, screen, waitFor } from '../../helpers/ui/render'
import { setupEmptyRepository } from '../../helpers/repositories'
import { CommitGraphDialog } from '../../../src/ui/commit-graph/commit-graph-dialog'

let restoreIpcSend = () => {}

before(async () => {
  const electron = await import('electron')
  const previousSend = electron.ipcRenderer.send
  electron.ipcRenderer.send = () => {}
  restoreIpcSend = () => {
    electron.ipcRenderer.send = previousSend
  }
})

after(() => restoreIpcSend())

async function run(cwd: string, ...args: Array<string>) {
  const result = await exec(args, cwd)
  assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`)
}

async function commit(
  cwd: string,
  file: string,
  message: string,
  author: string
) {
  await writeFile(Path.join(cwd, file), `${message}\n`, { flag: 'a' })
  await run(cwd, 'add', file)
  await run(
    cwd,
    '-c',
    `user.name=${author}`,
    '-c',
    'user.email=dev@example.com',
    'commit',
    '-m',
    message
  )
}

describe('CommitGraphDialog', () => {
  it('draws branches, merges, labels and commit details', async t => {
    const repository = await setupEmptyRepository(t)
    const cwd = repository.path

    await run(cwd, 'checkout', '-b', 'main')
    await commit(cwd, 'a.txt', 'Initial commit', 'Blake McCullough')
    await run(cwd, 'checkout', '-b', 'feature')
    await commit(cwd, 'b.txt', 'Add feature part one', 'Timothy O')
    await commit(cwd, 'b.txt', 'Add feature part two', 'Timothy O')
    await run(cwd, 'checkout', 'main')
    await commit(cwd, 'a.txt', 'Fix on main', 'Blake McCullough')
    await run(
      cwd,
      '-c',
      'user.name=Blake McCullough',
      '-c',
      'user.email=dev@example.com',
      'merge',
      '--no-ff',
      'feature',
      '-m',
      "Merge branch 'feature' into main"
    )
    await run(cwd, 'tag', 'Pushed_To_Test_2026-11-02T03-54-13Z')
    await run(cwd, 'checkout', '-b', 'hotfix', 'HEAD~1')
    await commit(cwd, 'c.txt', 'Hotfix not on main', 'hilary soong')
    await run(cwd, 'checkout', 'main')

    const view = render(
      <CommitGraphDialog repository={repository} onDismissed={() => {}} />
    )

    await waitFor(() => assert.ok(screen.getByText('6 commits')))

    const rows = view.container.querySelectorAll('.commit-graph-row')
    assert.equal(rows.length, 6)
    assert.equal(
      view.container.querySelectorAll('.commit-graph-row.merge').length,
      1
    )
    // The hotfix commit isn't on the checked-out branch, so it's dimmed.
    const hotfix = [...rows].find(r =>
      r.textContent?.includes('Hotfix not on main')
    )
    assert.ok(hotfix?.classList.contains('dimmed'))
    assert.ok(screen.getByText('main'))
    assert.ok(screen.getByText('Pushed_To_Test_2026-11-02T03-54-13Z'))
    // More than one lane is drawn.
    assert.ok(
      [...view.container.querySelectorAll('.graph-cell')].some(
        svg => Number(svg.getAttribute('width')) > 30
      )
    )

    fireEvent.click(hotfix!)
    await waitFor(() => assert.ok(screen.getByText('c.txt')))

    if (process.env.COMMIT_GRAPH_SNAPSHOT) {
      await writeFile(
        process.env.COMMIT_GRAPH_SNAPSHOT,
        view.container.innerHTML
      )
    }
  })
})
