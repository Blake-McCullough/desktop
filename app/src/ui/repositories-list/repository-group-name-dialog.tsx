import * as React from 'react'

import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { TextBox } from '../lib/text-box'

interface IRepositoryGroupNameDialogProps {
  readonly title: string
  readonly okButtonText: string
  readonly defaultValue?: string
  readonly onSubmit: (name: string) => void
  readonly onDismissed: () => void
}

interface IRepositoryGroupNameDialogState {
  readonly name: string
}

/**
 * A small dialog used to prompt the user for a repository group name, used
 * both when creating a new group and when renaming an existing one.
 *
 * This exists because `window.prompt` is not implemented by Electron and
 * silently no-ops, so we can't rely on it to collect this input.
 */
export class RepositoryGroupNameDialog extends React.Component<
  IRepositoryGroupNameDialogProps,
  IRepositoryGroupNameDialogState
> {
  public constructor(props: IRepositoryGroupNameDialogProps) {
    super(props)

    this.state = { name: props.defaultValue ?? '' }
  }

  public render() {
    return (
      <Dialog
        id="repository-group-name"
        title={this.props.title}
        onDismissed={this.props.onDismissed}
        onSubmit={this.onSubmit}
      >
        <DialogContent>
          <TextBox
            ariaLabel="Group name"
            autoFocus={true}
            value={this.state.name}
            onValueChanged={this.onNameChanged}
          />
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={this.props.okButtonText}
            okButtonDisabled={this.state.name.trim().length === 0}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private onNameChanged = (name: string) => {
    this.setState({ name })
  }

  private onSubmit = () => {
    const name = this.state.name.trim()
    if (name.length === 0) {
      return
    }

    this.props.onSubmit(name)
    this.props.onDismissed()
  }
}
