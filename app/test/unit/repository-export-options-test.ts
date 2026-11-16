import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Path from 'path'
import {
  applyExportOptions,
  buildRepositoryCsv,
  FullRepositoryExport,
  IRepositoryExportFile,
  IRepositoryExportOptions,
  mapImportPath,
  parseRepositoryExport,
  RepositoryExportFormat,
  stripUrlCredentials,
} from '../../src/lib/repository-import-export'

const full: IRepositoryExportFile = {
  format: RepositoryExportFormat,
  version: 1,
  exportedAt: '2026-11-16T00:00:00.000Z',
  platform: 'linux',
  groups: [
    { key: 'g1', name: 'Work', color: '#ff0000', collapsed: true },
    { key: 'g2', name: 'Unused' },
  ],
  repositories: [
    {
      name: 'api',
      alias: 'API',
      path: '/home/me/code/work/api',
      group: 'g1',
      remotes: [
        { name: 'upstream', url: 'https://example.com/up/api.git' },
        {
          name: 'origin',
          url: 'https://me:glpat-secret@example.com/me/api.git',
        },
      ],
    },
    {
      name: 'site',
      alias: null,
      path: '/home/me/code/site',
      group: null,
      remotes: [{ name: 'origin', url: 'git@example.com:me/site.git' }],
    },
  ],
}

const options = (
  changes: Partial<IRepositoryExportOptions>
): IRepositoryExportOptions => ({ ...FullRepositoryExport, ...changes })

describe('export options', () => {
  it('keeps everything for a full export', () => {
    assert.deepEqual(applyExportOptions(full, FullRepositoryExport), full)
  })

  it('drops fields that are turned off', () => {
    const data = applyExportOptions(
      full,
      options({
        remotes: 'none',
        groups: false,
        aliases: false,
      })
    )
    assert.deepEqual(data.groups, [])
    assert.ok(data.repositories.every(r => r.group === null))
    assert.ok(data.repositories.every(r => r.alias === null))
    assert.ok(data.repositories.every(r => r.remotes.length === 0))
    assert.equal(data.version, 1)
  })

  it('keeps only origin, strips credentials and unused groups', () => {
    const data = applyExportOptions(
      full,
      options({
        remotes: 'origin',
        stripRemoteCredentials: true,
        onlyUsedGroups: true,
        groupStyle: false,
      })
    )
    assert.deepEqual(data.repositories[0].remotes, [
      { name: 'origin', url: 'https://example.com/me/api.git' },
    ])
    assert.deepEqual(data.groups, [{ key: 'g1', name: 'Work' }])
  })

  it('writes paths relative to the shared folder as version 2', () => {
    const data = applyExportOptions(full, options({ location: 'relative' }))
    assert.deepEqual(
      data.repositories.map(r => r.path),
      ['work/api', 'site']
    )
    assert.equal(data.relativePaths, true)
    assert.equal(data.version, 2)

    // …and they import under the chosen folder, never above it.
    const parsed = parseRepositoryExport(JSON.parse(JSON.stringify(data)))
    assert.equal(parsed.relativePaths, true)
    assert.equal(
      mapImportPath('work/api', null, '/srv/code', true),
      Path.join('/srv/code', 'work', 'api')
    )
    assert.equal(
      mapImportPath('../../etc/x', null, '/srv/code', true),
      Path.join('/srv/code', 'etc', 'x')
    )
  })
})

describe('stripUrlCredentials', () => {
  it('removes secrets but leaves addresses alone', () => {
    assert.equal(
      stripUrlCredentials('https://user:tok@host/a.git'),
      'https://host/a.git'
    )
    assert.equal(
      stripUrlCredentials('https://oauth2@host/a.git'),
      'https://host/a.git'
    )
    assert.equal(stripUrlCredentials('git@host:a/b.git'), 'git@host:a/b.git')
    assert.equal(
      stripUrlCredentials('ssh://git@host:2222/a.git'),
      'ssh://git@host:2222/a.git'
    )
  })
})

describe('buildRepositoryCsv', () => {
  it('writes the chosen columns, quoted and formula-safe', () => {
    const odd: IRepositoryExportFile = {
      ...full,
      repositories: [
        { ...full.repositories[1], name: '=cmd', alias: 'a, "b"' },
      ],
    }
    const csv = buildRepositoryCsv(odd, options({ remotes: 'origin' }))
    const [header, row] = csv.trim().split('\r\n')
    assert.equal(header, 'Name,Alias,Path,Group,Group color,Remote URL')
    assert.equal(
      row,
      `'=cmd,"a, ""b""",/home/me/code/site,,,git@example.com:me/site.git`
    )
  })
})
