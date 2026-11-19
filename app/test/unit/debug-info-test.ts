import { describe, it } from 'node:test'
import assert from 'node:assert'
import { formatDebugInfo, redactLogText } from '../../src/lib/debug-info'

describe('redactLogText', () => {
  it('removes tokens, auth headers and URL passwords', () => {
    const text = [
      'using glpat-EXAMPLE-NOT-REAL for gitlab',
      'gh token ghp_EXAMPLE_NOT_A_REAL_TOKEN',
      'headers: {"PRIVATE-TOKEN": "secret-value"}',
      'Authorization: Bearer abc.def.ghi',
      'fetch https://alex:hunter2@gitlab.example.com/acme/pay.git',
    ].join('\n')
    const out = redactLogText(text, '/home/alex')
    assert.ok(!out.includes('glpat-EXAMPLE'))
    assert.ok(!out.includes('ghp_EXAMPLE'))
    assert.ok(!out.includes('secret-value'))
    assert.ok(!out.includes('abc.def.ghi'))
    assert.ok(!out.includes('hunter2'))
    assert.ok(out.includes('"PRIVATE-TOKEN": "[redacted]'))
    assert.ok(out.includes('https://alex:[redacted]@gitlab.example.com'))
  })

  it('replaces the home folder with ~', () => {
    assert.equal(
      redactLogText('opened /home/alex/code/pay', '/home/alex'),
      'opened ~/code/pay'
    )
    assert.equal(
      redactLogText(
        'C:\\Users\\Alex\\code and C:/Users/Alex/x',
        'C:\\Users\\Alex'
      ),
      '~\\code and ~/x'
    )
  })
})

describe('formatDebugInfo', () => {
  it('summarises the app without secrets', () => {
    const text = formatDebugInfo({
      appName: 'GitHub Desktop Custom GitLab CI',
      main: {
        appVersion: '3.6.11-custom1-b00026',
        electron: '40.1.0',
        chrome: '144.0',
        node: '24.1.0',
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.17.1-cachyos',
        installKind: 'pacman',
        logTail: 'info: loaded /home/alex/code with glpat-EXAMPLE-NOT-REAL',
        logFileName: '2026-11-19.desktop.production.log',
      },
      os: 'Linux',
      gitVersion: 'git version 2.51.0',
      theme: 'dark',
      repositoryCount: 8,
      groupCount: 3,
      gitLabServers: [{ host: 'gitlab.com', hasToken: true }],
      sidebarVisible: true,
      systemMenuBar: false,
      homeDirectory: '/home/alex',
    })
    assert.ok(text.startsWith('GitHub Desktop Custom GitLab CI 3.6.11'))
    assert.ok(text.includes('GitLab servers: gitlab.com (token set)'))
    assert.ok(text.includes('info: loaded ~/code with [redacted]'))
    assert.ok(text.includes('Menu bar: in-app'))
  })
})
