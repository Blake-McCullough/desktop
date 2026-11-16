import assert from 'node:assert'
import { after, afterEach, before, describe, it } from 'node:test'
import * as React from 'react'
import { render, screen, fireEvent } from '../../helpers/ui/render'
import { ExportRepositoriesDialog } from '../../../src/ui/repositories-list/export-repositories-dialog'
import { Repository } from '../../../src/models/repository'
import {
  createCustomGroup,
  setRepositoryGroup,
} from '../../../src/ui/repositories-list/custom-repository-groups-store'

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

const repos = [
  new Repository('/code/work/api', 1, null, false),
  new Repository('/code/work/web', 2, null, false),
  new Repository('/code/site', 3, null, false),
]

function renderDialog(initialSelection?: ReadonlyArray<number>) {
  const work = createCustomGroup('Work')
  setRepositoryGroup(1, work.id)
  setRepositoryGroup(2, work.id)
  return render(
    <ExportRepositoriesDialog
      repositories={repos}
      initialSelection={initialSelection}
      onExported={() => {}}
      onDismissed={() => {}}
    />
  )
}

const checkbox = (name: string) => {
  const el = screen.getByRole('checkbox', { name, hidden: true })
  assert.ok(el instanceof HTMLInputElement)
  return el
}

describe('ExportRepositoriesDialog', () => {
  afterEach(() => localStorage.clear())

  it('selects everything by default and toggles by group', () => {
    renderDialog()
    assert.ok(screen.getByText('Export 3 repositories…'))
    assert.equal(checkbox('Work').checked, true)

    fireEvent.click(checkbox('Work'))
    assert.equal(checkbox('api').checked, false)
    assert.equal(checkbox('web').checked, false)
    assert.equal(checkbox('site').checked, true)
    assert.ok(screen.getByText('Export 1 repository…'))
  })

  it('starts with just the given repositories, e.g. one group', () => {
    renderDialog([1, 2])
    assert.equal(checkbox('site').checked, false)
    assert.equal(checkbox('Work').checked, true)
    assert.ok(screen.getByText('Export 2 repositories…'))
  })

  it('remembers field choices', () => {
    const first = renderDialog()
    fireEvent.click(checkbox('Aliases'))
    first.unmount()
    renderDialog()
    assert.equal(checkbox('Aliases').checked, false)
  })
})
