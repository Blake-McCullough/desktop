import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Path from 'path'
import {
  RepositoryExportFormat,
  getCommonRoot,
  mapImportPath,
  parseRepositoryExport,
} from '../../src/lib/repository-import-export'

describe('repository import/export', () => {
  describe('getCommonRoot', () => {
    it('finds the shared parent folder', () => {
      assert.equal(
        getCommonRoot(['/home/me/code/a', '/home/me/code/sub/b']),
        '/home/me/code'
      )
    })

    it('handles Windows paths', () => {
      assert.equal(
        getCommonRoot([
          'C:\\Users\\Blake\\code\\a',
          'C:\\Users\\Blake\\code\\b',
        ]),
        'C:\\Users\\Blake\\code'
      )
    })

    it('returns null when nothing is shared', () => {
      assert.equal(getCommonRoot(['C:\\a\\x', 'D:\\b\\y']), null)
      assert.equal(getCommonRoot([]), null)
    })
  })

  describe('mapImportPath', () => {
    it('moves paths under a new root, keeping structure', () => {
      assert.equal(
        mapImportPath('C:\\code\\team\\app', 'C:\\code', '/Users/me/src'),
        Path.join('/Users/me/src', 'team', 'app')
      )
    })

    it('keeps the original path without a new root', () => {
      assert.equal(
        mapImportPath('/home/me/app', '/home/me', null),
        Path.normalize('/home/me/app')
      )
    })

    it('keeps paths outside the old root', () => {
      assert.equal(
        mapImportPath('/other/app', '/home/me', '/new'),
        Path.normalize('/other/app')
      )
    })
  })

  describe('parseRepositoryExport', () => {
    it('rejects files that are not exports', () => {
      assert.throws(() => parseRepositoryExport({ hello: 1 }))
      assert.throws(() => parseRepositoryExport(null))
    })

    it('rejects newer versions', () => {
      assert.throws(() =>
        parseRepositoryExport({ format: RepositoryExportFormat, version: 99 })
      )
    })

    it('drops invalid entries and dangling group references', () => {
      const parsed = parseRepositoryExport({
        format: RepositoryExportFormat,
        version: 1,
        exportedAt: '2026-01-01T00:00:00Z',
        groups: [
          { key: 'g1', name: ' Work ', color: '#ff0000' },
          { key: 'g2', name: '', color: 'red' },
          { key: 'g3', name: 'Bad colour', color: 'red' },
        ],
        repositories: [
          {
            name: 'app',
            alias: '',
            path: '/code/app',
            group: 'g1',
            remotes: [{ name: 'origin', url: 'git@gitlab.com:a/app.git' }, 5],
          },
          { name: 'lib', path: '/code/lib', group: 'missing', remotes: [] },
          { name: 'no-path' },
        ],
      })

      assert.equal(parsed.groups.length, 2)
      assert.equal(parsed.groups[0].name, 'Work')
      assert.equal(parsed.groups[1].color, undefined)
      assert.equal(parsed.repositories.length, 2)
      assert.equal(parsed.repositories[0].alias, null)
      assert.equal(parsed.repositories[0].remotes.length, 1)
      assert.equal(parsed.repositories[1].group, null)
    })
  })
})
