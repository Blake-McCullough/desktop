import * as React from 'react'
import { DialogContent } from '../dialog'
import { Row } from '../lib/row'
import { RadioGroup } from '../lib/radio-group'
import { IPipelineNotificationSettings } from '../../lib/gitlab/pipeline-notifications'
import { PipelineNotificationOptions } from '../lib/pipeline-notification-options'

type Choice = 'default' | 'custom'
const Choices: ReadonlyArray<Choice> = ['default', 'custom']

interface IPipelineNotificationsProps {
  /** This repository's own settings, or null to follow the defaults. */
  readonly override: IPipelineNotificationSettings | null
  /** The defaults from Preferences, shown while following them. */
  readonly defaults: IPipelineNotificationSettings
  readonly notificationsEnabled: boolean
  readonly onChange: (override: IPipelineNotificationSettings | null) => void
}

/** Repository settings tab: GitLab pipeline notifications for this repo. */
export class PipelineNotifications extends React.Component<IPipelineNotificationsProps> {
  private renderLabel = (key: Choice) =>
    key === 'default'
      ? 'Use my default notification settings'
      : 'Use custom notification settings for this repository'

  private onChoiceChanged = (key: Choice) => {
    if (key === 'default') {
      this.props.onChange(null)
    } else if (this.props.override === null) {
      this.props.onChange(this.props.defaults)
    }
  }

  private onSettingsChanged = (settings: IPipelineNotificationSettings) => {
    this.props.onChange(settings)
  }

  public render() {
    const { override, defaults } = this.props
    return (
      <DialogContent>
        <div className="advanced-section">
          <h2 id="pipeline-notifications-heading">
            GitLab pipeline notifications
          </h2>
          <p className="settings-description">
            Desktop notifications about the pipeline for the commit you pushed
            to this repository.
            {!this.props.notificationsEnabled &&
              ' Notifications are currently turned off in Options → Notifications.'}
          </p>
          <Row>
            <RadioGroup<Choice>
              ariaLabelledBy="pipeline-notifications-heading"
              selectedKey={override === null ? 'default' : 'custom'}
              radioButtonKeys={Choices}
              onSelectionChanged={this.onChoiceChanged}
              renderRadioButtonLabelContents={this.renderLabel}
            />
          </Row>
          <PipelineNotificationOptions
            settings={override ?? defaults}
            disabled={override === null}
            onChange={this.onSettingsChanged}
          />
        </div>
      </DialogContent>
    )
  }
}
