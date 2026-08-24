import * as React from 'react'
import { DialogContent } from '../dialog'
import { Row } from '../lib/row'
import { TextBox } from '../lib/text-box'
import { Button } from '../lib/button'

interface IGitLabProps {
  /**
   * The GitLab personal access token as currently loaded/edited, or `null`
   * if none is configured. `undefined` while the stored value is still
   * being loaded asynchronously.
   */
  readonly token: string | null | undefined
  readonly onTokenChanged: (token: string) => void
}

/**
 * The "GitLab" preferences tab: lets the user configure a single, global
 * GitLab personal access token used to fetch pipeline status for GitLab
 * repositories shown in the repositories sidebar.
 */
export class GitLab extends React.Component<IGitLabProps> {
  private onTokenChanged = (value: string) => {
    this.props.onTokenChanged(value)
  }

  private onClearToken = () => {
    this.props.onTokenChanged('')
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
      </DialogContent>
    )
  }
}
