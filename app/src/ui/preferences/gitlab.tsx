import * as React from 'react'
import { DialogContent } from '../dialog'
import { Row } from '../lib/row'
import { TextBox } from '../lib/text-box'
import { TextArea } from '../lib/text-area'
import { Button } from '../lib/button'
import { Repository } from '../../models/repository'
import { gitLabPipelineStatusStore } from '../../lib/stores/gitlab-pipeline-status-store'
import {
  GitLabApiError,
  checkGitLabToken,
  normalizeInstanceUrl,
} from '../../lib/gitlab/gitlab-api'

interface IGitLabProps {
  /**
   * The GitLab personal access token as currently loaded/edited, or `null`
   * if none is configured. `undefined` while the stored value is loading.
   */
  readonly token: string | null | undefined
  readonly onTokenChanged: (token: string) => void

  /** Self-hosted instance URLs as edited, one per line. */
  readonly instanceUrls: string
  readonly onInstanceUrlsChanged: (urls: string) => void

  readonly repositories: ReadonlyArray<Repository>
}

interface IGitLabState {
  readonly isTesting: boolean
  readonly testResult: {
    readonly ok: boolean
    readonly lines: ReadonlyArray<string>
  } | null
  readonly isFetching: boolean
  readonly fetchResultMessage: string | null
}

/**
 * The "GitLab" preferences tab: the personal access token used for
 * pipeline statuses, plus any self-hosted GitLab instances.
 */
export class GitLab extends React.Component<IGitLabProps, IGitLabState> {
  public constructor(props: IGitLabProps) {
    super(props)

    this.state = {
      isTesting: false,
      testResult: null,
      isFetching: false,
      fetchResultMessage: null,
    }
  }

  private onTokenChanged = (value: string) => {
    this.props.onTokenChanged(value)
    this.setState({ testResult: null })
  }

  private onClearToken = () => {
    this.props.onTokenChanged('')
    this.setState({ testResult: null })
  }

  private getInstanceList(): ReadonlyArray<string> {
    return this.props.instanceUrls
      .split(/\r?\n/)
      .map(normalizeInstanceUrl)
      .filter((u): u is string => u !== null)
  }

  private onTestClick = async () => {
    const token = (this.props.token ?? '').trim()
    if (token.length === 0) {
      return
    }

    const instances = this.getInstanceList()
    const targets = instances.length > 0 ? instances : ['https://gitlab.com']

    this.setState({ isTesting: true, testResult: null })

    const lines: Array<string> = []
    let ok = true

    for (const target of targets) {
      try {
        const result = await checkGitLabToken(target, token)
        let line = `✓ ${target}: signed in as @${result.username}`
        if (result.scopes !== null) {
          line += ` · scopes: ${result.scopes.join(', ') || 'none'}`
          if (!result.scopes.includes('api')) {
            line += result.scopes.includes('read_api')
              ? ' (read-only: running manual jobs needs "api")'
              : ' (needs "read_api" or "api")'
          }
        }
        if (result.expiresAt !== null) {
          line += ` · expires ${result.expiresAt}`
        }
        lines.push(line)
      } catch (e) {
        ok = false
        const reason =
          e instanceof GitLabApiError && e.isUnauthorized
            ? 'token rejected (invalid, expired or revoked)'
            : e.message
        lines.push(`✗ ${target}: ${reason}`)
      }
    }

    this.setState({ isTesting: false, testResult: { ok, lines } })
  }

  private onFetchNowClick = async () => {
    this.setState({ isFetching: true, fetchResultMessage: null })

    await gitLabPipelineStatusStore.refresh(this.props.repositories, {
      force: true,
    })

    const authError = gitLabPipelineStatusStore.getAuthError()
    let count = 0
    for (const state of gitLabPipelineStatusStore.getStatuses().values()) {
      if (state.pipeline !== null) {
        count++
      }
    }

    this.setState({
      isFetching: false,
      fetchResultMessage:
        authError ??
        `Found pipelines for ${count} ${
          count === 1 ? 'repository' : 'repositories'
        }. (Uses the saved token — save first if you just changed it.)`,
    })
  }

  public render() {
    const token = this.props.token ?? ''
    const isLoading = this.props.token === undefined
    const { testResult } = this.state

    return (
      <DialogContent>
        <div className="advanced-section">
          <h2>Personal access token</h2>
          <Row>
            <TextBox
              label="GitLab personal access token"
              type="password"
              value={token}
              onValueChanged={this.onTokenChanged}
              placeholder={isLoading ? 'Loading…' : 'glpat-…'}
              disabled={isLoading}
            />
          </Row>
          <Row>
            <Button
              onClick={this.onTestClick}
              disabled={
                isLoading || token.trim() === '' || this.state.isTesting
              }
            >
              {this.state.isTesting ? 'Testing…' : 'Test token'}
            </Button>
            <Button
              onClick={this.onClearToken}
              disabled={isLoading || token === ''}
            >
              Clear
            </Button>
          </Row>
          {testResult !== null && (
            <div
              className={`gitlab-token-test ${testResult.ok ? 'ok' : 'error'}`}
              role="status"
            >
              {testResult.lines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
          <div className="settings-description">
            <p>
              Shows pipeline status for GitLab repositories in the sidebar and
              history. Use the <code>read_api</code> scope to view statuses, or{' '}
              <code>api</code> to also run manual jobs. The token is stored in
              your system's credential manager.
            </p>
          </div>
        </div>

        <div className="advanced-section">
          <h2>Self-hosted instances</h2>
          <Row>
            <TextArea
              label="GitLab instance URLs (one per line)"
              value={this.props.instanceUrls}
              onValueChanged={this.props.onInstanceUrlsChanged}
              placeholder={
                'https://git.example.com\nhttps://example.com/gitlab'
              }
              rows={3}
            />
          </Row>
          <div className="settings-description">
            <p>
              Hosts with "gitlab" in their name are detected automatically. Add
              any other instance here, including ones served from a sub path or
              plain HTTP.
            </p>
          </div>
        </div>

        <div className="advanced-section">
          <h2>Pipeline statuses</h2>
          <Row>
            <Button
              onClick={this.onFetchNowClick}
              disabled={this.state.isFetching}
            >
              {this.state.isFetching
                ? 'Fetching…'
                : 'Refresh pipeline statuses now'}
            </Button>
          </Row>
          {this.state.fetchResultMessage !== null && (
            <div className="settings-description">
              <p>{this.state.fetchResultMessage}</p>
            </div>
          )}
          <div className="settings-description">
            <p>
              Statuses refresh every 3 minutes, or every 30 seconds while a
              pipeline is running. Updates pause while the window is hidden.
            </p>
          </div>
        </div>
      </DialogContent>
    )
  }
}
