import { Emitter } from 'event-kit'
import { getBoolean, setBoolean } from './local-storage'
import { setNativeMenuBarVisible } from '../ui/main-process-proxy'

const UseSystemMenuBarKey = 'linux-use-system-menu-bar'
const emitter = new Emitter()

/**
 * Linux only: whether to use the desktop's own (GTK) menu bar instead of
 * the in-app one. The system menu bar ignores the app's theme, so it stays
 * light in dark mode; the in-app one matches the theme, as on Windows.
 */
export function getUseSystemMenuBar(): boolean {
  return __LINUX__ && getBoolean(UseSystemMenuBarKey, false)
}

export function setUseSystemMenuBar(value: boolean) {
  if (value === getUseSystemMenuBar()) {
    return
  }
  setBoolean(UseSystemMenuBarKey, value)
  applySystemMenuBarSetting()
  emitter.emit('did-change')
}

/** Show or hide the system menu bar to match the setting. */
export function applySystemMenuBarSetting() {
  if (__LINUX__) {
    setNativeMenuBarVisible(getUseSystemMenuBar())
  }
}

export function onUseSystemMenuBarChanged(fn: () => void) {
  return emitter.on('did-change', fn)
}
