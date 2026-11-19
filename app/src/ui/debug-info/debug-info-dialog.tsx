import * as React from 'react'
import * as Os from 'os'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { getDebugInfo, writeClipboardText } from '../main-process-proxy'
import { getName } from '../lib/app-proxy'
import { getOS } from '../../lib/get-os'
import { git } from '../../lib/git/core'
import { formatDebugInfo } from '../../lib/debug-info'
import { Repositoryish } from '../repositories-list/group-repositories'
import {
  getCustomGroups,
  getShowRepositoriesSidebar,
} from '../repositories-list/custom-repository-groups-store'
import { getUseSystemMenuBar } from '../../lib/linux-menu-bar'
import {
  GitLabDotComInstance,
  getGitLabInstanceUrls,
  getGitLabToken,
} from '../../lib/gitlab/gitlab-token'
import { gitLabPipelineStatusStore } from '../../lib/stores/gitlab-pipeline-status-store'

interface IDebugInfoDialogProps {
  readonly repositories: ReadonlyArray<Repositoryish>
  readonly theme: string
  readonly onDismissed: () => void
}

interface IDebugInfoDialogState {
  readonly text: string | null
  readonly error: string | null
  readonly copied: boolean
}

async function getGitVersion(): Promise<string | null> {
  try {
    const result = await git(['--version'], Os.homedir(), 'debugInfoVersion')
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

/** The GitLab servers in use, and whether each has a token. */
async function getGitLabServers() {
  const urls = new Set<string>([
    ...getGitLabInstanceUrls(),
    ...gitLabPipelineStatusStore.getKnownInstances(),
  ])
  if (urls.size === 0) {
    urls.add(GitLabDotComInstance)
  }
  const servers = []
  for (const url of urls) {
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // Keep the URL as it is.
    }
    servers.push({ host, hasToken: (await getGitLabToken(url)) !== null })
  }
  return servers
}

/**
 * Help → Copy debug info: what's useful in a bug report (versions, OS,
 * settings that matter, recent log lines), shown before it's copied so you
 * can see exactly what you'd share. Tokens and the home folder path are
 * removed.
 */
export class DebugInfoDialog extends React.Component<
  IDebugInfoDialogProps,
  IDebugInfoDialogState
> {
  public constructor(props: IDebugInfoDialogProps) {
    super(props)
    this.state = { text: null, error: null, copied: false }
  }

  public async componentDidMount() {
    try {
      const [main, gitVersion, gitLabServers] = await Promise.all([
        getDebugInfo(),
        getGitVersion(),
        getGitLabServers(),
      ])
      const text = formatDebugInfo({
        appName: getName(),
        main,
        os: getOS(),
        gitVersion,
        theme: this.props.theme,
        repositoryCount: this.props.repositories.length,
        groupCount: getCustomGroups().length,
        gitLabServers,
        sidebarVisible: getShowRepositoriesSidebar(),
        systemMenuBar: __LINUX__ ? getUseSystemMenuBar() : null,
        homeDirectory: Os.homedir(),
      })
      this.setState({ text })
    } catch (e) {
      log.error('Could not gather debug info', e)
      this.setState({ error: e instanceof Error ? e.message : `${e}` })
    }
  }

  private onCopy = async () => {
    if (this.state.text === null) {
      return
    }
    const ok = await writeClipboardText(this.state.text)
    if (ok) {
      this.setState({ copied: true })
    } else {
      this.setState({ error: "Couldn't copy to the clipboard." })
    }
  }

  public render() {
    const { text, error, copied } = this.state
    return (
      <Dialog
        id="debug-info"
        title={__DARWIN__ ? 'Debug Info' : 'Debug info'}
        onSubmit={this.onCopy}
        onDismissed={this.props.onDismissed}
        loading={text === null && error === null}
      >
        <DialogContent>
          <p>
            Paste this into a bug report. Tokens, passwords and your home folder
            path have been removed; read it through before sharing.
          </p>
          {error !== null && <p className="debug-info-error">{error}</p>}
          <textarea
            className="debug-info-text"
            readOnly={true}
            value={text ?? 'Gathering…'}
            aria-label="Debug info"
            spellCheck={false}
          />
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={copied ? 'Copied' : 'Copy'}
            okButtonDisabled={text === null}
            cancelButtonText="Close"
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
