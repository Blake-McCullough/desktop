import { BrowserWindow, nativeTheme } from 'electron'
import * as path from 'path'
import {
  IPipelineWindowRequest,
  pipelineWindowKey,
} from '../lib/pipeline-window-shared'
import * as ipcWebContents from './ipc-webcontents'
import { addTrustedIPCSender } from './trusted-ipc-sender'

const windows = new Map<string, BrowserWindow>()

/**
 * Open the pipeline window for a pipeline, or bring its existing window to
 * the front (selecting the requested job).
 */
export function showPipelineWindow(request: IPipelineWindowRequest) {
  const key = pipelineWindowKey(request)
  const existing = windows.get(key)
  if (existing !== undefined && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore()
    }
    existing.show()
    existing.focus()
    if (request.jobId !== null) {
      ipcWebContents.send(
        existing.webContents,
        'pipeline-window-select-job',
        request.jobId
      )
    }
    return
  }

  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: `Pipeline #${request.pipelineId} — ${request.repositoryName}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#24292e' : '#ffffff',
    autoHideMenuBar: true,
    // Windows and macOS take the icon from the app; Linux needs it set.
    ...(__LINUX__
      ? { icon: path.join(__dirname, 'static', 'icon-logo.png') }
      : {}),
    webPreferences: {
      disableBlinkFeatures: 'Auxclick',
      nodeIntegration: true,
      spellcheck: false,
      contextIsolation: false,
    },
  })
  // The app menu belongs to the main window.
  if (!__DARWIN__) {
    window.setMenu(null)
  }
  addTrustedIPCSender(window.webContents)
  windows.set(key, window)

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (windows.get(key) === window) {
      windows.delete(key)
    }
  })

  // Links (job pages, artifacts) open in the browser, never in this window.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())

  window.loadURL(
    `file://${__dirname}/pipeline.html#${encodeURIComponent(
      JSON.stringify(request)
    )}`
  )
}

/** Close every pipeline window (e.g. when the app quits). */
export function closePipelineWindows() {
  for (const window of windows.values()) {
    if (!window.isDestroyed()) {
      window.close()
    }
  }
  windows.clear()
}
