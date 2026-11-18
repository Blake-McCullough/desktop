import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { shouldRequestShortLivedTokens } from '../../src/lib/short-lived-token-rollout'

describe('short-lived token rollout', () => {
  const development = __DEV__
  const channel = __RELEASE_CHANNEL__
  const preview = process.env.GITHUB_DESKTOP_PREVIEW_FEATURES

  beforeEach(() => {
    Object.assign(globalThis, {
      __DEV__: false,
      __RELEASE_CHANNEL__: 'production',
    })
    delete process.env.GITHUB_DESKTOP_PREVIEW_FEATURES
  })

  afterEach(() => {
    Object.assign(globalThis, {
      __DEV__: development,
      __RELEASE_CHANNEL__: channel,
    })
    if (preview === undefined) {
      delete process.env.GITHUB_DESKTOP_PREVIEW_FEATURES
    } else {
      process.env.GITHUB_DESKTOP_PREVIEW_FEATURES = preview
    }
  })

  it("never asks GitHub's servers", async t => {
    const fetch = t.mock.method(globalThis, 'fetch')
    assert.equal(
      await shouldRequestShortLivedTokens('https://api.github.com'),
      false
    )
    assert.equal(fetch.mock.callCount(), 0)
  })

  for (const build of ['beta', 'development', 'preview']) {
    it(`follows the ${build} build's opt-in, but never for GHES`, async () => {
      Object.assign(globalThis, {
        __DEV__: build === 'development',
        __RELEASE_CHANNEL__: build === 'beta' ? 'beta' : 'production',
      })
      if (build === 'preview') {
        process.env.GITHUB_DESKTOP_PREVIEW_FEATURES = '1'
      }
      assert.equal(
        await shouldRequestShortLivedTokens('https://api.github.com'),
        true
      )
      assert.equal(
        await shouldRequestShortLivedTokens('https://ghe.example.com/api/v3'),
        false
      )
    })
  }
})
