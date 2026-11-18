import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert'

const stored = new Map<string, string>()
mock.module('../../src/lib/stores/token-store', {
  namedExports: {
    TokenStore: {
      getItem: async (key: string, login: string) =>
        stored.get(`${key}|${login}`) ?? null,
      setItem: async (key: string, login: string, value: string) => {
        stored.set(`${key}|${login}`, value)
      },
      deleteItem: async (key: string, login: string) => {
        stored.delete(`${key}|${login}`)
      },
    },
  },
})

const load = () => import('../../src/lib/gitlab/gitlab-token')

describe('GitLab tokens per instance', () => {
  beforeEach(async () => {
    const { setGitLabToken } = await load()
    for (const instance of [
      null,
      'https://gitlab.com',
      'https://git.example.com',
    ]) {
      await setGitLabToken(null, instance)
    }
  })

  it('keeps using an existing single token as the default', async () => {
    // How the token was stored before per-instance tokens existed.
    stored.set('GitHub Desktop - GitLab|gitlab-token', 'old-token')
    const { getGitLabToken, setGitLabToken } = await load()
    // Re-read past the cache.
    await setGitLabToken('old-token')
    assert.equal(await getGitLabToken('https://gitlab.com'), 'old-token')
    assert.equal(await getGitLabToken('https://git.example.com'), 'old-token')
  })

  it("uses an instance's own token, and the default for the rest", async () => {
    const { getGitLabToken, setGitLabToken, getGitLabInstanceToken } =
      await load()
    await setGitLabToken('default-token')
    await setGitLabToken('selfhosted-token', 'git.example.com/')

    assert.equal(
      await getGitLabToken('https://git.example.com'),
      'selfhosted-token'
    )
    assert.equal(await getGitLabToken('https://gitlab.com'), 'default-token')
    assert.equal(await getGitLabInstanceToken('https://gitlab.com'), null)
    assert.ok(
      stored.has('GitHub Desktop - GitLab|instance:https://git.example.com')
    )
  })

  it('has no token anywhere until one is set', async () => {
    const { getGitLabToken, hasAnyGitLabToken, setGitLabToken } = await load()
    assert.equal(await getGitLabToken('https://gitlab.com'), null)
    assert.equal(await hasAnyGitLabToken(), false)
    await setGitLabToken('x', 'https://gitlab.com')
    assert.equal(await hasAnyGitLabToken(), true)
    // Clearing removes it from the keyring.
    await setGitLabToken('', 'https://gitlab.com')
    assert.equal(
      stored.has('GitHub Desktop - GitLab|instance:https://gitlab.com'),
      false
    )
  })
})
