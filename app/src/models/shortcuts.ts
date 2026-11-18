/**
 * Keyboard shortcuts for menu items, which you can change in
 * Preferences → Shortcuts.
 *
 * Shortcuts are Electron accelerators (e.g. `CmdOrCtrl+Shift+K`). Changes
 * are stored as overrides keyed by menu item id; an empty string means the
 * item has no shortcut at all.
 */
export type ShortcutOverrides = Readonly<Record<string, string>>

/** A menu item whose shortcut can be changed. */
export interface IMenuShortcut {
  /** The menu item's id. */
  readonly id: string
  /** Where to find it, e.g. `['View', 'Quick switcher…']`. */
  readonly path: ReadonlyArray<string>
  /** The built-in shortcut, or `null` when it has none. */
  readonly defaultAccelerator: string | null
}

export const QuickSwitcherMenuItemId = 'show-quick-switcher'
export const QuickSwitcherDefaultAccelerator = 'CmdOrCtrl+K'

const ModifierOrder = ['CmdOrCtrl', 'Cmd', 'Ctrl', 'Alt', 'Shift'] as const

const ModifierAliases: Record<string, string> = {
  cmdorctrl: 'CmdOrCtrl',
  commandorcontrol: 'CmdOrCtrl',
  cmd: 'Cmd',
  command: 'Cmd',
  super: 'Cmd',
  meta: 'Cmd',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'Alt',
  shift: 'Shift',
}

const CodeKeys: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

/** The key part of an accelerator for a physical key, or null. */
function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) {
    return letter[1]
  }
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (digit) {
    return digit[1]
  }
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (fn) {
    return code
  }
  return CodeKeys[code] ?? null
}

interface IKeyboardEventLike {
  readonly code: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/**
 * The accelerator for a key press, or null while only modifiers are held or
 * for keys that can't be a shortcut. Plain keys need a modifier (except
 * function keys) so a shortcut can't swallow ordinary typing.
 */
export function acceleratorFromKeyboardEvent(
  event: IKeyboardEventLike,
  isMac: boolean
): string | null {
  const key = keyFromCode(event.code)
  if (key === null) {
    return null
  }

  const modifiers = new Array<string>()
  if (isMac ? event.metaKey : event.ctrlKey) {
    modifiers.push('CmdOrCtrl')
  }
  if (isMac && event.ctrlKey) {
    modifiers.push('Ctrl')
  }
  if (!isMac && event.metaKey) {
    modifiers.push('Cmd')
  }
  if (event.altKey) {
    modifiers.push('Alt')
  }
  if (event.shiftKey) {
    modifiers.push('Shift')
  }

  const isFunctionKey = /^F\d+$/.test(key)
  const onlyShift = modifiers.length === 1 && modifiers[0] === 'Shift'
  if (!isFunctionKey && (modifiers.length === 0 || onlyShift)) {
    return null
  }

  return [...modifiers, key].join('+')
}

/**
 * The accelerator as this platform sees it, with modifiers in a fixed order,
 * so two spellings of the same keys compare equal.
 */
export function normalizeAccelerator(
  accelerator: string,
  isMac: boolean
): string {
  const parts = accelerator.split('+')
  // A trailing '+' means the key itself is '+', e.g. 'CmdOrCtrl++'.
  const key =
    accelerator.endsWith('++') || accelerator === '+'
      ? '+'
      : parts[parts.length - 1]
  const modifierParts = key === '+' ? parts.slice(0, -2) : parts.slice(0, -1)

  const modifiers = new Set<string>()
  for (const part of modifierParts) {
    let m = ModifierAliases[part.toLowerCase()] ?? part
    if (m === 'CmdOrCtrl') {
      m = isMac ? 'Cmd' : 'Ctrl'
    }
    modifiers.add(m)
  }
  const ordered = ModifierOrder.filter(m => modifiers.has(m))
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key
  return [...ordered, normalizedKey].join('+')
}

const MacSymbols: Record<string, string> = {
  Cmd: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
}

/** How a shortcut is shown to people, e.g. `Ctrl+Shift+K` or `⇧⌘K`. */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const normalized = normalizeAccelerator(accelerator, isMac)
  if (!isMac) {
    return normalized
  }
  // macOS convention: ⌃⌥⇧⌘ then the key.
  const parts = normalized.split('+')
  const key = normalized.endsWith('++') ? '+' : parts[parts.length - 1]
  const mods = new Set(key === '+' ? parts.slice(0, -2) : parts.slice(0, -1))
  return (
    ['Ctrl', 'Alt', 'Shift', 'Cmd']
      .filter(m => mods.has(m))
      .map(m => MacSymbols[m])
      .join('') + key
  )
}

/** The shortcut a menu item ends up with after applying the overrides. */
export function getEffectiveAccelerator(
  shortcut: IMenuShortcut,
  overrides: ShortcutOverrides
): string | null {
  const override = overrides[shortcut.id]
  if (override === undefined) {
    return shortcut.defaultAccelerator
  }
  return override === '' ? null : override
}

/**
 * Menu items that share a shortcut once the overrides are applied, keyed by
 * the normalized shortcut. Only the first of them would ever be triggered.
 */
export function findShortcutConflicts(
  shortcuts: ReadonlyArray<IMenuShortcut>,
  overrides: ShortcutOverrides,
  isMac: boolean
): ReadonlyMap<string, ReadonlyArray<IMenuShortcut>> {
  const byAccelerator = new Map<string, Array<IMenuShortcut>>()
  for (const shortcut of shortcuts) {
    const accelerator = getEffectiveAccelerator(shortcut, overrides)
    if (accelerator === null) {
      continue
    }
    const key = normalizeAccelerator(accelerator, isMac)
    const list = byAccelerator.get(key) ?? []
    list.push(shortcut)
    byAccelerator.set(key, list)
  }
  const conflicts = new Map<string, ReadonlyArray<IMenuShortcut>>()
  for (const [key, list] of byAccelerator) {
    if (list.length > 1) {
      conflicts.set(key, list)
    }
  }
  return conflicts
}

/** Keep only well-formed overrides (from storage or IPC). */
export function sanitizeShortcutOverrides(value: unknown): ShortcutOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const [id, accelerator] of Object.entries(value)) {
    if (
      typeof accelerator === 'string' &&
      accelerator.length <= 64 &&
      id.length <= 200
    ) {
      result[id] = accelerator
    }
  }
  return result
}
