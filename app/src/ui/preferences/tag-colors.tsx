import * as React from 'react'
import { DialogContent } from '../dialog'
import { Button } from '../lib/button'
import { TextBox } from '../lib/text-box'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import {
  ITagColorRule,
  createTagColorRuleId,
  getContrastingTextColor,
  getPatternError,
} from '../../lib/tag-color-rules'

interface ITagColorsProps {
  readonly rules: ReadonlyArray<ITagColorRule>
  readonly onRulesChanged: (rules: ReadonlyArray<ITagColorRule>) => void
}

interface ITagColorsState {
  readonly sampleTag: string
}

const Presets: ReadonlyArray<{
  label: string
  pattern: string
  color: string
}> = [
  { label: 'Test', pattern: '^Pushed_To_Test', color: '#1a7f37' },
  { label: 'Prod', pattern: '^Pushed_To_Prod', color: '#cf222e' },
  { label: 'Versions', pattern: '^v?\\d+\\.\\d+', color: '#0969da' },
]

/** Preview a tag the way the History list will show it. */
export function TagPreview(props: {
  readonly name: string
  readonly color: string | null
}) {
  const style: React.CSSProperties | undefined =
    props.color !== null
      ? {
          backgroundColor: props.color,
          color: getContrastingTextColor(props.color),
          borderColor: props.color,
        }
      : undefined

  return (
    <span
      className={`tag-color-preview ${props.color ? 'colored' : ''}`}
      style={style}
    >
      <Octicon symbol={octicons.tag} />
      {props.name}
    </span>
  )
}

/**
 * Preferences tab for coloring tags in the History list by pattern, so
 * tags like `Pushed_To_Test_2026-11-02T03-54-13Z` stand out.
 */
export class TagColors extends React.Component<
  ITagColorsProps,
  ITagColorsState
> {
  private patternHandlers = new Map<number, (value: string) => void>()
  private handlers = new Map<string, () => void>()

  public constructor(props: ITagColorsProps) {
    super(props)
    this.state = { sampleTag: 'Pushed_To_Test_2026-11-02T03-54-13Z' }
  }

  private update(index: number, change: Partial<ITagColorRule>) {
    const rules = [...this.props.rules]
    rules[index] = { ...rules[index], ...change }
    this.props.onRulesChanged(rules)
  }

  private onPatternChanged = (value: string, index: number) =>
    this.update(index, { pattern: value })

  private onColorChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    const index = Number(event.currentTarget.dataset.index)
    this.update(index, { color: event.currentTarget.value })
  }

  private onRemove = (index: number) => {
    this.props.onRulesChanged(this.props.rules.filter((_, i) => i !== index))
  }

  private onMove = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= this.props.rules.length) {
      return
    }
    const rules = [...this.props.rules]
    ;[rules[index], rules[target]] = [rules[target], rules[index]]
    this.props.onRulesChanged(rules)
  }

  private onAdd = () => {
    this.props.onRulesChanged([
      ...this.props.rules,
      { id: createTagColorRuleId(), pattern: '', color: '#1a7f37' },
    ])
  }

  private onAddPreset = (presetIndex: number) => {
    const preset = Presets[presetIndex]
    this.props.onRulesChanged([
      ...this.props.rules,
      {
        id: createTagColorRuleId(),
        pattern: preset.pattern,
        color: preset.color,
      },
    ])
  }

  private onSampleChanged = (sampleTag: string) => this.setState({ sampleTag })

  private getSampleColor(): string | null {
    for (const rule of this.props.rules) {
      if (rule.pattern.trim().length === 0 || getPatternError(rule.pattern)) {
        continue
      }
      if (new RegExp(rule.pattern, 'i').test(this.state.sampleTag)) {
        return rule.color
      }
    }
    return null
  }

  private renderRule = (rule: ITagColorRule, index: number) => {
    const error =
      rule.pattern.trim().length > 0 ? getPatternError(rule.pattern) : null
    const count = this.props.rules.length

    return (
      <li key={rule.id} className="tag-color-rule">
        <div className="rule-row">
          <TextBox
            className="pattern"
            value={rule.pattern}
            placeholder="Regular expression, e.g. ^Pushed_To_Test"
            ariaLabel={`Pattern for rule ${index + 1}`}
            onValueChanged={this.makePatternHandler(index)}
            spellcheck={false}
          />
          <input
            type="color"
            className="color"
            value={rule.color}
            data-index={index}
            onChange={this.onColorChanged}
            aria-label={`Color for rule ${index + 1}`}
          />
          <Button
            className="icon-button"
            onClick={this.handler(`up-${index}`, () => this.onMove(index, -1))}
            disabled={index === 0}
            ariaLabel="Move rule up"
            tooltip="Higher priority"
          >
            <Octicon symbol={octicons.arrowUp} />
          </Button>
          <Button
            className="icon-button"
            onClick={this.handler(`down-${index}`, () => this.onMove(index, 1))}
            disabled={index === count - 1}
            ariaLabel="Move rule down"
            tooltip="Lower priority"
          >
            <Octicon symbol={octicons.arrowDown} />
          </Button>
          <Button
            className="icon-button"
            onClick={this.handler(`remove-${index}`, () =>
              this.onRemove(index)
            )}
            ariaLabel="Remove rule"
            tooltip="Remove"
          >
            <Octicon symbol={octicons.trash} />
          </Button>
        </div>
        {error !== null && <div className="rule-error">{error}</div>}
      </li>
    )
  }

  /**
   * A stable callback per key, so rows don't get new function props on
   * every render. Handlers read the current props when invoked.
   */
  private handler(key: string, fn: () => void) {
    let handler = this.handlers.get(key)
    if (handler === undefined) {
      handler = () => fn()
      this.handlers.set(key, handler)
    }
    return handler
  }

  private makePatternHandler(index: number) {
    let handler = this.patternHandlers.get(index)
    if (handler === undefined) {
      handler = (value: string) => this.onPatternChanged(value, index)
      this.patternHandlers.set(index, handler)
    }
    return handler
  }

  public render() {
    const { rules } = this.props

    return (
      <DialogContent>
        <div className="advanced-section tag-colors">
          <h2>Tag colors</h2>
          <div className="settings-description">
            <p>
              Tags in History whose name matches a pattern get that color.
              Patterns are case-insensitive regular expressions; the first
              matching rule wins.
            </p>
          </div>

          {rules.length === 0 ? (
            <p className="no-rules">No rules yet.</p>
          ) : (
            <ul className="tag-color-rules">{rules.map(this.renderRule)}</ul>
          )}

          <div className="tag-color-actions">
            <Button onClick={this.onAdd}>
              <Octicon symbol={octicons.plus} />
              Add rule
            </Button>
            <span className="presets-label">Quick add:</span>
            {Presets.map((preset, i) => (
              <Button
                key={preset.label}
                className="preset"
                onClick={this.handler(`preset-${i}`, () => this.onAddPreset(i))}
              >
                <span
                  className="preset-swatch"
                  style={{ backgroundColor: preset.color }}
                />
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="advanced-section">
          <h2>Try it</h2>
          <TextBox
            label="Tag name"
            value={this.state.sampleTag}
            onValueChanged={this.onSampleChanged}
            spellcheck={false}
          />
          <div className="tag-color-sample">
            <TagPreview
              name={this.state.sampleTag || 'tag'}
              color={this.getSampleColor()}
            />
          </div>
        </div>
      </DialogContent>
    )
  }
}
