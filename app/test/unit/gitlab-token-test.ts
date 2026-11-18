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

const Service = 'GitHub Desktop - GitLab'

describe('GitLab tokens per server', () => {
  beforeEach(async () => {
    const { setGitLabToken } = await load()
    for (const instance of [
      'https://gitlab.com',
      'https://git.example.com',
      'https://other.example.com',
    ]) {
      await setGitLabToken(null, instance)
    }
  })

  // Runs first: the old default token is only read once per app session.
  it('hands the old default token to each server once', async () => {
    // How the token was stored when there was a single default token.
    stored.set(`${Service}|gitlab-token`, 'old-token')
    localStorage.removeItem('gitlab/default-token-migrated-to')
    const { getGitLabToken, setGitLabToken, forgetLegacyDefaultGitLabToken } =
      await load()

    assert.equal(await getGitLabToken('https://gitlab.com'), 'old-token')
    assert.equal(
      stored.get(`${Service}|instance:https://gitlab.com`),
      'old-token'
    )

    // Clearing a server's token doesn't bring the old one back.
    await setGitLabToken('', 'https://gitlab.com')
    assert.equal(await getGitLabToken('https://gitlab.com'), null)

    // Saving Preferences removes the old token for good.
    await forgetLegacyDefaultGitLabToken()
    assert.equal(stored.has(`${Service}|gitlab-token`), false)
    assert.equal(await getGitLabToken('https://other.example.com'), null)
  })

  it("uses each server's own token and nothing else", async () => {
    const { getGitLabToken, setGitLabToken } = await load()
    await setGitLabToken('selfhosted-token', 'git.example.com/')

    assert.equal(
      await getGitLabToken('https://git.example.com'),
      'selfhosted-token'
    )
    assert.equal(await getGitLabToken('https://gitlab.com'), null)
    assert.ok(stored.has(`${Service}|instance:https://git.example.com`))
  })

  it('removes a cleared token from the keyring', async () => {
    const { getGitLabToken, setGitLabToken } = await load()
    await setGitLabToken('x', 'https://gitlab.com')
    assert.equal(await getGitLabToken('https://gitlab.com'), 'x')
    await setGitLabToken('', 'https://gitlab.com')
    assert.equal(stored.has(`${Service}|instance:https://gitlab.com`), false)
  })

  it('rejects an address that is not a server', async () => {
    const { getGitLabToken, setGitLabToken } = await load()
    assert.equal(await getGitLabToken('not a url'), null)
    await assert.rejects(setGitLabToken('x', 'not a url'))
  })
})
