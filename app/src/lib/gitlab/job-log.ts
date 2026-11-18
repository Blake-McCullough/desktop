/**
 * Parsing GitLab job logs (traces): ANSI colours and styles, collapsible
 * sections (`section_start:<time>:<name>` … `section_end:<time>:<name>`), and
 * carriage-return progress output.
 */

export interface ILogSpan {
  readonly text: string
  /** A CSS colour, or undefined for the default. */
  readonly fg?: string
  readonly bg?: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
}

export interface ILogLine {
  /** 1-based line number, as GitLab shows it. */
  readonly number: number
  readonly spans: ReadonlyArray<ILogSpan>
  /** The innermost section this line is in, if any. */
  readonly sectionId: number | null
  /** Set on the line that starts a section (its header). */
  readonly startsSection: number | null
}

export interface ILogSection {
  readonly id: number
  readonly name: string
  /** Enclosing section, for nested sections. */
  readonly parentId: number | null
  readonly collapsedByDefault: boolean
  /** Seconds between section_start and section_end, when both are known. */
  readonly duration: number | null
}

export interface IParsedLog {
  readonly lines: ReadonlyArray<ILogLine>
  readonly sections: ReadonlyMap<number, ILogSection>
  /** Lines dropped from the start because the log was very long. */
  readonly truncatedLines: number
}

// The 16 standard colours, close to GitLab's log palette.
const Palette = [
  '#000000',
  '#e5534b',
  '#57ab5a',
  '#c69026',
  '#539bf5',
  '#b083f0',
  '#39c5cf',
  '#d1d5da',
  '#636e7b',
  '#ff938a',
  '#6bc46d',
  '#daaa3f',
  '#6cb6ff',
  '#dcbdfb',
  '#56d4dd',
  '#ffffff',
]

function color256(n: number): string | undefined {
  if (n < 0 || n > 255) {
    return undefined
  }
  if (n < 16) {
    return Palette[n]
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40)
  return `rgb(${level(Math.floor(i / 36))},${level(
    Math.floor(i / 6) % 6
  )},${level(i % 6)})`
}

interface IStyle {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

function applySgr(style: IStyle, params: ReadonlyArray<number>): IStyle {
  const next: IStyle = { ...style }
  const codes = params.length === 0 ? [0] : params
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) {
      delete next.fg
      delete next.bg
      delete next.bold
      delete next.italic
      delete next.underline
    } else if (c === 1) {
      next.bold = true
    } else if (c === 22) {
      delete next.bold
    } else if (c === 3) {
      next.italic = true
    } else if (c === 23) {
      delete next.italic
    } else if (c === 4) {
      next.underline = true
    } else if (c === 24) {
      delete next.underline
    } else if (c >= 30 && c <= 37) {
      next.fg = Palette[c - 30]
    } else if (c >= 90 && c <= 97) {
      next.fg = Palette[c - 90 + 8]
    } else if (c === 39) {
      delete next.fg
    } else if (c >= 40 && c <= 47) {
      next.bg = Palette[c - 40]
    } else if (c >= 100 && c <= 107) {
      next.bg = Palette[c - 100 + 8]
    } else if (c === 49) {
      delete next.bg
    } else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
      const value = color256(codes[i + 2] ?? -1)
      if (c === 38) {
        next.fg = value
      } else {
        next.bg = value
      }
      i += 2
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
      const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]]
      const value = [r, g, b].every(x => x !== undefined && x >= 0 && x <= 255)
        ? `rgb(${r},${g},${b})`
        : undefined
      if (c === 38) {
        next.fg = value
      } else {
        next.bg = value
      }
      i += 4
    }
  }
  return next
}

// eslint-disable-next-line no-control-regex
const EscapePattern = /\x1b\[([0-9;?]*)([A-Za-z])/g
const SectionPattern =
  // eslint-disable-next-line no-control-regex
  /section_(start|end):(\d+):([A-Za-z0-9_.\-]+)(\[[^\]]*\])?\r?(?:\x1b\[0K)?/g

/** Turn one physical line (no newline) into styled spans. */
function toSpans(
  text: string,
  style: IStyle
): { spans: ILogSpan[]; style: IStyle } {
  // Progress output redraws the line with \r: show what it ended up as.
  const pieces = text.split('\r')
  let visible = pieces[pieces.length - 1]
  if (visible.length === 0 && pieces.length > 1) {
    visible = pieces.filter(p => p.length > 0).pop() ?? ''
  }

  const spans: ILogSpan[] = []
  let current = style
  let last = 0
  EscapePattern.lastIndex = 0
  let match: RegExpExecArray | null
  const push = (t: string) => {
    if (t.length > 0) {
      spans.push({ text: t, ...current })
    }
  }
  while ((match = EscapePattern.exec(visible)) !== null) {
    push(visible.slice(last, match.index))
    if (match[2] === 'm') {
      const params = match[1]
        .split(';')
        .filter(p => p.length > 0)
        .map(p => parseInt(p, 10))
        .filter(n => !isNaN(n))
      current = applySgr(current, params)
    }
    last = match.index + match[0].length
  }
  push(visible.slice(last))
  return { spans, style: current }
}

/** Long logs keep only their end, like GitLab's own viewer. */
const MaxLines = 20000

/** Parse a job log into lines and collapsible sections. */
export function parseJobLog(log: string): IParsedLog {
  const physical = log.replace(/\r\n/g, '\n').split('\n')
  if (physical.length > 0 && physical[physical.length - 1] === '') {
    physical.pop()
  }

  const lines: ILogLine[] = []
  const sections = new Map<number, ILogSection>()
  const open: Array<{ id: number; name: string; start: number }> = []
  const durations = new Map<number, number>()
  let nextSectionId = 1
  let style: IStyle = {}

  for (const raw of physical) {
    let startsSection: number | null = null
    let text = raw

    SectionPattern.lastIndex = 0
    let match: RegExpExecArray | null
    let cleaned = ''
    let last = 0
    while ((match = SectionPattern.exec(raw)) !== null) {
      cleaned += raw.slice(last, match.index)
      last = match.index + match[0].length
      const [, kind, time, name, options] = match
      if (kind === 'start') {
        const id = nextSectionId++
        sections.set(id, {
          id,
          name,
          parentId: open.length > 0 ? open[open.length - 1].id : null,
          collapsedByDefault: /collapsed=true/.test(options ?? ''),
          duration: null,
        })
        open.push({ id, name, start: parseInt(time, 10) })
        startsSection = id
      } else {
        const index = open.map(o => o.name).lastIndexOf(name)
        if (index >= 0) {
          const section = open[index]
          durations.set(section.id, parseInt(time, 10) - section.start)
          open.splice(index)
        }
      }
    }
    text = cleaned + raw.slice(last)

    const result = toSpans(text, style)
    style = result.style

    // A line that only closed sections has nothing left to show.
    if (result.spans.length === 0 && startsSection === null && last > 0) {
      continue
    }

    const sectionId =
      startsSection !== null
        ? sections.get(startsSection)!.parentId
        : open.length > 0
        ? open[open.length - 1].id
        : null

    lines.push({
      number: lines.length + 1,
      spans: result.spans,
      sectionId,
      startsSection,
    })
  }

  for (const [id, duration] of durations) {
    const section = sections.get(id)
    if (section !== undefined) {
      sections.set(id, { ...section, duration })
    }
  }

  const truncatedLines = Math.max(0, lines.length - MaxLines)
  return {
    lines: truncatedLines > 0 ? lines.slice(truncatedLines) : lines,
    sections,
    truncatedLines,
  }
}

/**
 * Whether a line is hidden because it's inside a collapsed section (or a
 * section nested in one). Section headers stay visible within their parent.
 */
export function isLineHidden(
  line: ILogLine,
  sections: ReadonlyMap<number, ILogSection>,
  collapsed: ReadonlySet<number>
): boolean {
  let id = line.sectionId
  while (id !== null) {
    if (collapsed.has(id)) {
      return true
    }
    id = sections.get(id)?.parentId ?? null
  }
  return false
}

/** The plain text of a line, without styling (for copying and searching). */
export function lineText(line: ILogLine): string {
  return line.spans.map(s => s.text).join('')
}
