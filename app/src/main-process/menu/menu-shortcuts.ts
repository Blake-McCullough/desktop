import { IMenuShortcut, ShortcutOverrides } from '../../models/shortcuts'

type Template = ReadonlyArray<Electron.MenuItemConstructorOptions>

function submenuOf(item: Electron.MenuItemConstructorOptions): Template | null {
  return Array.isArray(item.submenu) ? (item.submenu as Template) : null
}

/** A menu label without its mnemonic markers, e.g. `&File` → `File`. */
function cleanLabel(label: string) {
  return label.replace(/&&/g, '\u0000').replace(/&/g, '').replace(/\0/g, '&')
}

/**
 * Whether a menu item is one you can give a shortcut: an action of ours
 * (not a separator, submenu or built-in role) that's shown.
 */
function isCustomizable(item: Electron.MenuItemConstructorOptions) {
  return (
    item.type !== 'separator' &&
    item.visible !== false &&
    item.id !== undefined &&
    item.label !== undefined &&
    submenuOf(item) === null &&
    (item.role === undefined || item.accelerator !== undefined)
  )
}

/**
 * Apply shortcut overrides to a menu template (in place). Expects every item
 * to have an id already, see `ensureItemIds`.
 */
export function applyShortcutOverrides(
  template: Template,
  overrides: ShortcutOverrides
) {
  if (Object.keys(overrides).length === 0) {
    return
  }
  const walk = (items: Template) => {
    for (const item of items) {
      const submenu = submenuOf(item)
      if (submenu !== null) {
        walk(submenu)
        continue
      }
      if (item.id === undefined || !isCustomizable(item)) {
        continue
      }
      const override = overrides[item.id]
      if (override === undefined) {
        continue
      }
      // Electron's types don't allow removing it, but undefined works.
      item.accelerator = override === '' ? undefined : override
    }
  }
  walk(template)
}

/** Every menu item whose shortcut can be changed, in menu order. */
export function listMenuShortcuts(template: Template): Array<IMenuShortcut> {
  const result = new Array<IMenuShortcut>()
  const seen = new Set<string>()
  const walk = (items: Template, path: ReadonlyArray<string>) => {
    for (const item of items) {
      const submenu = submenuOf(item)
      if (submenu !== null) {
        if (item.visible !== false) {
          walk(submenu, [...path, cleanLabel(item.label ?? '')])
        }
        continue
      }
      if (
        item.id === undefined ||
        item.label === undefined ||
        !isCustomizable(item) ||
        seen.has(item.id)
      ) {
        continue
      }
      seen.add(item.id)
      result.push({
        id: item.id,
        path: [...path, cleanLabel(item.label)],
        defaultAccelerator:
          typeof item.accelerator === 'string' ? item.accelerator : null,
      })
    }
  }
  walk(template, [])
  return result
}
