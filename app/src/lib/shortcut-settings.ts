import { getBoolean, setBoolean } from './local-storage'
import {
  QuickSwitcherDefaultAccelerator,
  QuickSwitcherMenuItemId,
  ShortcutOverrides,
  sanitizeShortcutOverrides,
} from '../models/shortcuts'

const ShortcutOverridesKey = 'menu-shortcut-overrides'
const QuickSwitcherRepositoriesOnlyKey = 'quick-switcher/repositories-only'

/** Shortcuts changed in Preferences → Shortcuts, by menu item id. */
export function getShortcutOverrides(): ShortcutOverrides {
  try {
    const raw = localStorage.getItem(ShortcutOverridesKey)
    return raw === null ? {} : sanitizeShortcutOverrides(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function setShortcutOverrides(overrides: ShortcutOverrides) {
  localStorage.setItem(ShortcutOverridesKey, JSON.stringify(overrides))
}

/** The quick switcher's current shortcut, or null when it has none. */
export function getQuickSwitcherAccelerator(): string | null {
  const override = getShortcutOverrides()[QuickSwitcherMenuItemId]
  if (override === undefined) {
    return QuickSwitcherDefaultAccelerator
  }
  return override === '' ? null : override
}

/** Whether the quick switcher lists only repositories (no branches). */
export function getQuickSwitcherRepositoriesOnly(): boolean {
  return getBoolean(QuickSwitcherRepositoriesOnlyKey, false)
}

export function setQuickSwitcherRepositoriesOnly(value: boolean) {
  setBoolean(QuickSwitcherRepositoriesOnlyKey, value)
}
