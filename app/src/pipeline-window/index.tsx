import '../lib/logging/renderer/install'

import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { PipelineApp } from './pipeline-app'
import { parsePipelineWindowRequest } from '../lib/pipeline-window-shared'
import {
  ApplicationTheme,
  getPersistedThemeName,
} from '../ui/lib/application-theme'

if (!process.env.TEST_ENV) {
  require('./styles/pipeline.scss')
}

document.body.classList.add(`platform-${process.platform}`)

/** Follow the app's theme (and the system's, when it's set to follow it). */
function applyTheme() {
  const setting = getPersistedThemeName()
  const dark =
    setting === ApplicationTheme.Dark ||
    (setting === ApplicationTheme.System &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.classList.toggle('theme-dark', dark)
  document.body.classList.toggle('theme-light', !dark)
}
applyTheme()
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', applyTheme)
// The theme lives in shared storage; pick up changes made in the app.
window.addEventListener('storage', e => {
  if (e.key === 'theme') {
    applyTheme()
  }
})

let request = null
try {
  request = parsePipelineWindowRequest(
    JSON.parse(decodeURIComponent(window.location.hash.slice(1)))
  )
} catch {
  request = null
}

const container = document.createElement('div')
container.id = 'desktop-pipeline-container'
document.body.appendChild(container)

if (request === null) {
  container.textContent = "This pipeline couldn't be opened."
} else {
  ReactDOM.render(<PipelineApp request={request} />, container)
}
