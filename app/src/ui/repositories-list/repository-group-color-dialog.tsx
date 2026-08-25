import * as React from 'react'

import { Dialog, DialogContent, DialogFooter, DialogError } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { TextBox } from '../lib/text-box'
import { Row } from '../lib/row'

const HexColorPattern = /^#?([0-9a-fA-F]{6})$/

interface IRepositoryGroupColorDialogProps {
  /** The group's current color, if it has one, used to pre-fill the field. */
  readonly defaultValue?: string
  readonly onSubmit: (hex: string) => void
  readonly onDismissed: () => void
}

interface IRepositoryGroupColorDialogState {
  readonly value: string
  readonly errorMessage: string | null
}

/**
 * A small dialog that lets the user type in a custom hex color for a
 * repository group's background tint, as an alternative to picking one of
 * the preset colors from the group's context menu.
 */
export class RepositoryGroupColorDialog extends React.Component<
  IRepositoryGroupColorDialogProps,
  IRepositoryGroupColorDialogState
> {
  public constructor(props: IRepositoryGroupColorDialogProps) {
    super(props)

    this.state = { value: props.defaultValue ?? '', errorMessage: null }
  }

  public render() {
    const normalized = normalizeHexColor(this.state.value)

    return (
      <Dialog
        id="repository-group-color"
        title="Custom Group Color"
        onDismissed={this.props.onDismissed}
        onSubmit={this.onSubmit}
      >
        <DialogContent>
          {this.state.errorMessage !== null && (
            <DialogError>{this.state.errorMessage}</DialogError>
          )}

          <Row>
            <TextBox
              label="Hex color"
              ariaLabel="Hex color"
              autoFocus={true}
              placeholder="#ff0000"
              value={this.state.value}
              onValueChanged={this.onValueChanged}
            />
            {normalized !== null && (
              <span
                className="repository-group-color-swatch"
                style={{ backgroundColor: normalized }}
              />
            )}
          </Row>
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Set Color"
            okButtonDisabled={normalized === null}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private onValueChanged = (value: string) => {
    this.setState({ value, errorMessage: null })
  }

  private onSubmit = () => {
    const normalized = normalizeHexColor(this.state.value)
    if (normalized === null) {
      this.setState({
        errorMessage:
          'Enter a valid 6-digit hex color, e.g. #ff0000 or ff0000.',
      })
      return
    }

    this.props.onSubmit(normalized)
    this.props.onDismissed()
  }
}

/**
 * Normalize user input into a `#rrggbb` hex color string, or `null` if the
 * input isn't a valid 6-digit hex color (with or without a leading `#`).
 */
function normalizeHexColor(value: string): string | null {
  const match = HexColorPattern.exec(value.trim())
  return match === null ? null : `#${match[1].toLowerCase()}`
}
