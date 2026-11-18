import {
  QuickSwitcherDefaultAccelerator,
  QuickSwitcherMenuItemId,
  ShortcutOverrides,
  sanitizeShortcutOverrides,
} from '../models/shortcuts'

const ShortcutOverridesKey = 'menu-shortcut-overrides'

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
