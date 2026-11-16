import { describe, it } from 'node:test'
import assert from 'node:assert'
import { CustomLinks } from '../../src/lib/custom-links'
import { ReleaseNotesUri } from '../../src/ui/lib/releases'

describe('CustomLinks', () => {
  it("points the app's project links at this fork", () => {
    const repo = 'https://github.com/Blake-McCullough/desktop'
    assert.equal(ReleaseNotesUri, `${repo}/releases`)
    assert.equal(CustomLinks.newIssue, `${repo}/issues/new`)
    assert.equal(
      CustomLinks.doc('docs/learn-more/unreachable-commits.md'),
      `${repo}/blob/main/docs/learn-more/unreachable-commits.md`
    )
    assert.equal(
      CustomLinks.doc('docs/integrations'),
      `${repo}/tree/main/docs/integrations`
    )
  })
})
