import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  findLogMatches,
  highlightSpans,
  isLineHidden,
  lineText,
  logToText,
  parseJobLog,
} from '../../src/lib/gitlab/job-log'
import {
  formatDuration,
  getJobActions,
  toJobDetails,
} from '../../src/lib/gitlab/pipeline-details'

const E = '\x1b'

// Shaped like a real GitLab runner trace.
const log = [
  `${E}[0KRunning with gitlab-runner 17.5.0`,
  `section_start:1700000000:prepare_script\r${E}[0K${E}[0K${E}[36;1mPreparing environment${E}[0;m`,
  'Running on runner-abc',
  `section_end:1700000004:prepare_script\r${E}[0K`,
  `section_start:1700000004:step_script[collapsed=true]\r${E}[0K${E}[0K${E}[36;1mExecuting "step_script"${E}[0;m`,
  `${E}[32;1m$ npm test${E}[0;m`,
  'Downloading 10%\rDownloading 55%\rDownloading 100%',
  `${E}[31mFAIL${E}[0m src/app.test.ts`,
  `section_end:1700000065:step_script\r${E}[0K`,
  `${E}[31;1mERROR: Job failed: exit code 1${E}[0;m`,
  '',
].join('\n')

describe('parseJobLog', () => {
  const parsed = parseJobLog(log)

  it('turns sections into headers with durations', () => {
    const sections = [...parsed.sections.values()]
    assert.deepEqual(
      sections.map(s => [s.name, s.duration, s.collapsedByDefault]),
      [
        ['prepare_script', 4, false],
        ['step_script', 61, true],
      ]
    )
    const header = parsed.lines.find(l => l.startsSection === 2)!
    assert.equal(lineText(header), 'Executing "step_script"')
    assert.equal(header.spans[0].bold, true)
    assert.equal(header.spans[0].fg, '#39c5cf')
  })

  it('drops marker-only lines and keeps the final progress state', () => {
    const texts = parsed.lines.map(lineText)
    assert.deepEqual(texts, [
      'Running with gitlab-runner 17.5.0',
      'Preparing environment',
      'Running on runner-abc',
      'Executing "step_script"',
      '$ npm test',
      'Downloading 100%',
      'FAIL src/app.test.ts',
      'ERROR: Job failed: exit code 1',
    ])
  })

  it('colours text and resets', () => {
    const fail = parsed.lines.find(l => lineText(l).startsWith('FAIL'))!
    assert.equal(fail.spans[0].fg, '#e5534b')
    assert.equal(fail.spans[1].fg, undefined)
  })

  it('hides lines in collapsed sections, but not the header', () => {
    const collapsed = new Set([2])
    const visible = parsed.lines
      .filter(l => !isLineHidden(l, parsed.sections, collapsed))
      .map(lineText)
    assert.ok(visible.includes('Executing "step_script"'))
    assert.ok(!visible.includes('$ npm test'))
    assert.ok(visible.includes('ERROR: Job failed: exit code 1'))
  })

  it('supports 256 and true colour', () => {
    const p = parseJobLog(`${E}[38;5;196mred${E}[0m ${E}[38;2;1;2;3mrgb`)
    assert.equal(p.lines[0].spans[0].fg, 'rgb(255,0,0)')
    assert.equal(p.lines[0].spans[2].fg, 'rgb(1,2,3)')
  })
})

describe('pipeline details helpers', () => {
  it('formats durations', () => {
    assert.equal(formatDuration(45.2), '45s')
    assert.equal(formatDuration(65), '1m 05s')
    assert.equal(formatDuration(7380), '2h 03m')
    assert.equal(formatDuration(null), '')
  })

  it('offers the actions GitLab allows', () => {
    const job = (status: string) => toJobDetails({ id: 1, name: 'x', status })
    assert.deepEqual(getJobActions(job('manual')), ['play'])
    assert.deepEqual(getJobActions(job('running')), ['cancel'])
    assert.deepEqual(getJobActions(job('failed')), ['retry'])
    assert.deepEqual(getJobActions(job('skipped')), [])
  })

  it('knows when a job has an artifacts archive', () => {
    const job = toJobDetails({
      id: 1,
      name: 'build',
      status: 'success',
      artifacts: [
        { file_type: 'archive', filename: 'artifacts.zip', size: 10 },
      ],
    })
    assert.equal(job.hasArchive, true)
  })
})

describe('logToText', () => {
  it('copies every line as plain text, folded sections included', () => {
    const log = parseJobLog(
      '\x1b[0Ksection_start:1:build[collapsed=true]\r\x1b[0K\x1b[32mBuilding\x1b[0m\n' +
        'step one\n' +
        '\x1b[0Ksection_end:2:build\r\x1b[0K\n' +
        '\x1b[31mDone\x1b[0m'
    )
    assert.equal(logToText(log), 'Building\nstep one\nDone')
  })
})

describe('log search', () => {
  const log = parseJobLog(
    'Restoring packages\n\x1b[31mERROR\x1b[0m: build failed\nerror again, Error!'
  )

  it('finds every match, ignoring case', () => {
    const matches = findLogMatches(log, 'error')
    assert.deepEqual(
      matches.map(m => `${m.lineIndex}:${m.start}-${m.end}`),
      ['1:0-5', '2:0-5', '2:13-18']
    )
    assert.deepEqual(findLogMatches(log, ''), [])
  })

  it('splits coloured spans around a match', () => {
    const line = log.lines[1]
    const parts = highlightSpans(line.spans, [
      { start: 3, end: 7, current: true },
    ])
    assert.deepEqual(
      parts.map(p => [p.text, p.mark, p.fg !== undefined]),
      [
        ['ERR', null, true],
        ['OR', 'current', true],
        [': ', 'current', false],
        ['build failed', null, false],
      ]
    )
  })
})
