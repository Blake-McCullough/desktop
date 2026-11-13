import * as React from 'react'
import * as Path from 'path'
import { Dialog, DialogContent, DialogFooter, DialogError } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { TextBox } from '../lib/text-box'
import { Row } from '../lib/row'
import { Button } from '../lib/button'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { showOpenDialog } from '../main-process-proxy'
import {
  getMoveRoot,
  IRepositoryMovePlan,
  IRepositoryMoveResult,
  pathIsTaken,
  planRepositoryMoves,
} from '../../lib/move-repository'

interface IMoveRepositoriesDialogProps {
  readonly dispatcher: Dispatcher
  /** The repositories to move: one, a group's, or all of them. */
  readonly repositories: ReadonlyArray<Repository>
  /** What's being moved, for the title, e.g. a group's name. */
  readonly label?: string
  readonly onDismissed: () => void
}

interface IMoveRepositoriesDialogState {
  /** For one repository: its new full path. Otherwise: the new folder. */
  readonly target: string
  readonly plans: ReadonlyArray<IRepositoryMovePlan<Repository>> | null
  readonly isMoving: boolean
  readonly current: Repository | null
  readonly results: ReadonlyArray<IRepositoryMoveResult<Repository>> | null
  readonly error: string | null
}

/**
 * Move repositories' folders to somewhere else on disk. Several repositories
 * keep their layout below their common folder.
 */
export class MoveRepositoriesDialog extends React.Component<
  IMoveRepositoriesDialogProps,
  IMoveRepositoriesDialogState
> {
  private planTimer: number | null = null
  private planId = 0
  private mounted = false

  public constructor(props: IMoveRepositoriesDialogProps) {
    super(props)
    this.state = {
      target: this.isSingle
        ? props.repositories[0]?.path ?? ''
        : this.oldRoot ?? '',
      plans: null,
      isMoving: false,
      current: null,
      results: null,
      error: null,
    }
  }

  private get movable() {
    return this.props.repositories.filter(r => !r.missing)
  }

  private get isSingle() {
    return this.props.repositories.length === 1
  }

  private get oldRoot() {
    return getMoveRoot(this.movable.map(r => r.path))
  }

  public componentDidMount() {
    this.mounted = true
    this.updatePlan()
  }

  public componentWillUnmount() {
    this.mounted = false
    if (this.planTimer !== null) {
      window.clearTimeout(this.planTimer)
    }
  }

  private schedulePlan() {
    if (this.planTimer !== null) {
      window.clearTimeout(this.planTimer)
    }
    this.planTimer = window.setTimeout(() => this.updatePlan(), 250)
  }

  private async updatePlan() {
    this.planTimer = null
    const id = ++this.planId
    const target = this.state.target.trim()
    const plans =
      target.length === 0
        ? []
        : await planRepositoryMoves(
            this.movable,
            this.oldRoot,
            target,
            pathIsTaken,
            this.isSingle ? target : undefined
          )
    if (this.mounted && id === this.planId) {
      this.setState({ plans })
    }
  }

  private onTargetChanged = (target: string) => {
    this.setState({ target, plans: null }, () => this.schedulePlan())
  }

  private onChoose = async () => {
    const folder = await showOpenDialog({
      properties: ['createDirectory', 'openDirectory'],
    })
    if (folder === null) {
      return
    }
    const target = this.isSingle
      ? Path.join(folder, Path.basename(this.props.repositories[0].path))
      : folder
    this.setState({ target, plans: null }, () => this.updatePlan())
  }

  private onSubmit = async () => {
    if (this.state.results !== null) {
      this.props.onDismissed()
      return
    }

    // Plan again right before moving, in case something changed on disk.
    const target = this.state.target.trim()
    const plans = await planRepositoryMoves(
      this.movable,
      this.oldRoot,
      target,
      pathIsTaken,
      this.isSingle ? target : undefined
    )
    if (!plans.some(p => p.action === 'move')) {
      this.setState({ plans })
      return
    }

    this.setState({ isMoving: true, plans, error: null })
    try {
      const results = await this.props.dispatcher.moveRepositories(
        plans.filter(p => p.action === 'move' || p.action === 'carried'),
        current => this.mounted && this.setState({ current })
      )
      if (!this.mounted) {
        return
      }
      const allOk = results.every(
        r => r.error === null && !r.leftOriginalBehind
      )
      if (allOk) {
        this.props.onDismissed()
        return
      }
      this.setState({ isMoving: false, current: null, results })
    } catch (e) {
      if (this.mounted) {
        this.setState({
          isMoving: false,
          current: null,
          error: e instanceof Error ? e.message : `${e}`,
        })
      }
    }
  }

  private get title() {
    if (this.isSingle) {
      const name = this.props.repositories[0]?.name ?? ''
      return `Move “${name}”`
    }
    const count = this.props.repositories.length
    const what =
      this.props.label !== undefined
        ? `“${this.props.label}”`
        : `${count} repositories`
    return `Move ${what}`
  }

  public render() {
    const { plans, isMoving, results, error } = this.state
    const moveCount = plans?.filter(p => p.action === 'move').length ?? 0
    const done = results !== null

    return (
      <Dialog
        id="move-repositories"
        className="move-repositories-dialog"
        title={this.title}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={isMoving}
        disabled={isMoving}
        dismissDisabled={isMoving}
      >
        {error !== null && <DialogError>{error}</DialogError>}
        <DialogContent>
          {done ? this.renderResults() : this.renderForm()}
        </DialogContent>
        <DialogFooter>
          {done ? (
            <OkCancelButtonGroup
              okButtonText="Close"
              cancelButtonVisible={false}
            />
          ) : (
            <OkCancelButtonGroup
              okButtonText={
                isMoving
                  ? 'Moving…'
                  : this.isSingle || moveCount <= 1
                  ? 'Move'
                  : `Move ${moveCount} repositories`
              }
              okButtonDisabled={isMoving || moveCount === 0}
            />
          )}
        </DialogFooter>
      </Dialog>
    )
  }

  private renderForm() {
    const missing = this.props.repositories.length - this.movable.length
    const root = this.oldRoot
    return (
      <>
        {!this.isSingle && (
          <p className="move-repositories-intro">
            {root !== null ? (
              <>
                The folders below <code>{root}</code> keep their layout in the
                new folder.
              </>
            ) : (
              <>
                These repositories don't share a folder, so each one goes
                straight into the new folder.
              </>
            )}
          </p>
        )}
        <Row className="move-repositories-target">
          <TextBox
            label={this.isSingle ? 'New location' : 'Move to folder'}
            value={this.state.target}
            onValueChanged={this.onTargetChanged}
            disabled={this.state.isMoving}
          />
          <Button onClick={this.onChoose} disabled={this.state.isMoving}>
            Choose…
          </Button>
        </Row>
        {this.renderPlans()}
        {missing > 0 && (
          <p className="move-repositories-note">
            {missing === 1
              ? '1 repository is missing on disk and will be skipped.'
              : `${missing} repositories are missing on disk and will be skipped.`}
          </p>
        )}
        {this.isSingle && this.renderSinglePlanNote()}
      </>
    )
  }

  private renderSinglePlanNote() {
    const plan = this.state.plans?.[0]
    if (plan === undefined) {
      return null
    }
    if (plan.action === 'blocked') {
      return <p className="move-repositories-problem">{plan.problem}</p>
    }
    if (plan.action === 'unchanged') {
      return (
        <p className="move-repositories-note">
          Enter a new location, or choose a folder to move it into.
        </p>
      )
    }
    return (
      <p className="move-repositories-note">
        The folder is moved with everything in it, including uncommitted changes
        and ignored files.
      </p>
    )
  }

  private renderPlans() {
    const { plans, current, isMoving } = this.state
    if (this.isSingle || plans === null || plans.length === 0) {
      return null
    }
    return (
      <ul className="move-repositories-list">
        {plans.map(plan => (
          <li
            key={plan.repository.id}
            className={`move-plan move-plan-${plan.action}`}
          >
            <Octicon
              className="icon"
              symbol={
                isMoving && current?.id === plan.repository.id
                  ? octicons.sync
                  : plan.action === 'blocked'
                  ? octicons.alert
                  : plan.action === 'unchanged'
                  ? octicons.dash
                  : octicons.arrowRight
              }
            />
            <div className="move-plan-text">
              <div className="move-plan-name">{plan.repository.name}</div>
              <div className="move-plan-path">
                {plan.action === 'blocked'
                  ? plan.problem
                  : plan.action === 'unchanged'
                  ? 'Already there'
                  : plan.action === 'carried'
                  ? `Moves with its parent folder → ${plan.to}`
                  : plan.to}
              </div>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  private renderResults() {
    const results = this.state.results ?? []
    return (
      <ul className="move-repositories-list">
        {results.map(r => (
          <li
            key={r.repository.id}
            className={`move-plan ${
              r.error === null ? 'move-plan-done' : 'move-plan-blocked'
            }`}
          >
            <Octicon
              className="icon"
              symbol={r.error === null ? octicons.check : octicons.x}
            />
            <div className="move-plan-text">
              <div className="move-plan-name">{r.repository.name}</div>
              <div className="move-plan-path">
                {r.error !== null
                  ? r.error
                  : r.leftOriginalBehind
                  ? `Copied to ${r.to}, but the old folder couldn't be fully deleted. You can delete ${r.repository.path} yourself.`
                  : `Moved to ${r.to}`}
              </div>
            </div>
          </li>
        ))}
      </ul>
    )
  }
}
