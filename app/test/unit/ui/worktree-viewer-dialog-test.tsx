import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import * as React from 'react'
import * as Path from 'path'
import { writeFile } from 'fs/promises'
import { exec } from 'dugite'

import { render, screen, waitFor } from '../../helpers/ui/render'
import { setupTwoCommitRepo } from '../../helpers/repositories'
import { WorktreeViewerDialog } from '../../../src/ui/worktrees/worktree-viewer-dialog'
import { Dispatcher } from '../../../src/ui/dispatcher'

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

describe('WorktreeViewerDialog', () => {
  it('lists worktrees with their branch and uncommitted changes', async t => {
    const repository = await setupTwoCommitRepo(t)
    const worktreePath = Path.join(
      Path.dirname(repository.path),
      `${Path.basename(repository.path)}-feature`
    )

    const add = await exec(
      ['worktree', 'add', '-b', 'feature/x', worktreePath],
      repository.path
    )
    assert.equal(add.exitCode, 0, add.stderr)
    await writeFile(Path.join(worktreePath, 'new-file.txt'), 'hi')

    render(
      <WorktreeViewerDialog
        dispatcher={{} as Dispatcher}
        repository={repository}
        onDismissed={() => {}}
      />
    )

    await waitFor(() => assert.ok(screen.getByText('2 worktrees')))
    await waitFor(() => assert.ok(screen.getByText('feature/x')))
    await waitFor(() => assert.ok(screen.getByText('1 changed file')))

    // The repository's own folder is marked as open and can't be switched
    // to; the other one can.
    assert.ok(screen.getByText('Open'))
    assert.ok(screen.getByText('Main'))
    assert.equal(
      screen.getAllByRole('button', { name: /^Switch to/, hidden: true })
        .length,
      1
    )
  })
})
