import { ITestCase, ITestReport, ITestSuite } from './pipeline-details'

export interface ITestRow {
  readonly suite: ITestSuite
  readonly testCase: ITestCase
  /** Stable key for React and for remembering what's expanded. */
  readonly key: string
}

const StatusOrder: Record<string, number> = {
  failed: 0,
  error: 0,
  skipped: 2,
  success: 3,
}

export const isFailure = (status: string) =>
  status === 'failed' || status === 'error'

/**
 * The tests to list: failures (and errors) first, then skipped, then
 * passed; within those, by suite then name. `showPassed` adds skipped and
 * passed tests; `filter` matches the name, class, file, suite or output.
 */
export function listTestRows(
  report: ITestReport,
  options: { readonly filter: string; readonly showPassed: boolean }
): ReadonlyArray<ITestRow> {
  const needle = options.filter.trim().toLowerCase()
  const rows = new Array<ITestRow>()

  report.suites.forEach((suite, s) => {
    suite.testCases.forEach((testCase, t) => {
      if (!options.showPassed && !isFailure(testCase.status)) {
        return
      }
      if (needle.length > 0) {
        const haystack = [
          suite.name,
          testCase.name,
          testCase.classname ?? '',
          testCase.file ?? '',
          testCase.output ?? '',
        ]
          .join('\n')
          .toLowerCase()
        if (!haystack.includes(needle)) {
          return
        }
      }
      rows.push({ suite, testCase, key: `${s}:${t}` })
    })
  })

  return rows.sort(
    (a, b) =>
      (StatusOrder[a.testCase.status] ?? 1) -
        (StatusOrder[b.testCase.status] ?? 1) ||
      a.suite.name.localeCompare(b.suite.name) ||
      (a.testCase.classname ?? '').localeCompare(b.testCase.classname ?? '') ||
      a.testCase.name.localeCompare(b.testCase.name)
  )
}

/** Failed + errored tests per suite (job) name, for the graph cards. */
export function failuresBySuite(
  report: ITestReport | null
): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  for (const suite of report?.suites ?? []) {
    const count = suite.failedCount + suite.errorCount
    if (count > 0) {
      result.set(suite.name, (result.get(suite.name) ?? 0) + count)
    }
  }
  return result
}

/** A failed test as plain text, for pasting into an issue or chat. */
export function testCaseToText(row: ITestRow): string {
  const { suite, testCase } = row
  const title = testCase.classname
    ? `${testCase.classname}.${testCase.name}`
    : testCase.name
  return [
    `${title} (${testCase.status})`,
    `Job: ${suite.name}`,
    testCase.file ? `File: ${testCase.file}` : null,
    testCase.output ? `\n${testCase.output}` : null,
    testCase.stackTrace ? `\n${testCase.stackTrace}` : null,
  ]
    .filter(l => l !== null)
    .join('\n')
}
