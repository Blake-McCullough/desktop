import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  SettingsBackupFormat,
  getBackupSections,
  matchRepositories,
  parseSettingsBackup,
  repositoryKey,
} from '../../src/lib/settings-backup'

describe('repositoryKey', () => {
  it('gives SSH and HTTPS clones of a repository the same key', () => {
    const ssh = repositoryKey('git@gitlab.com:Acme/Payments-API.git', 'x')
    const https = repositoryKey(
      'https://alex:token@gitlab.com/acme/payments-api.git',
      'x'
    )
    const sshUrl = repositoryKey(
      'ssh://git@gitlab.com:2222/acme/payments-api',
      'x'
    )
    assert.equal(ssh, 'gitlab.com/acme/payments-api')
    assert.equal(https, ssh)
    assert.equal(sshUrl, ssh)
  })

  it('falls back to the name without a usable remote', () => {
    assert.equal(repositoryKey(null, 'Dotfiles'), 'name:dotfiles')
    assert.equal(repositoryKey('/srv/git/local.git', 'local'), 'name:local')
  })
})

describe('matchRepositories', () => {
  const local = [
    { id: 1, key: 'gitlab.com/acme/pay', name: 'pay' },
    { id: 2, key: 'gitlab.com/acme/pay', name: 'pay-hotfix' },
    { id: 3, key: 'name:dotfiles', name: 'dotfiles' },
    { id: 4, key: 'github.com/me/blog', name: 'blog' },
  ]

  it('matches by remote, then by a unique name', () => {
    const { matched, unmatched } = matchRepositories(
      [
        { key: 'gitlab.com/acme/pay', name: 'payments' },
        { key: 'name:dotfiles', name: 'dotfiles' },
        { key: 'gitlab.com/other/blog', name: 'blog' },
        { key: 'gitlab.com/acme/gone', name: 'gone' },
      ],
      local
    )
    assert.deepEqual(
      matched.map(m => `${m.entry.name}>${m.id}`),
      ['payments>1', 'payments>2', 'dotfiles>3', 'blog>4']
    )
    assert.deepEqual(
      unmatched.map(u => u.name),
      ['gone']
    )
  })
})

describe('parseSettingsBackup', () => {
  it('keeps the well-formed parts', () => {
    const backup = parseSettingsBackup(
      JSON.stringify({
        format: SettingsBackupFormat,
        version: 1,
        exportedAt: '2026-11-19T00:00:00Z',
        appVersion: '3.6.11-custom1-b00026',
        groups: {
          groups: [
            { name: 'acme/platform', color: '#8250df', collapsed: true },
            { name: '' },
            { name: 'Personal', color: 'red' },
          ],
          repositories: [
            { key: 'gitlab.com/acme/pay', name: 'pay', group: 'acme/platform' },
            { key: 5 },
          ],
        },
        shortcuts: {
          overrides: { 'show-quick-switcher': 'CmdOrCtrl+E', x: 1 },
        },
        gitlab: { servers: ['https://git.example.com', 'ftp://nope', 3] },
        tagColors: {
          rules: [{ pattern: '^v', color: '#1a7f37' }, { pattern: 'x' }],
        },
      })
    )
    assert.deepEqual(backup.groups?.groups, [
      { name: 'acme/platform', color: '#8250df', collapsed: true },
      { name: 'Personal', color: undefined, collapsed: false },
    ])
    assert.equal(backup.groups?.repositories.length, 1)
    assert.deepEqual(backup.shortcuts?.overrides, {
      'show-quick-switcher': 'CmdOrCtrl+E',
    })
    assert.deepEqual(backup.gitlab?.servers, ['https://git.example.com'])
    assert.equal(backup.tagColors?.rules.length, 1)
    assert.deepEqual(getBackupSections(backup), [
      'groups',
      'shortcuts',
      'tagColors',
      'gitlab',
    ])
  })

  it('rejects files that are not backups', () => {
    assert.throws(() => parseSettingsBackup('nope'), /isn't JSON/)
    assert.throws(
      () => parseSettingsBackup('{"version":2}'),
      /isn't a settings backup/
    )
    assert.throws(
      () =>
        parseSettingsBackup(
          JSON.stringify({ format: SettingsBackupFormat, version: 9 })
        ),
      /newer version/
    )
  })
})
