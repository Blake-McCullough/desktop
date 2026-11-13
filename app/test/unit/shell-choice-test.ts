import { describe, it } from 'node:test'
import assert from 'node:assert'
import { chooseShell } from '../../src/lib/shells/shared'
import { getDesktopPreferredShells, Shell } from '../../src/lib/shells/linux'

const found = (...shells: Shell[]) =>
  shells.map(shell => ({ shell, path: `/usr/bin/${shell}` }))

describe('chooseShell', () => {
  it('uses the chosen terminal when it is installed', () => {
    const available = found(Shell.Konsole, Shell.Xterm)
    assert.equal(chooseShell(available, Shell.Xterm)?.shell, Shell.Xterm)
  })

  it("falls back to the desktop's terminal, not undefined", () => {
    // GNOME Terminal (the default) isn't installed on KDE Plasma.
    const available = found(Shell.Xterm, Shell.Konsole)
    assert.equal(
      chooseShell(available, Shell.Gnome, [Shell.Konsole])?.shell,
      Shell.Konsole
    )
    assert.equal(chooseShell(available, Shell.Gnome)?.shell, Shell.Xterm)
    assert.equal(chooseShell([], Shell.Gnome), null)
  })
})

describe('getDesktopPreferredShells', () => {
  it('prefers the terminal that ships with the desktop', () => {
    assert.deepEqual(getDesktopPreferredShells('KDE'), [Shell.Konsole])
    assert.deepEqual(getDesktopPreferredShells('ubuntu:GNOME')[1], Shell.Gnome)
    assert.deepEqual(getDesktopPreferredShells('XFCE'), [Shell.XFCE])
    assert.deepEqual(getDesktopPreferredShells(''), [])
  })
})
