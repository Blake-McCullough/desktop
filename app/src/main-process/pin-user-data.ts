import { app } from 'electron'
import * as Path from 'path'

/**
 * The product name this build's data folder was created under.
 *
 * Electron names the data folder (settings, the repository list, logs,
 * sidebar groups) after the product name. The app was renamed from "GitHub
 * Desktop Custom" to "GitHub Desktop Custom GitLab CI", so keep using the
 * original folder; otherwise an update would start with no repositories.
 */
const DataFolderProductName = 'GitHub Desktop Custom'
const CurrentProductName = 'GitHub Desktop Custom GitLab CI'

// Imported first by main.ts, so this runs before anything reads the path
// (logging, the single-instance lock, the window's storage).
const name = app.getName()
if (name.startsWith(CurrentProductName)) {
  // Keeps suffixes such as "-dev" for development builds.
  const folder = DataFolderProductName + name.slice(CurrentProductName.length)
  app.setPath('userData', Path.join(app.getPath('appData'), folder))
  if (!__DARWIN__) {
    app.setAppLogsPath(Path.join(app.getPath('userData'), 'logs'))
  }
}
