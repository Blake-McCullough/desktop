import * as React from 'react'
import { DialogContent } from '../dialog'
import { Row } from '../lib/row'
import { TextBox } from '../lib/text-box'
import { Button } from '../lib/button'
import { Repository } from '../../models/repository'
import { gitLabPipelineStatusStore } from '../../lib/stores/gitlab-pipeline-status-store'
import {
  GitLabApiError,
  checkGitLabToken,
  normalizeInstanceUrl,
} from '../../lib/gitlab/gitlab-api'
import { GitLabDotComInstance } from '../../lib/gitlab/gitlab-token'

/** The key for the default token in `tokens`. */
export const DefaultTokenKey = ''

interface IGitLabProps {
  /**
   * Tokens as currently edited, keyed by instance URL (`DefaultTokenKey` for
   * the default token). `undefined` while the stored values load.
   */
  readonly tokens: ReadonlyMap<string, string> | undefined
  readonly onTokenChanged: (key: string, token: string) => void

  /** Self-hosted instance URLs as edited. */
  readonly instanceUrls: ReadonlyArray<string>
  readonly onInstanceUrlsChanged: (urls: ReadonlyArray<string>) => void

  readonly repositories: ReadonlyArray<Repository>
}

interface ITestResult {
  readonly ok: boolean
  readonly lines: ReadonlyArray<string>
}

interface IGitLabState {
  readonly newInstanceUrl: string
  readonly newInstanceError: string | null
  /** Test results by token key. */
  readonly testing: ReadonlySet<string>
  readonly testResults: ReadonlyMap<string, ITestResult>
  readonly isFetching: boolean
  readonly fetchResultMessage: string | null
}

function hostLabel(url: string) {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}${
      u.protocol === 'http:' ? ' (HTTP)' : ''
    }`
  } catch {
    return url
  }
}

/**
 * The "GitLab" preferences tab: a token per GitLab instance (plus a default
 * token for any instance without its own), and the self-hosted instances.
 */
export class GitLab extends React.Component<IGitLabProps, IGitLabState> {
  private readonly tokenHandlers = new Map<string, (value: string) => void>()
  private readonly clearHandlers = new Map<string, () => void>()
  private readonly testHandlers = new Map<string, () => void>()
  private readonly removeHandlers = new Map<string, () => void>()

  public constructor(props: IGitLabProps) {
    super(props)

    this.state = {
      newInstanceUrl: '',
      newInstanceError: null,
      testing: new Set(),
      testResults: new Map(),
      isFetching: false,
      fetchResultMessage: null,
    }
  }

  /** Every instance to list: gitlab.com, configured, then detected ones. */
  private getInstances(): ReadonlyArray<{
    readonly url: string
    readonly kind: 'gitlab.com' | 'configured' | 'detected'
  }> {
    const seen = new Set<string>([GitLabDotComInstance])
    const rows: Array<{
      url: string
      kind: 'gitlab.com' | 'configured' | 'detected'
    }> = [{ url: GitLabDotComInstance, kind: 'gitlab.com' }]
    for (const url of this.props.instanceUrls) {
      if (!seen.has(url)) {
        seen.add(url)
        rows.push({ url, kind: 'configured' })
      }
    }
    for (const url of gitLabPipelineStatusStore.getKnownInstances()) {
      if (!seen.has(url)) {
        seen.add(url)
        rows.push({ url, kind: 'detected' })
      }
    }
    return rows
  }

  private getTokenHandler(key: string) {
    let handler = this.tokenHandlers.get(key)
    if (handler === undefined) {
      handler = (value: string) => {
        this.props.onTokenChanged(key, value)
        this.clearTestResult(key)
      }
      this.tokenHandlers.set(key, handler)
    }
    return handler
  }

  private getClearHandler(key: string) {
    let handler = this.clearHandlers.get(key)
    if (handler === undefined) {
      handler = () => {
        this.props.onTokenChanged(key, '')
        this.clearTestResult(key)
      }
      this.clearHandlers.set(key, handler)
    }
    return handler
  }

  private getTestHandler(key: string) {
    let handler = this.testHandlers.get(key)
    if (handler === undefined) {
      handler = () => this.test(key)
      this.testHandlers.set(key, handler)
    }
    return handler
  }

  private getRemoveHandler(url: string) {
    let handler = this.removeHandlers.get(url)
    if (handler === undefined) {
      handler = () => {
        this.props.onInstanceUrlsChanged(
          this.props.instanceUrls.filter(u => u !== url)
        )
        // Its token goes too.
        this.props.onTokenChanged(url, '')
      }
      this.removeHandlers.set(url, handler)
    }
    return handler
  }

  private clearTestResult(key: string) {
    if (this.state.testResults.has(key)) {
      const testResults = new Map(this.state.testResults)
      testResults.delete(key)
      this.setState({ testResults })
    }
  }

  private token(key: string) {
    return (this.props.tokens?.get(key) ?? '').trim()
  }

  /**
   * Test a token. An instance's own token is tested against it; the default
   * token against every instance that would use it.
   */
  private async test(key: string) {
    const token = this.token(key)
    if (token.length === 0) {
      return
    }

    const targets =
      key === DefaultTokenKey
        ? this.getInstances()
            .map(i => i.url)
            .filter(url => this.token(url).length === 0)
        : [key]

    this.setState(prev => ({ testing: new Set(prev.testing).add(key) }))

    const lines: Array<string> = []
    let ok = true
    for (const target of targets) {
      try {
        const result = await checkGitLabToken(target, token)
        let line = `✓ ${hostLabel(target)}: signed in as @${result.username}`
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
            ? 'token rejected (invalid, expired, revoked or for another server)'
            : e.message
        lines.push(`✗ ${hostLabel(target)}: ${reason}`)
      }
    }
    if (targets.length === 0) {
      lines.push('Every server has its own token, so the default is unused.')
    }

    this.setState(prev => {
      const testing = new Set(prev.testing)
      testing.delete(key)
      return {
        testing,
        testResults: new Map(prev.testResults).set(key, { ok, lines }),
      }
    })
  }

  private onNewInstanceChanged = (newInstanceUrl: string) => {
    this.setState({ newInstanceUrl, newInstanceError: null })
  }

  private onAddInstance = () => {
    const url = normalizeInstanceUrl(this.state.newInstanceUrl)
    if (url === null) {
      this.setState({
        newInstanceError: 'Enter the address of a GitLab server.',
      })
      return
    }
    if (
      !this.props.instanceUrls.includes(url) &&
      url !== GitLabDotComInstance
    ) {
      this.props.onInstanceUrlsChanged([...this.props.instanceUrls, url])
    }
    this.setState({ newInstanceUrl: '', newInstanceError: null })
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
        }. (Uses the saved tokens — save first if you just changed one.)`,
    })
  }

  public render() {
    const isLoading = this.props.tokens === undefined
    const hasDefault = this.token(DefaultTokenKey).length > 0

    return (
      <DialogContent>
        <div className="advanced-section gitlab-tokens">
          <h2>Servers and tokens</h2>
          <div className="settings-description">
            <p>
              Each GitLab server can have its own personal access token. Use the{' '}
              <code>read_api</code> scope to view pipelines, or <code>api</code>{' '}
              to also run, retry and cancel jobs. Tokens are stored in your
              system's credential manager.
            </p>
          </div>

          {this.renderTokenRow(
            DefaultTokenKey,
            'Default token',
            'Used for any server below that has no token of its own.',
            isLoading,
            null
          )}

          {this.getInstances().map(({ url, kind }) =>
            this.renderTokenRow(
              url,
              hostLabel(url),
              kind === 'detected'
                ? 'Found in your repositories.'
                : kind === 'gitlab.com'
                ? null
                : 'Self-hosted.',
              isLoading,
              kind === 'configured' ? url : null,
              hasDefault ? 'Uses the default token' : 'glpat-…'
            )
          )}

          <div className="gitlab-add-instance">
            <Row>
              <TextBox
                label="Add a self-hosted server"
                value={this.state.newInstanceUrl}
                onValueChanged={this.onNewInstanceChanged}
                onEnterPressed={this.onAddInstance}
                placeholder="https://git.example.com or https://example.com/gitlab"
              />
              <Button
                onClick={this.onAddInstance}
                disabled={this.state.newInstanceUrl.trim().length === 0}
              >
                Add
              </Button>
            </Row>
            {this.state.newInstanceError !== null && (
              <div className="gitlab-token-test error" role="alert">
                {this.state.newInstanceError}
              </div>
            )}
            <div className="settings-description">
              <p>
                Servers with "gitlab" in their name are detected automatically.
                Add any other server here, including ones served from a sub path
                or plain HTTP.
              </p>
            </div>
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

  private renderTokenRow(
    key: string,
    title: string,
    note: string | null,
    isLoading: boolean,
    removableUrl: string | null,
    placeholder = 'glpat-…'
  ) {
    const token = this.props.tokens?.get(key) ?? ''
    const testing = this.state.testing.has(key)
    const result = this.state.testResults.get(key)

    return (
      <div className="gitlab-token-row" key={key || 'default'}>
        <div className="gitlab-token-title">
          <strong>{title}</strong>
          {note !== null && <span className="gitlab-token-note">{note}</span>}
        </div>
        <Row>
          <TextBox
            ariaLabel={`Token for ${title}`}
            type="password"
            value={token}
            onValueChanged={this.getTokenHandler(key)}
            placeholder={isLoading ? 'Loading…' : placeholder}
            disabled={isLoading}
          />
          <Button
            onClick={this.getTestHandler(key)}
            disabled={isLoading || token.trim() === '' || testing}
          >
            {testing ? 'Testing…' : 'Test'}
          </Button>
          <Button
            onClick={this.getClearHandler(key)}
            disabled={isLoading || token === ''}
          >
            Clear
          </Button>
          {removableUrl !== null && (
            <Button
              onClick={this.getRemoveHandler(removableUrl)}
              ariaLabel={`Remove ${title}`}
              tooltip="Remove this server"
            >
              Remove
            </Button>
          )}
        </Row>
        {result !== undefined && (
          <div
            className={`gitlab-token-test ${result.ok ? 'ok' : 'error'}`}
            role="status"
          >
            {result.lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
      </div>
    )
  }
}
