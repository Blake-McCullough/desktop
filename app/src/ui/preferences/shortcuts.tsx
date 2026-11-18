import * as React from 'react'
import classNames from 'classnames'
import { DialogContent } from '../dialog'
import { Button } from '../lib/button'
import { TextBox } from '../lib/text-box'
import * as octicons from '../octicons/octicons.generated'
import { getMenuShortcuts, setIgnoreMenuShortcuts } from '../main-process-proxy'
import {
  IMenuShortcut,
  QuickSwitcherMenuItemId,
  ShortcutOverrides,
  acceleratorFromKeyboardEvent,
  findShortcutConflicts,
  formatAccelerator,
  getEffectiveAccelerator,
  normalizeAccelerator,
} from '../../models/shortcuts'

interface IShortcutsProps {
  readonly overrides: ShortcutOverrides
  readonly onOverridesChanged: (overrides: ShortcutOverrides) => void
}

interface IShortcutsState {
  readonly shortcuts: ReadonlyArray<IMenuShortcut> | null
  readonly error: string | null
  readonly filter: string
  /** The menu item whose new shortcut is being recorded. */
  readonly recordingId: string | null
}

/**
 * Preferences → Shortcuts: change the keyboard shortcut of any menu item,
 * including the quick switcher.
 */
export class Shortcuts extends React.Component<
  IShortcutsProps,
  IShortcutsState
> {
  private readonly handlers = new Map<
    string,
    {
      readonly record: () => void
      readonly reset: () => void
      readonly clear: () => void
    }
  >()

  public constructor(props: IShortcutsProps) {
    super(props)
    this.state = { shortcuts: null, error: null, filter: '', recordingId: null }
  }

  public async componentDidMount() {
    try {
      const shortcuts = await getMenuShortcuts()
      this.setState({ shortcuts })
    } catch (e) {
      log.error('Failed to list menu shortcuts', e)
      this.setState({ error: `Couldn't load the menu's shortcuts: ${e}` })
    }
  }

  public componentWillUnmount() {
    if (this.state.recordingId !== null) {
      setIgnoreMenuShortcuts(false)
    }
  }

  private getHandlers(id: string) {
    let handlers = this.handlers.get(id)
    if (handlers === undefined) {
      handlers = {
        record: () => this.startRecording(id),
        reset: () => this.setOverride(id, undefined),
        clear: () => this.setOverride(id, ''),
      }
      this.handlers.set(id, handlers)
    }
    return handlers
  }

  private startRecording(id: string) {
    if (this.state.recordingId === id) {
      this.stopRecording()
      return
    }
    // Otherwise pressing e.g. Ctrl+P to record it would push.
    setIgnoreMenuShortcuts(true)
    this.setState({ recordingId: id })
  }

  private stopRecording = () => {
    if (this.state.recordingId !== null) {
      setIgnoreMenuShortcuts(false)
      this.setState({ recordingId: null })
    }
  }

  /** Pass undefined to go back to the built-in shortcut. */
  private setOverride(id: string, accelerator: string | undefined) {
    const shortcut = this.state.shortcuts?.find(s => s.id === id)
    const overrides: Record<string, string> = { ...this.props.overrides }
    const isDefault =
      accelerator !== undefined &&
      shortcut !== undefined &&
      (accelerator === ''
        ? shortcut.defaultAccelerator === null
        : shortcut.defaultAccelerator !== null &&
          normalizeAccelerator(accelerator, __DARWIN__) ===
            normalizeAccelerator(shortcut.defaultAccelerator, __DARWIN__))

    if (accelerator === undefined || isDefault) {
      delete overrides[id]
    } else {
      overrides[id] = accelerator
    }
    this.props.onOverridesChanged(overrides)
  }

  private onRecordKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const id = this.state.recordingId
    if (id === null || event.currentTarget.dataset.id !== id) {
      return
    }
    // Let Tab move focus as usual.
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) {
      this.stopRecording()
      return
    }
    event.preventDefault()
    event.stopPropagation()

    const plain =
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (plain && event.key === 'Escape') {
      this.stopRecording()
      return
    }
    if (plain && (event.key === 'Backspace' || event.key === 'Delete')) {
      this.setOverride(id, '')
      this.stopRecording()
      return
    }

    const accelerator = acceleratorFromKeyboardEvent(
      event.nativeEvent,
      __DARWIN__
    )
    if (accelerator !== null) {
      this.setOverride(id, accelerator)
      this.stopRecording()
    }
  }

  private onFilterChanged = (filter: string) => {
    this.setState({ filter })
  }

  private onResetAll = () => {
    this.props.onOverridesChanged({})
  }

  public render() {
    const { shortcuts, error } = this.state
    return (
      <DialogContent className="shortcuts-preferences">
        {error !== null && <p className="shortcuts-error">{error}</p>}
        {shortcuts === null
          ? error === null && <p>Loading…</p>
          : this.renderShortcuts(shortcuts)}
      </DialogContent>
    )
  }

  private renderShortcuts(shortcuts: ReadonlyArray<IMenuShortcut>) {
    const { overrides } = this.props
    const conflicts = findShortcutConflicts(shortcuts, overrides, __DARWIN__)
    const switcher = shortcuts.find(s => s.id === QuickSwitcherMenuItemId)
    const filter = this.state.filter.trim().toLowerCase()
    const matching = shortcuts.filter(s => {
      if (s.id === QuickSwitcherMenuItemId) {
        return false
      }
      if (filter.length === 0) {
        return true
      }
      const accelerator = getEffectiveAccelerator(s, overrides)
      const haystack = [
        ...s.path,
        accelerator === null ? '' : formatAccelerator(accelerator, __DARWIN__),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(filter)
    })

    const byMenu = new Map<string, Array<IMenuShortcut>>()
    for (const s of matching) {
      const menu = s.path[0] ?? ''
      const list = byMenu.get(menu) ?? []
      list.push(s)
      byMenu.set(menu, list)
    }

    return (
      <>
        {switcher !== undefined && (
          <div className="advanced-section">
            <h2>Quick switcher</h2>
            <p className="settings-description">
              Jump to another repository, or a branch of this one, by typing
              part of its name.
            </p>
            <table className="shortcuts-table">
              <tbody>{this.renderRow(switcher, conflicts, false)}</tbody>
            </table>
          </div>
        )}
        <div className="advanced-section">
          <h2>Menu shortcuts</h2>
          <p className="settings-description">
            Click a shortcut and press the new keys. Backspace removes it,
            Escape cancels. Changes apply when you save.
          </p>
          <div className="shortcuts-toolbar">
            <TextBox
              placeholder="Filter by name or keys"
              ariaLabel="Filter shortcuts"
              prefixedIcon={octicons.search}
              value={this.state.filter}
              onValueChanged={this.onFilterChanged}
              displayClearButton={true}
            />
            <Button
              onClick={this.onResetAll}
              disabled={Object.keys(overrides).length === 0}
            >
              Reset all
            </Button>
          </div>
          {matching.length === 0 ? (
            <p className="settings-description">No menu items match.</p>
          ) : (
            <table className="shortcuts-table">
              {[...byMenu].map(([menu, list]) => (
                <tbody key={menu}>
                  <tr>
                    <th colSpan={2} scope="colgroup">
                      {menu}
                    </th>
                  </tr>
                  {list.map(s => this.renderRow(s, conflicts, true))}
                </tbody>
              ))}
            </table>
          )}
        </div>
      </>
    )
  }

  private renderRow(
    shortcut: IMenuShortcut,
    conflicts: ReadonlyMap<string, ReadonlyArray<IMenuShortcut>>,
    skipMenuName: boolean
  ) {
    const { overrides } = this.props
    const accelerator = getEffectiveAccelerator(shortcut, overrides)
    const isOverridden = overrides[shortcut.id] !== undefined
    const recording = this.state.recordingId === shortcut.id
    const handlers = this.getHandlers(shortcut.id)
    const others =
      accelerator === null
        ? []
        : (
            conflicts.get(normalizeAccelerator(accelerator, __DARWIN__)) ?? []
          ).filter(s => s.id !== shortcut.id)
    const label = (skipMenuName ? shortcut.path.slice(1) : shortcut.path).join(
      ' › '
    )

    return (
      <tr
        key={shortcut.id}
        className={classNames({ conflict: others.length > 0 })}
      >
        <td className="shortcut-label">
          {label}
          {others.length > 0 && (
            <div className="shortcut-conflict">
              Also used by {others.map(o => o.path.join(' › ')).join(', ')}
            </div>
          )}
        </td>
        <td className="shortcut-keys">
          <button
            type="button"
            data-id={shortcut.id}
            className={classNames('shortcut-recorder', {
              recording,
              empty: accelerator === null,
              changed: isOverridden,
            })}
            aria-label={`Shortcut for ${shortcut.path.join(' › ')}: ${
              accelerator === null
                ? 'none'
                : formatAccelerator(accelerator, __DARWIN__)
            }. Press to change.`}
            onClick={handlers.record}
            onKeyDown={this.onRecordKeyDown}
            onBlur={recording ? this.stopRecording : undefined}
          >
            {recording
              ? 'Press keys…'
              : accelerator === null
              ? 'None'
              : formatAccelerator(accelerator, __DARWIN__)}
          </button>
          {accelerator !== null && !recording && (
            <Button
              className="shortcut-action clear"
              onClick={handlers.clear}
              ariaLabel={`Remove the shortcut for ${shortcut.path.join(' › ')}`}
              tooltip="Remove shortcut"
            >
              ✕
            </Button>
          )}
          {isOverridden && !recording && (
            <Button
              className="shortcut-action"
              onClick={handlers.reset}
              tooltip={`Reset to ${
                shortcut.defaultAccelerator === null
                  ? 'no shortcut'
                  : formatAccelerator(shortcut.defaultAccelerator, __DARWIN__)
              }`}
            >
              Reset
            </Button>
          )}
        </td>
      </tr>
    )
  }
}
