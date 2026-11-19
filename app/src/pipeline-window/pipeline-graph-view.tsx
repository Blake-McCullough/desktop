import * as React from 'react'
import memoizeOne from 'memoize-one'
import { formatStatus, getJobStatusColor } from '../lib/gitlab/gitlab-api'
import {
  IJobDetails,
  IPipelineNeeds,
  formatDuration,
} from '../lib/gitlab/pipeline-details'
import {
  IGraphEdge,
  IPipelineGraph,
  layoutPipelineGraph,
} from '../lib/gitlab/pipeline-graph'

interface IPipelineGraphViewProps {
  readonly jobs: ReadonlyArray<IJobDetails>
  /** Job dependencies, or null to lay jobs out by stage. */
  readonly needs: IPipelineNeeds | null
  readonly selectedJobId: number | null
  /** Open a job (its log). */
  readonly onOpenJob: (jobId: number) => void
  /** Run a manual job. */
  readonly onRunJob: (job: IJobDetails) => void
  readonly isRunning: (jobId: number) => boolean
}

const CardWidth = 240
const CardHeight = 40
const ColumnGap = 56
const RowGap = 20
const Padding = 24
const LabelHeight = 28
const CornerRadius = 10

/** Seconds a job has taken so far (running) or took (finished). */
function elapsed(job: IJobDetails): number | null {
  if (job.duration !== null) {
    return job.duration
  }
  if (job.startedAt !== null && job.finishedAt === null) {
    const started = Date.parse(job.startedAt)
    return isNaN(started) ? null : (Date.now() - started) / 1000
  }
  return null
}

/**
 * A GitHub Actions-style graph of the pipeline's jobs: each job is a card,
 * and lines run from the jobs it waits for into it.
 */
export class PipelineGraphView extends React.Component<IPipelineGraphViewProps> {
  private readonly openHandlers = new Map<number, () => void>()
  private readonly runHandlers = new Map<number, () => void>()

  private getGraph = memoizeOne(
    (jobs: ReadonlyArray<IJobDetails>, needs: IPipelineNeeds | null) =>
      layoutPipelineGraph(jobs, needs)
  )

  private getOpenHandler(jobId: number) {
    let handler = this.openHandlers.get(jobId)
    if (handler === undefined) {
      handler = () => this.props.onOpenJob(jobId)
      this.openHandlers.set(jobId, handler)
    }
    return handler
  }

  private getRunHandler(jobId: number) {
    let handler = this.runHandlers.get(jobId)
    if (handler === undefined) {
      handler = () => {
        const job = this.props.jobs.find(j => j.id === jobId)
        if (job !== undefined) {
          this.props.onRunJob(job)
        }
      }
      this.runHandlers.set(jobId, handler)
    }
    return handler
  }

  public render() {
    const { jobs, needs } = this.props
    if (jobs.length === 0) {
      return <div className="pipeline-graph empty">No jobs to show.</div>
    }

    const graph = this.getGraph(jobs, needs)
    const top = Padding + (graph.mode === 'stages' ? LabelHeight : 0)
    const width =
      Padding * 2 + graph.columns * CardWidth + (graph.columns - 1) * ColumnGap
    const height =
      top + Padding + graph.rows * CardHeight + (graph.rows - 1) * RowGap

    const x = (column: number) => Padding + column * (CardWidth + ColumnGap)
    const y = (row: number) => top + row * (CardHeight + RowGap)
    const position = new Map(
      graph.nodes.map(n => [n.jobId, { left: x(n.column), top: y(n.row) }])
    )

    return (
      <div className="pipeline-graph">
        <p className="pipeline-graph-hint">
          {graph.mode === 'needs'
            ? 'Jobs are connected to the jobs they need. Click one to see its log.'
            : 'Jobs by stage. Click one to see its log.'}
        </p>
        <div className="pipeline-graph-canvas" style={{ width, height }}>
          {this.renderEdges(graph, position, width, height)}
          {graph.mode === 'stages' &&
            graph.columnLabels.map((label, i) => (
              <div
                key={i}
                className="graph-stage-label"
                style={{ left: x(i), top: Padding, width: CardWidth }}
              >
                {label}
              </div>
            ))}
          {jobs.map(job => {
            const pos = position.get(job.id)
            return pos === undefined ? null : this.renderJob(job, pos)
          })}
        </div>
      </div>
    )
  }

  private renderEdges(
    graph: IPipelineGraph,
    position: ReadonlyMap<number, { left: number; top: number }>,
    width: number,
    height: number
  ) {
    const { selectedJobId } = this.props
    const isSelected = (e: IGraphEdge) =>
      e.from === selectedJobId || e.to === selectedJobId
    // Draw the selected job's lines last so they sit on top.
    const edges = [...graph.edges].sort(
      (a, b) => Number(isSelected(a)) - Number(isSelected(b))
    )
    const ports = new Map<string, { cx: number; cy: number }>()

    const paths = edges.map(edge => {
      const from = position.get(edge.from)
      const to = position.get(edge.to)
      if (from === undefined || to === undefined) {
        return null
      }
      const x1 = from.left + CardWidth
      const y1 = from.top + CardHeight / 2
      const x2 = to.left
      const y2 = to.top + CardHeight / 2
      ports.set(`out:${edge.from}`, { cx: x1, cy: y1 })
      ports.set(`in:${edge.to}`, { cx: x2, cy: y2 })

      // Run along the source's row, turn in the gap before the target.
      const bend = x2 - ColumnGap / 2
      const dy = y2 - y1
      const r = Math.min(CornerRadius, Math.abs(dy) / 2)
      const sign = Math.sign(dy)
      const d =
        dy === 0
          ? `M ${x1} ${y1} H ${x2}`
          : `M ${x1} ${y1} H ${bend - r} ` +
            `Q ${bend} ${y1} ${bend} ${y1 + sign * r} ` +
            `V ${y2 - sign * r} ` +
            `Q ${bend} ${y2} ${bend + r} ${y2} H ${x2}`
      return (
        <path
          key={`${edge.from}-${edge.to}`}
          d={d}
          className={isSelected(edge) ? 'graph-edge selected' : 'graph-edge'}
        />
      )
    })

    return (
      <svg
        className="pipeline-graph-edges"
        width={width}
        height={height}
        aria-hidden={true}
      >
        {paths}
        {[...ports].map(([key, p]) => (
          <circle key={key} cx={p.cx} cy={p.cy} r={4} className="graph-port" />
        ))}
      </svg>
    )
  }

  private renderJob(job: IJobDetails, pos: { left: number; top: number }) {
    const color = getJobStatusColor(job.status)
    const selected = job.id === this.props.selectedJobId
    const duration = formatDuration(elapsed(job))
    const canRun = job.status === 'manual'
    const label = `${job.name} (${job.stage}): ${formatStatus(job.status)}${
      duration ? `, ${duration}` : ''
    }${job.allowFailure && job.status === 'failed' ? ' (allowed to fail)' : ''}`

    return (
      <div
        key={job.id}
        className={`graph-job status-${color} status-name-${job.status}${
          selected ? ' selected' : ''
        }`}
        style={{ left: pos.left, top: pos.top, width: CardWidth }}
      >
        <button
          type="button"
          className="graph-job-open"
          onClick={this.getOpenHandler(job.id)}
          aria-label={label}
          aria-current={selected}
        >
          <span className="graph-job-icon" aria-hidden={true} />
          <span className="graph-job-name">{job.name}</span>
          {!canRun && <span className="graph-job-duration">{duration}</span>}
        </button>
        {canRun && (
          <button
            type="button"
            className="graph-job-run"
            onClick={this.getRunHandler(job.id)}
            disabled={this.props.isRunning(job.id)}
            aria-label={`Run ${job.name}`}
          >
            ▶
          </button>
        )}
      </div>
    )
  }
}
