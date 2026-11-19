import * as React from 'react'
import memoizeOne from 'memoize-one'
import {
  IJobDetails,
  ITestReport,
  formatDuration,
} from '../lib/gitlab/pipeline-details'
import {
  ITestRow,
  isFailure,
  listTestRows,
  testCaseToText,
} from '../lib/gitlab/test-report'

interface ITestsViewProps {
  readonly report: ITestReport | null
  readonly isLoading: boolean
  /** Why the report couldn't be loaded, if it couldn't. */
  readonly error: string | null
  readonly jobs: ReadonlyArray<IJobDetails>
  readonly onOpenJobLog: (jobId: number) => void
  readonly onCopy: (text: string, what: string) => void
}

interface ITestsViewState {
  readonly filter: string
  readonly showPassed: boolean
  /** Rows whose output / stack trace is open. */
  readonly expanded: ReadonlySet<string>
}

/** Rendering thousands of passing tests at once is slow and pointless. */
const RowLimit = 500

/** Test times are often under a second: show those in milliseconds. */
function formatTestTime(seconds: number): string {
  return seconds < 1
    ? `${Math.round(seconds * 1000)} ms`
    : formatDuration(seconds)
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

const StatusLabel: Record<string, string> = {
  failed: 'Failed',
  error: 'Error',
  skipped: 'Skipped',
  success: 'Passed',
}

/**
 * The pipeline's test results, from the JUnit reports GitLab collected:
 * failures first, each with its message and stack trace.
 */
export class TestsView extends React.Component<
  ITestsViewProps,
  ITestsViewState
> {
  private readonly toggleHandlers = new Map<string, () => void>()
  private readonly copyHandlers = new Map<string, () => void>()
  private readonly logHandlers = new Map<number, () => void>()

  private getRows = memoizeOne(
    (report: ITestReport, filter: string, showPassed: boolean) =>
      listTestRows(report, { filter, showPassed })
  )

  public constructor(props: ITestsViewProps) {
    super(props)
    this.state = { filter: '', showPassed: false, expanded: new Set() }
  }

  private onFilterChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ filter: event.currentTarget.value })
  }

  private onShowPassedChanged = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    this.setState({ showPassed: event.currentTarget.checked })
  }

  private getToggle(key: string) {
    let handler = this.toggleHandlers.get(key)
    if (handler === undefined) {
      handler = () =>
        this.setState(prev => {
          const expanded = new Set(prev.expanded)
          if (expanded.has(key)) {
            expanded.delete(key)
          } else {
            expanded.add(key)
          }
          return { expanded }
        })
      this.toggleHandlers.set(key, handler)
    }
    return handler
  }

  private getCopy(row: ITestRow) {
    let handler = this.copyHandlers.get(row.key)
    if (handler === undefined) {
      handler = () =>
        this.props.onCopy(testCaseToText(row), `"${row.testCase.name}"`)
      this.copyHandlers.set(row.key, handler)
    }
    return handler
  }

  private getOpenLog(jobId: number) {
    let handler = this.logHandlers.get(jobId)
    if (handler === undefined) {
      handler = () => this.props.onOpenJobLog(jobId)
      this.logHandlers.set(jobId, handler)
    }
    return handler
  }

  /** The job a suite came from (GitLab names suites after their jobs). */
  private jobFor(suiteName: string): IJobDetails | undefined {
    // The newest run of the job, if it was retried.
    return [...this.props.jobs].reverse().find(j => j.name === suiteName)
  }

  public render() {
    const { report, isLoading, error } = this.props
    if (report === null) {
      return (
        <div className="pipeline-tests empty">
          {error !== null
            ? `Couldn't load the test results: ${error}`
            : isLoading
            ? 'Loading test results…'
            : 'No test results yet.'}
        </div>
      )
    }

    if (report.totalCount === 0 && report.suites.length === 0) {
      return (
        <div className="pipeline-tests empty">
          <div className="tests-empty-message">
            <h2>No test results for this pipeline</h2>
            <p>
              GitLab only collects test results from jobs that save a JUnit XML
              report and list it in the job's{' '}
              <code>artifacts: reports: junit:</code> section. Most test runners
              can write JUnit XML (for .NET <code>.trx</code> files, convert
              them with <code>trx2junit</code>).
            </p>
          </div>
        </div>
      )
    }

    const rows = this.getRows(report, this.state.filter, this.state.showPassed)
    const shown = rows.slice(0, RowLimit)
    const failures = report.failedCount + report.errorCount

    return (
      <div className="pipeline-tests">
        <div className="tests-summary">
          <div
            className={`tests-headline ${failures > 0 ? 'failed' : 'passed'}`}
          >
            {failures > 0
              ? `${failures.toLocaleString()} of ${report.totalCount.toLocaleString()} tests failed`
              : report.totalCount === 1
              ? 'The test passed'
              : `All ${report.totalCount.toLocaleString()} tests passed`}
          </div>
          <div className="tests-counts">
            <span className="count-passed">
              {report.successCount.toLocaleString()} passed
            </span>
            <span className="count-failed">
              {report.failedCount.toLocaleString()} failed
            </span>
            {report.errorCount > 0 && (
              <span className="count-failed">
                {plural(report.errorCount, 'error', 'errors')}
              </span>
            )}
            <span className="count-skipped">
              {report.skippedCount.toLocaleString()} skipped
            </span>
            {report.totalTime > 0 && (
              <span>{formatDuration(report.totalTime)}</span>
            )}
          </div>
          <table className="tests-suites">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Failed</th>
                <th scope="col">Passed</th>
                <th scope="col">Skipped</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {report.suites.map((suite, i) => (
                <tr key={i}>
                  <td>
                    {suite.name}
                    {suite.suiteError !== null && (
                      <div className="suite-error">{suite.suiteError}</div>
                    )}
                  </td>
                  <td
                    className={
                      suite.failedCount + suite.errorCount > 0
                        ? 'count-failed'
                        : undefined
                    }
                  >
                    {(suite.failedCount + suite.errorCount).toLocaleString()}
                  </td>
                  <td>{suite.successCount.toLocaleString()}</td>
                  <td>{suite.skippedCount.toLocaleString()}</td>
                  <td>{formatDuration(suite.totalTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="tests-toolbar">
          <input
            type="search"
            placeholder="Filter by test, class, file or message"
            aria-label="Filter tests"
            value={this.state.filter}
            onChange={this.onFilterChanged}
          />
          <label>
            <input
              type="checkbox"
              checked={this.state.showPassed}
              onChange={this.onShowPassedChanged}
            />{' '}
            Show passed and skipped tests
          </label>
        </div>

        {rows.length === 0 ? (
          <p className="tests-none">
            {this.state.filter.trim().length > 0
              ? 'No tests match the filter.'
              : this.state.showPassed
              ? 'No tests.'
              : 'No failed tests.'}
          </p>
        ) : (
          <ul className="tests-list">
            {shown.map(row => this.renderRow(row))}
          </ul>
        )}
        {rows.length > shown.length && (
          <p className="tests-none">
            Showing the first {RowLimit.toLocaleString()} of{' '}
            {rows.length.toLocaleString()} tests. Filter to narrow them down.
          </p>
        )}
      </div>
    )
  }

  private renderRow(row: ITestRow) {
    const { testCase, suite, key } = row
    const failed = isFailure(testCase.status)
    const hasDetails = testCase.output !== null || testCase.stackTrace !== null
    // Failures start open: that's what you came for.
    const open = failed !== this.state.expanded.has(key)
    const job = this.jobFor(suite.name)

    return (
      <li key={key} className={`test-row test-${testCase.status}`}>
        <div className="test-header">
          <span className="test-icon" aria-hidden={true} />
          <div className="test-title">
            {hasDetails ? (
              <button
                type="button"
                className="test-name"
                onClick={this.getToggle(key)}
                aria-expanded={open}
              >
                <span className="test-caret" aria-hidden={true}>
                  {open ? '▾' : '▸'}
                </span>
                {testCase.name}
              </button>
            ) : (
              <span className="test-name">{testCase.name}</span>
            )}
            <div className="test-meta">
              <span>{StatusLabel[testCase.status] ?? testCase.status}</span>
              {testCase.classname !== null && <span>{testCase.classname}</span>}
              {testCase.file !== null && <span>{testCase.file}</span>}
              <span>Job: {suite.name}</span>
              {testCase.executionTime !== null && (
                <span>{formatTestTime(testCase.executionTime)}</span>
              )}
              {testCase.recentFailures !== null &&
                testCase.recentFailures > 0 && (
                  <span className="test-flaky">
                    Failed {testCase.recentFailures}× recently on the default
                    branch
                  </span>
                )}
            </div>
          </div>
          <div className="test-actions">
            {failed && (
              <button type="button" onClick={this.getCopy(row)}>
                Copy
              </button>
            )}
            {job !== undefined && (
              <button type="button" onClick={this.getOpenLog(job.id)}>
                Job log
              </button>
            )}
          </div>
        </div>
        {open && hasDetails && (
          <pre className="test-output">
            {[testCase.output, testCase.stackTrace]
              .filter(t => t !== null)
              .join('\n\n')}
          </pre>
        )}
      </li>
    )
  }
}
