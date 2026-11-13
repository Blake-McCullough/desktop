import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Path from 'path'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  lstat,
} from 'fs/promises'
import { tmpdir } from 'os'
import {
  getMoveRoot,
  IMovableRepository,
  isPathInside,
  movedPath,
  moveFolder,
  pathIsTaken,
  planRepositoryMoves,
} from '../../src/lib/move-repository'

const repo = (id: number, path: string): IMovableRepository => ({
  id,
  name: Path.basename(path),
  path,
})

const never = async () => false

describe('planRepositoryMoves', () => {
  it('keeps the layout below the common folder', async () => {
    const repos = [
      repo(1, '/home/me/code/work/api'),
      repo(2, '/home/me/code/personal/site'),
    ]
    const root = getMoveRoot(repos.map(r => r.path))
    assert.equal(root, '/home/me/code')
    const plans = await planRepositoryMoves(repos, root, '/mnt/dev', never)
    assert.deepEqual(
      plans.map(p => [p.action, p.to]),
      [
        ['move', '/mnt/dev/work/api'],
        ['move', '/mnt/dev/personal/site'],
      ]
    )
  })

  it('moves a single repository to an exact path', async () => {
    const plans = await planRepositoryMoves(
      [repo(1, '/home/me/code/api')],
      '/home/me/code',
      '/srv/renamed-api',
      never,
      '/srv/renamed-api'
    )
    assert.equal(plans[0].action, 'move')
    assert.equal(plans[0].to, '/srv/renamed-api')
  })

  it('carries nested repositories along with their parent', async () => {
    const repos = [repo(2, '/code/mono/packages/lib'), repo(1, '/code/mono')]
    const plans = await planRepositoryMoves(repos, '/code', '/new', never)
    assert.deepEqual(
      plans.map(p => [p.repository.id, p.action, p.to]),
      [
        [2, 'carried', '/new/mono/packages/lib'],
        [1, 'move', '/new/mono'],
      ]
    )
  })

  it('blocks moves into itself, onto existing paths and clashes', async () => {
    const exists = async (p: string) => p === '/new/taken'
    const plans = await planRepositoryMoves(
      [
        repo(1, '/a/taken'),
        repo(2, '/x/dup'),
        repo(3, '/y/dup'),
        repo(4, '/new/same'),
      ],
      null,
      '/new',
      exists
    )
    assert.deepEqual(
      plans.map(p => p.action),
      ['blocked', 'move', 'blocked', 'unchanged']
    )

    const inside = await planRepositoryMoves(
      [repo(1, '/a/repo')],
      '/a',
      '/a/repo/sub/repo',
      never,
      '/a/repo/sub/repo'
    )
    assert.equal(inside[0].action, 'blocked')
  })
})

describe('movedPath', () => {
  it('maps paths inside moved folders', () => {
    const moves = [{ from: '/code/mono', to: '/new/mono' }]
    assert.equal(movedPath('/code/mono/.git', moves), '/new/mono/.git')
    assert.equal(movedPath('/code/mono', moves), '/new/mono')
    assert.equal(movedPath('/code/monolith', moves), '/code/monolith')
    assert.equal(isPathInside('/code/monolith', '/code/mono'), false)
  })
})

describe('moveFolder', () => {
  it('moves a folder with its contents and creates parents', async () => {
    const base = await mkdtemp(Path.join(tmpdir(), 'move-folder-'))
    const from = Path.join(base, 'src', 'repo')
    await mkdir(Path.join(from, '.git'), { recursive: true })
    await writeFile(Path.join(from, 'file.txt'), 'hello')
    await symlink('file.txt', Path.join(from, 'link'))

    const to = Path.join(base, 'dest', 'nested', 'repo')
    const result = await moveFolder(from, to)

    assert.equal(result.leftOriginalBehind, false)
    assert.equal(await pathIsTaken(from), false)
    assert.equal(await readFile(Path.join(to, 'file.txt'), 'utf8'), 'hello')
    assert.ok((await lstat(Path.join(to, 'link'))).isSymbolicLink())
    assert.ok((await lstat(Path.join(to, '.git'))).isDirectory())
  })

  it('refuses to overwrite and leaves both folders alone', async () => {
    const base = await mkdtemp(Path.join(tmpdir(), 'move-folder-'))
    const from = Path.join(base, 'a')
    const to = Path.join(base, 'b')
    await mkdir(from)
    await mkdir(to)
    await writeFile(Path.join(from, 'x'), '1')

    await assert.rejects(moveFolder(from, to), /already exists/)
    assert.equal(await readFile(Path.join(from, 'x'), 'utf8'), '1')
  })

  it('fails cleanly when the source is missing', async () => {
    const base = await mkdtemp(Path.join(tmpdir(), 'move-folder-'))
    await assert.rejects(
      moveFolder(Path.join(base, 'nope'), Path.join(base, 'to')),
      /doesn't exist/
    )
    assert.equal(await pathIsTaken(Path.join(base, 'to')), false)
  })

  it('copies across file systems and removes the original', async t => {
    const other = '/dev/shm'
    if (process.platform !== 'linux' || !(await pathIsTaken(other))) {
      t.skip('no second file system to move to')
      return
    }
    const base = await mkdtemp(Path.join(tmpdir(), 'move-folder-'))
    const from = Path.join(base, 'repo')
    await mkdir(Path.join(from, 'sub'), { recursive: true })
    await writeFile(Path.join(from, 'sub', 'f'), 'data')
    const to = Path.join(
      await mkdtemp(Path.join(other, 'move-folder-')),
      'repo'
    )

    const result = await moveFolder(from, to)
    assert.equal(result.leftOriginalBehind, false)
    assert.equal(await pathIsTaken(from), false)
    assert.equal(await readFile(Path.join(to, 'sub', 'f'), 'utf8'), 'data')
  })
})
