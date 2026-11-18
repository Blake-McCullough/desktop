import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  IMenuShortcut,
  acceleratorFromKeyboardEvent,
  findShortcutConflicts,
  formatAccelerator,
  getEffectiveAccelerator,
  normalizeAccelerator,
  sanitizeShortcutOverrides,
} from '../../src/models/shortcuts'
import {
  applyShortcutOverrides,
  listMenuShortcuts,
} from '../../src/main-process/menu/menu-shortcuts'

const key = (
  code: string,
  mods: Partial<{
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    shiftKey: boolean
  }> = {}
) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('acceleratorFromKeyboardEvent', () => {
  it('records Ctrl on Windows/Linux and Cmd on macOS as CmdOrCtrl', () => {
    assert.equal(
      acceleratorFromKeyboardEvent(key('KeyK', { ctrlKey: true }), false),
      'CmdOrCtrl+K'
    )
    assert.equal(
      acceleratorFromKeyboardEvent(key('KeyK', { metaKey: true }), true),
      'CmdOrCtrl+K'
    )
    assert.equal(
      acceleratorFromKeyboardEvent(
        key('KeyK', { ctrlKey: true, metaKey: true }),
        true
      ),
      'CmdOrCtrl+Ctrl+K'
    )
  })

  it('keeps modifier order and maps punctuation and arrows', () => {
    assert.equal(
      acceleratorFromKeyboardEvent(
        key('Slash', { shiftKey: true, altKey: true, ctrlKey: true }),
        false
      ),
      'CmdOrCtrl+Alt+Shift+/'
    )
    assert.equal(
      acceleratorFromKeyboardEvent(key('ArrowUp', { altKey: true }), false),
      'Alt+Up'
    )
  })

  it('ignores lone modifiers and plain or shifted typing', () => {
    assert.equal(
      acceleratorFromKeyboardEvent(
        key('ControlLeft', { ctrlKey: true }),
        false
      ),
      null
    )
    assert.equal(acceleratorFromKeyboardEvent(key('KeyK'), false), null)
    assert.equal(
      acceleratorFromKeyboardEvent(key('KeyK', { shiftKey: true }), false),
      null
    )
    assert.equal(acceleratorFromKeyboardEvent(key('F5'), false), 'F5')
  })
})

describe('normalizeAccelerator and formatAccelerator', () => {
  it('treats different spellings as the same keys', () => {
    assert.equal(
      normalizeAccelerator('Shift+CommandOrControl+k', false),
      normalizeAccelerator('CmdOrCtrl+Shift+K', false)
    )
    assert.equal(normalizeAccelerator('CmdOrCtrl++', false), 'Ctrl++')
  })

  it('formats for each platform', () => {
    assert.equal(formatAccelerator('CmdOrCtrl+Shift+K', false), 'Ctrl+Shift+K')
    assert.equal(formatAccelerator('CmdOrCtrl+Shift+K', true), '⇧⌘K')
    assert.equal(formatAccelerator('CmdOrCtrl+=', true), '⌘=')
  })
})

const shortcuts: ReadonlyArray<IMenuShortcut> = [
  {
    id: 'push',
    path: ['Repository', 'Push'],
    defaultAccelerator: 'CmdOrCtrl+P',
  },
  { id: 'switch', path: ['View', 'Switch'], defaultAccelerator: 'CmdOrCtrl+K' },
  { id: 'none', path: ['View', 'Nothing'], defaultAccelerator: null },
]

describe('overrides', () => {
  it('apply on top of the defaults, with empty meaning none', () => {
    const overrides = { switch: 'CmdOrCtrl+E', push: '' }
    assert.equal(
      getEffectiveAccelerator(shortcuts[1], overrides),
      'CmdOrCtrl+E'
    )
    assert.equal(getEffectiveAccelerator(shortcuts[0], overrides), null)
    assert.equal(getEffectiveAccelerator(shortcuts[2], overrides), null)
  })

  it('finds shortcuts used twice', () => {
    const conflicts = findShortcutConflicts(
      shortcuts,
      { switch: 'Ctrl+P' },
      false
    )
    assert.deepEqual(
      [...conflicts.values()].map(list => list.map(s => s.id)),
      [['push', 'switch']]
    )
  })

  it('drops malformed stored values', () => {
    assert.deepEqual(sanitizeShortcutOverrides({ a: 'Ctrl+A', b: 3 }), {
      a: 'Ctrl+A',
    })
    assert.deepEqual(sanitizeShortcutOverrides(['x']), {})
    assert.deepEqual(sanitizeShortcutOverrides(null), {})
  })
})

describe('menu templates', () => {
  const template = (): Array<Electron.MenuItemConstructorOptions> => [
    {
      id: '@.&File',
      label: '&File',
      submenu: [
        { id: 'new', label: '&New…', accelerator: 'CmdOrCtrl+N' },
        { id: '@.&File.separator', type: 'separator' },
        { id: 'hidden', label: 'Hidden', visible: false },
        { id: 'copy', label: '&Copy', role: 'copy' },
        { id: 'plain', label: 'Plain action' },
      ],
    },
  ]

  it('lists the items you can give a shortcut', () => {
    assert.deepEqual(listMenuShortcuts(template()), [
      { id: 'new', path: ['File', 'New…'], defaultAccelerator: 'CmdOrCtrl+N' },
      { id: 'plain', path: ['File', 'Plain action'], defaultAccelerator: null },
    ])
  })

  it('applies overrides by id', () => {
    const t = template()
    applyShortcutOverrides(t, { new: '', plain: 'CmdOrCtrl+Alt+X' })
    const items = t[0].submenu as Array<Electron.MenuItemConstructorOptions>
    assert.equal(items[0].accelerator, undefined)
    assert.equal(items[4].accelerator, 'CmdOrCtrl+Alt+X')
  })
})
