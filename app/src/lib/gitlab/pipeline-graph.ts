import { IPipelineNeeds } from './pipeline-details'

/** The bits of a job the graph layout needs. */
export interface IGraphJob {
  readonly id: number
  readonly name: string
  readonly stage: string
}

export interface IGraphNode {
  readonly jobId: number
  readonly column: number
  readonly row: number
}

export interface IGraphEdge {
  readonly from: number
  readonly to: number
}

export interface IPipelineGraph {
  readonly nodes: ReadonlyArray<IGraphNode>
  readonly edges: ReadonlyArray<IGraphEdge>
  readonly columns: number
  readonly rows: number
  /**
   * `needs`: columns follow the jobs' `needs:` (like GitHub's graph).
   * `stages`: GitLab didn't say, so there's one column per stage.
   */
  readonly mode: 'needs' | 'stages'
  /** Stage name above each column, in `stages` mode. */
  readonly columnLabels: ReadonlyArray<string | null>
}

/** Stages in pipeline order: GitLab's order, then any others as they appear. */
function stageOrder(
  jobs: ReadonlyArray<IGraphJob>,
  known: ReadonlyArray<string>
): ReadonlyArray<string> {
  const order = known.filter(s => jobs.some(j => j.stage === s))
  for (const job of jobs) {
    if (!order.includes(job.stage)) {
      order.push(job.stage)
    }
  }
  return order
}

/**
 * The jobs a `needs:` entry refers to. Parallel and matrix jobs are named
 * e.g. `test 1/3` or `build: [linux]`, and needing `test` means all of them.
 */
function jobsNamed(name: string, jobs: ReadonlyArray<IGraphJob>) {
  const exact = jobs.filter(j => j.name === name)
  if (exact.length > 0) {
    return exact
  }
  return jobs.filter(
    j => j.name.startsWith(`${name} `) || j.name.startsWith(`${name}:`)
  )
}

/**
 * Lay out a pipeline as a left-to-right graph: each job sits one column
 * after the last job it waits for, and on the same row as the first of
 * them when that row is free, so chains of jobs read as straight lines.
 */
export function layoutPipelineGraph(
  jobs: ReadonlyArray<IGraphJob>,
  needs: IPipelineNeeds | null
): IPipelineGraph {
  const stages = stageOrder(jobs, needs?.stages ?? [])
  const stageIndex = new Map(stages.map((s, i) => [s, i]))
  const stageOf = (job: IGraphJob) => stageIndex.get(job.stage) ?? 0
  const byStage = stages.map(s => jobs.filter(j => j.stage === s))

  // What each job waits for. Without `needs:` a job waits for every job in
  // earlier stages; drawing only the stage just before keeps it readable.
  const deps = new Map<number, ReadonlyArray<IGraphJob>>()
  for (const job of jobs) {
    const declared = needs?.needs.get(job.name)
    if (declared !== undefined && declared !== null) {
      const found = new Map<number, IGraphJob>()
      for (const name of declared) {
        for (const dep of jobsNamed(name, jobs)) {
          if (dep.id !== job.id) {
            found.set(dep.id, dep)
          }
        }
      }
      deps.set(job.id, [...found.values()])
    } else {
      const previous = byStage
        .slice(0, stageOf(job))
        .reverse()
        .find(list => list.length > 0)
      deps.set(job.id, previous ?? [])
    }
  }

  const mode: IPipelineGraph['mode'] =
    needs !== null && jobs.some(j => needs.needs.has(j.name))
      ? 'needs'
      : 'stages'

  // Columns: the longest chain of dependencies before each job (stage
  // index in `stages` mode). Guard against cycles from odd data.
  const column = new Map<number, number>()
  const visiting = new Set<number>()
  const columnOf = (job: IGraphJob): number => {
    const known = column.get(job.id)
    if (known !== undefined) {
      return known
    }
    if (visiting.has(job.id)) {
      return 0
    }
    visiting.add(job.id)
    const list = deps.get(job.id) ?? []
    const value =
      list.length === 0 ? 0 : Math.max(...list.map(d => columnOf(d) + 1))
    visiting.delete(job.id)
    column.set(job.id, value)
    return value
  }
  for (const job of jobs) {
    if (mode === 'stages') {
      column.set(job.id, stageOf(job))
    } else {
      columnOf(job)
    }
  }

  // Squeeze out empty columns (e.g. stages with no jobs).
  const used = [...new Set(column.values())].sort((a, b) => a - b)
  const squeeze = new Map(used.map((c, i) => [c, i]))
  const columns = used.length

  // Rows, column by column: prefer the row of the job's first dependency.
  const row = new Map<number, number>()
  const order = new Map(jobs.map((j, i) => [j.id, i]))
  for (let c = 0; c < columns; c++) {
    const inColumn = jobs.filter(j => squeeze.get(column.get(j.id)!) === c)
    const preferred = (job: IGraphJob) => {
      const rows = (deps.get(job.id) ?? [])
        .map(d => row.get(d.id))
        .filter((r): r is number => r !== undefined)
      return rows.length === 0 ? 0 : Math.min(...rows)
    }
    inColumn.sort(
      (a, b) =>
        preferred(a) - preferred(b) ||
        stageOf(a) - stageOf(b) ||
        order.get(a.id)! - order.get(b.id)!
    )
    let next = 0
    for (const job of inColumn) {
      const r = Math.max(preferred(job), next)
      row.set(job.id, r)
      next = r + 1
    }
  }

  const nodes = jobs.map(j => ({
    jobId: j.id,
    column: squeeze.get(column.get(j.id)!)!,
    row: row.get(j.id)!,
  }))
  const edges = jobs.flatMap(j =>
    (deps.get(j.id) ?? []).map(d => ({ from: d.id, to: j.id }))
  )
  const columnLabels =
    mode === 'stages' ? used.map(c => stages[c] ?? null) : used.map(() => null)

  return {
    nodes,
    edges,
    columns,
    rows: nodes.length === 0 ? 0 : Math.max(...nodes.map(n => n.row)) + 1,
    mode,
    columnLabels,
  }
}
