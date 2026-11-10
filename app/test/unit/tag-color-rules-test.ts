import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import {
  createTagColorRuleId,
  getContrastingTextColor,
  getPatternError,
  getTagAppearance,
  getTagColorRules,
  setTagColorRules,
} from '../../src/lib/tag-color-rules'

describe('tag color rules', () => {
  beforeEach(() => {
    localStorage.clear()
    setTagColorRules([])
  })

  it('colors tags matching a rule, case-insensitively', () => {
    setTagColorRules([
      {
        id: createTagColorRuleId(),
        pattern: '^pushed_to_test',
        color: '#1a7f37',
      },
    ])
    const appearance = getTagAppearance('Pushed_To_Test_2026-11-02T03-54-13Z')
    assert.equal(appearance?.background, '#1a7f37')
    assert.equal(appearance?.foreground, '#ffffff')
    assert.equal(getTagAppearance('v1.2.3'), null)
  })

  it('uses the first matching rule', () => {
    setTagColorRules([
      { id: 'a', pattern: 'Test', color: '#cf222e' },
      { id: 'b', pattern: '^Pushed', color: '#1a7f37' },
    ])
    assert.equal(getTagAppearance('Pushed_To_Test')?.background, '#cf222e')
  })

  it('ignores invalid patterns and drops blank ones on save', () => {
    setTagColorRules([
      { id: 'a', pattern: '(', color: '#cf222e' },
      { id: 'b', pattern: '   ', color: '#cf222e' },
      { id: 'c', pattern: 'ok', color: '#0969da' },
    ])
    assert.equal(getTagColorRules().length, 2)
    assert.equal(getTagAppearance('ok-tag')?.background, '#0969da')
    assert.notEqual(getPatternError('('), null)
    assert.equal(getPatternError('^v\\d+'), null)
  })

  it('picks readable text colors', () => {
    assert.equal(getContrastingTextColor('#ffff00'), '#1f2328')
    assert.equal(getContrastingTextColor('#0969da'), '#ffffff')
  })
})
