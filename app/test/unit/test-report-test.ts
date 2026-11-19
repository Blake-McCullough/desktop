import { describe, it } from 'node:test'
import assert from 'node:assert'
import { toTestReport } from '../../src/lib/gitlab/pipeline-details'
import {
  failuresBySuite,
  listTestRows,
  testCaseToText,
} from '../../src/lib/gitlab/test-report'

const report = toTestReport({
  total_time: 12.5,
  total_count: 5,
  success_count: 2,
  failed_count: 1,
  skipped_count: 1,
  error_count: 1,
  test_suites: [
    {
      name: 'dotnet-test',
      total_count: 3,
      success_count: 1,
      failed_count: 1,
      skipped_count: 1,
      test_cases: [
        { status: 'success', name: 'Adds', classname: 'MathTests' },
        {
          status: 'failed',
          name: 'Divides',
          classname: 'MathTests',
          file: 'tests/MathTests.cs',
          system_output: 'Expected 2 but was 3',
          stack_trace: 'at MathTests.Divides() line 14',
          recent_failures: { count: 2 },
        },
        { status: 'skipped', name: 'Slow', classname: 'MathTests' },
      ],
    },
    {
      name: 'vitest',
      total_count: 2,
      success_count: 1,
      error_count: 1,
      test_cases: [
        { status: 'error', name: 'renders', classname: 'Button.test.tsx' },
        { status: 'success', name: 'clicks', classname: 'Button.test.tsx' },
      ],
    },
  ],
})

describe('test reports', () => {
  it('parses GitLab test_report JSON', () => {
    assert.equal(report.totalCount, 5)
    assert.equal(report.suites.length, 2)
    const divides = report.suites[0].testCases[1]
    assert.equal(divides.output, 'Expected 2 but was 3')
    assert.equal(divides.recentFailures, 2)
    assert.equal(report.suites[0].testCases[0].output, null)
  })

  it('lists failures and errors only by default, sorted by job', () => {
    const rows = listTestRows(report, { filter: '', showPassed: false })
    assert.deepEqual(
      rows.map(r => `${r.suite.name}/${r.testCase.name}`),
      ['dotnet-test/Divides', 'vitest/renders']
    )
  })

  it('lists everything, failures first, when showing passed tests', () => {
    const rows = listTestRows(report, { filter: '', showPassed: true })
    assert.deepEqual(
      rows.map(r => r.testCase.status),
      ['failed', 'error', 'skipped', 'success', 'success']
    )
  })

  it('filters on the failure message too', () => {
    const rows = listTestRows(report, { filter: 'BUT WAS', showPassed: true })
    assert.deepEqual(
      rows.map(r => r.testCase.name),
      ['Divides']
    )
  })

  it('counts failures per job for the graph', () => {
    assert.deepEqual(
      [...failuresBySuite(report)],
      [
        ['dotnet-test', 1],
        ['vitest', 1],
      ]
    )
    assert.equal(failuresBySuite(null).size, 0)
  })

  it('copies a failure as readable text', () => {
    const [row] = listTestRows(report, { filter: 'Divides', showPassed: false })
    assert.equal(
      testCaseToText(row),
      'MathTests.Divides (failed)\nJob: dotnet-test\nFile: tests/MathTests.cs\n\nExpected 2 but was 3\n\nat MathTests.Divides() line 14'
    )
  })
})
