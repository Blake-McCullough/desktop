import { app } from 'electron'
import * as Path from 'path'
import * as Os from 'os'
import { open, readdir } from 'fs/promises'
import { getLogDirectoryPath } from '../lib/logging/get-log-path'
import { getInstallKind } from './custom-updater'
import { IMainProcessDebugInfo } from '../lib/debug-info'

/** How much of the end of the log to read. */
const TailBytes = 48 * 1024
const TailLines = 150

const InstallKindLabels: Record<string, string> = {
  'windows-setup': 'Windows Setup (auto-updates)',
  pacman: 'Arch Linux package',
  manual: 'manual / not installed from a release',
}

/** The last lines of the newest log file. */
async function readLogTail(): Promise<{
  readonly text: string
  readonly fileName: string | null
}> {
  const dir = getLogDirectoryPath()
  let names: ReadonlyArray<string>
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.log')).sort()
  } catch {
    return { text: '', fileName: null }
  }
  const newest = names[names.length - 1]
  if (newest === undefined) {
    return { text: '', fileName: null }
  }

  const handle = await open(Path.join(dir, newest), 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TailBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split(/\r?\n/)
    // The first line is probably cut off part-way.
    if (length < size) {
      lines.shift()
    }
    return { text: lines.slice(-TailLines).join('\n'), fileName: newest }
  } finally {
    await handle.close()
  }
}

/** Versions, platform and recent log lines for Help → Copy debug info. */
export async function getMainProcessDebugInfo(): Promise<IMainProcessDebugInfo> {
  const tail = await readLogTail().catch(e => {
    log.warn('Could not read the log for debug info', e)
    return { text: '', fileName: null }
  })
  const kind = getInstallKind()
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: Os.release(),
    installKind: InstallKindLabels[kind] ?? kind,
    logTail: tail.text,
    logFileName: tail.fileName,
  }
}
