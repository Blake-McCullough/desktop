import { Emitter, Disposable } from 'event-kit'
import { getObject, setObject } from './local-storage'

/**
 * A rule that colors git tags whose name matches a pattern, e.g. tags
 * matching `^Pushed_To_Test` shown in green in the History list.
 */
export interface ITagColorRule {
  readonly id: string
  /** A regular expression (case-insensitive) matched against the tag name. */
  readonly pattern: string
  /** `#rrggbb` color. */
  readonly color: string
}

/** A tag's resolved appearance. */
export interface ITagAppearance {
  readonly background: string
  readonly foreground: string
}

const StorageKey = 'history/tag-color-rules'
const emitter = new Emitter()

let cachedRules: ReadonlyArray<ITagColorRule> | null = null
let compiled: ReadonlyArray<{
  readonly regex: RegExp
  readonly appearance: ITagAppearance
}> | null = null
const matchCache = new Map<string, ITagAppearance | null>()

function isValidRule(rule: unknown): rule is ITagColorRule {
  const r = rule as ITagColorRule | null
  return (
    r !== null &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    typeof r.pattern === 'string' &&
    typeof r.color === 'string' &&
    /^#[0-9a-f]{6}$/i.test(r.color)
  )
}

/** The configured rules, in priority order (first match wins). */
export function getTagColorRules(): ReadonlyArray<ITagColorRule> {
  if (cachedRules === null) {
    const stored = getObject<ReadonlyArray<unknown>>(StorageKey)
    cachedRules = Array.isArray(stored) ? stored.filter(isValidRule) : []
  }
  return cachedRules
}

/** Replace all rules. Blank patterns are dropped. */
export function setTagColorRules(rules: ReadonlyArray<ITagColorRule>) {
  setObject(
    StorageKey,
    rules.filter(r => isValidRule(r) && r.pattern.trim().length > 0)
  )
  invalidate()
}

function invalidate() {
  cachedRules = null
  compiled = null
  matchCache.clear()
  emitter.emit('did-change', null)
}

/** Subscribe to rule changes (from Preferences). */
export function onTagColorRulesChanged(fn: () => void): Disposable {
  return emitter.on('did-change', fn)
}

/** Create a new rule id. */
export function createTagColorRuleId(): string {
  return `tag-rule-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Check a pattern and return the error message if it isn't a valid regular
 * expression, or `null` if it is.
 */
export function getPatternError(pattern: string): string | null {
  try {
    new RegExp(pattern, 'i')
    return null
  } catch (e) {
    return e instanceof Error ? e.message : `${e}`
  }
}

/** Black or white, whichever is more readable on the given color. */
export function getContrastingTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return luminance > 0.4 ? '#1f2328' : '#ffffff'
}

function getCompiled() {
  if (compiled === null) {
    const result = []
    for (const rule of getTagColorRules()) {
      try {
        result.push({
          regex: new RegExp(rule.pattern, 'i'),
          appearance: {
            background: rule.color,
            foreground: getContrastingTextColor(rule.color),
          },
        })
      } catch {
        // Invalid patterns are flagged in Preferences and ignored here.
      }
    }
    compiled = result
  }
  return compiled
}

/** The appearance for a tag, or `null` when no rule matches it. */
export function getTagAppearance(tag: string): ITagAppearance | null {
  const cached = matchCache.get(tag)
  if (cached !== undefined) {
    return cached
  }

  const match = getCompiled().find(c => c.regex.test(tag))
  const appearance = match?.appearance ?? null

  // Bounded: tag names repeat across renders, but don't grow forever.
  if (matchCache.size > 2000) {
    matchCache.clear()
  }
  matchCache.set(tag, appearance)
  return appearance
}
