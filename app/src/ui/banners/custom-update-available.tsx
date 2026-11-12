import * as React from 'react'
import { Banner } from './banner'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { LinkButton } from '../lib/link-button'

interface ICustomUpdateAvailableProps {
  readonly version: string
  readonly onUpdate: () => void
  readonly onShowDetails: () => void
  readonly onDismissed: () => void
}

/** Tells the user a newer GitHub Desktop Custom release is out. */
export class CustomUpdateAvailable extends React.Component<ICustomUpdateAvailableProps> {
  public render() {
    return (
      <Banner
        id="custom-update-available"
        dismissable={true}
        onDismissed={this.props.onDismissed}
      >
        <Octicon className="download-icon" symbol={octicons.desktopDownload} />
        <div className="banner-message">
          GitHub Desktop Custom <strong>{this.props.version}</strong> is
          available.{' '}
          <LinkButton onClick={this.props.onUpdate}>Update now</LinkButton> or{' '}
          <LinkButton onClick={this.props.onShowDetails}>
            see what's new
          </LinkButton>
          .
        </div>
      </Banner>
    )
  }
}
