import * as React from 'react'
import { DialogContent } from '../dialog'
import { Row } from '../lib/row'
import { TextBox } from '../lib/text-box'
import { Button } from '../lib/button'
import { Repository } from '../../models/repository'
import { gitLabPipelineStatusStore } from '../../lib/stores/gitlab-pipeline-status-store'
import { getGitLabToken } from '../../lib/gitlab/gitlab-token'

interface IGitLabProps {
  /**
   * The GitLab personal access token as currently loaded/edited, or `null`
   * if none is configured. `undefined` while the stored value is still
   * being loaded asynchronously.
   */
  readonly token: string | null | undefined
  readonly onTokenChanged: (token: string) => void
  readonly repositories: ReadonlyArray<Repository>
}

interface IGitLabState {
  readonly isFetching: boolean
  readonly fetchResultMessage: string | null
}

/**
 * The "GitLab" preferences tab: lets the user configure a single, global
 * GitLab personal access token used to fetch pipeline status for GitLab
 * repositories shown in the repositories sidebar.
 */
export class GitLab extends React.Component<IGitLabProps, IGitLabState> {
  public constructor(props: IGitLabProps) {
    super(props)

    this.state = { isFetching: false, fetchResultMessage: null }
  }

  private onTokenChanged = (value: string) => {
    this.props.onTokenChanged(value)
  }

  private onClearToken = () => {
    this.props.onTokenChanged('')
  }

  private onFetchNowClick = async () => {
    const gitlabToken = await getGitLabToken()
    if (gitlabToken === null) {
      this.setState({
        isFetching: false,
        fetchResultMessage: 'No GitLab token configured',
      })
      return
    }

    this.setState({ isFetching: true, fetchResultMessage: null })

    await gitLabPipelineStatusStore.refresh(this.props.repositories)

    const statusCount = gitLabPipelineStatusStore.getStatuses().size
    this.setState({
      isFetching: false,
      fetchResultMessage: `Done — found statuses for ${statusCount} repositories`,
    })
  }

  public render() {
    const token = this.props.token ?? ''
    const isLoading = this.props.token === undefined

    return (
      <DialogContent>
        <div className="advanced-section">
          <h2>Personal access token</h2>
          <Row>
            <TextBox
              label="GitLab Personal Access Token"
              type="password"
              value={token}
              onValueChanged={this.onTokenChanged}
              placeholder={isLoading ? 'Loading…' : ''}
              disabled={isLoading}
            />
          </Row>
          <Row>
            <Button onClick={this.onClearToken} disabled={isLoading || token === ''}>
              Clear
            </Button>
          </Row>
          <div className="settings-description">
            <p>
              Used to show pipeline status for GitLab repositories in the
              sidebar. Needs at least the <code>read_api</code> scope.
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
              {this.state.isFetching ? 'Fetching…' : 'Fetch pipeline statuses now'}
            </Button>
          </Row>
          {this.state.fetchResultMessage !== null && (
            <div className="settings-description">
              <p>{this.state.fetchResultMessage}</p>
            </div>
          )}
        </div>
      </DialogContent>
    )
  }
}
