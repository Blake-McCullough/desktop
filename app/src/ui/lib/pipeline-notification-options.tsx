import * as React from 'react'
import { Checkbox, CheckboxValue } from './checkbox'
import {
  IPipelineNotificationSettings,
  PipelineNotificationKind,
} from '../../lib/gitlab/pipeline-notifications'

interface IPipelineNotificationOptionsProps {
  readonly settings: IPipelineNotificationSettings
  readonly disabled?: boolean
  readonly onChange: (settings: IPipelineNotificationSettings) => void
}

const Options: ReadonlyArray<{
  readonly kind: PipelineNotificationKind
  readonly label: string
}> = [
  { kind: 'failed', label: 'When the pipeline fails' },
  { kind: 'passed', label: 'When the pipeline passes' },
  { kind: 'manual', label: 'When a manual job is waiting to be run' },
]

/** Checkboxes for which GitLab pipeline events notify you. */
export class PipelineNotificationOptions extends React.Component<IPipelineNotificationOptionsProps> {
  private readonly handlers = new Map<
    PipelineNotificationKind,
    (event: React.FormEvent<HTMLInputElement>) => void
  >()

  private getHandler(kind: PipelineNotificationKind) {
    let handler = this.handlers.get(kind)
    if (handler === undefined) {
      handler = (event: React.FormEvent<HTMLInputElement>) =>
        this.props.onChange({
          ...this.props.settings,
          [kind]: event.currentTarget.checked,
        })
      this.handlers.set(kind, handler)
    }
    return handler
  }

  public render() {
    return (
      <div className="pipeline-notification-options">
        {Options.map(({ kind, label }) => (
          <Checkbox
            key={kind}
            label={label}
            disabled={this.props.disabled}
            value={
              this.props.settings[kind] ? CheckboxValue.On : CheckboxValue.Off
            }
            onChange={this.getHandler(kind)}
          />
        ))}
      </div>
    )
  }
}
