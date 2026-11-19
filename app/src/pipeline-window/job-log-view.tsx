import * as React from 'react'
import memoizeOne from 'memoize-one'
import {
  ILogLine,
  ILogMatch,
  ILogSpan,
  IParsedLog,
  MaxLogMatches,
  findLogMatches,
  highlightSpans,
  isLineHidden,
} from '../lib/gitlab/job-log'
import { formatDuration } from '../lib/gitlab/pipeline-details'

interface IJobLogViewProps {
  readonly log: IParsedLog | null
  readonly isLoading: boolean
  /** Whether the job is still running (the log keeps growing). */
  readonly isLive: boolean
  readonly emptyMessage: string
}

interface IJobLogViewState {
  /** Sections the user collapsed or expanded, overriding the default. */
  readonly toggled: ReadonlySet<number>
  /** Keep the newest output in view. Off once the user scrolls up. */
  readonly follow: boolean
  readonly showAll: boolean
  /** The find bar (Ctrl/Cmd+F). */
  readonly searchOpen: boolean
  readonly query: string
  /** Index into the matches of the selected one. */
  readonly currentMatch: number
}

/** A search hit within a line, for highlighting. */
interface ILineRange {
  readonly start: number
  readonly end: number
  readonly current: boolean
}

type LineRanges = ReadonlyMap<number, ReadonlyArray<ILineRange>>

/** Rendering every line of a huge log on each update is slow. */
const VisibleLineLimit = 3000

function spanStyle(span: ILogSpan): React.CSSProperties | undefined {
  if (!span.fg && !span.bg && !span.bold && !span.italic && !span.underline) {
    return undefined
  }
  return {
    color: span.fg,
    backgroundColor: span.bg,
    fontWeight: span.bold ? 600 : undefined,
    fontStyle: span.italic ? 'italic' : undefined,
    textDecoration: span.underline ? 'underline' : undefined,
  }
}

/** A job log, with colours, collapsible sections and live following. */
export class JobLogView extends React.Component<
  IJobLogViewProps,
  IJobLogViewState
> {
  private readonly scrollRef = React.createRef<HTMLDivElement>()
  private readonly toggleHandlers = new Map<number, () => void>()
  private readonly headerClickHandlers = new Map<number, () => void>()
  private readonly caretClickHandlers = new Map<
    number,
    (event: React.MouseEvent<HTMLButtonElement>) => void
  >()
  private readonly searchInputRef = React.createRef<HTMLInputElement>()
  /** Scroll the selected match into view after the next render. */
  private scrollToMatch = false

  private getMatches = memoizeOne((log: IParsedLog | null, query: string) =>
    log === null ? [] : findLogMatches(log, query)
  )

  /** Matches by line number, for highlighting. */
  private getRanges = memoizeOne(
    (
      log: IParsedLog,
      matches: ReadonlyArray<ILogMatch>,
      current: number
    ): LineRanges => {
      const map = new Map<number, Array<ILineRange>>()
      matches.forEach((m, i) => {
        const lineNumber = log.lines[m.lineIndex].number
        const list = map.get(lineNumber) ?? []
        list.push({ start: m.start, end: m.end, current: i === current })
        map.set(lineNumber, list)
      })
      return map
    }
  )

  public constructor(props: IJobLogViewProps) {
    super(props)
    this.state = {
      toggled: new Set(),
      follow: true,
      showAll: false,
      searchOpen: false,
      query: '',
      currentMatch: 0,
    }
  }

  public componentDidMount() {
    this.scrollToEndIfFollowing()
    document.addEventListener('keydown', this.onDocumentKeyDown)
  }

  public componentWillUnmount() {
    document.removeEventListener('keydown', this.onDocumentKeyDown)
  }

  public componentDidUpdate(prevProps: IJobLogViewProps) {
    if (this.scrollToMatch) {
      this.scrollToMatch = false
      this.scrollRef.current
        ?.querySelector('mark.current')
        ?.scrollIntoView({ block: 'center' })
    } else if (prevProps.log !== this.props.log) {
      this.scrollToEndIfFollowing()
    }
  }

  /** Open the find bar (Ctrl/Cmd+F, or the Find button). */
  public openSearch() {
    this.setState({ searchOpen: true }, () => {
      this.searchInputRef.current?.focus()
      this.searchInputRef.current?.select()
    })
  }

  private closeSearch = () => {
    this.setState({ searchOpen: false, query: '', currentMatch: 0 })
  }

  private onQueryChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    const query = event.currentTarget.value
    this.setState({ query, currentMatch: 0 }, () => this.goToMatch(0))
  }

  private onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      this.step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.closeSearch()
    }
  }

  private onNextMatch = () => this.step(1)
  private onPreviousMatch = () => this.step(-1)

  private step(delta: number) {
    const count = this.getMatches(this.props.log, this.state.query).length
    if (count === 0) {
      return
    }
    this.goToMatch((this.state.currentMatch + delta + count) % count)
  }

  /**
   * Select a match: unfold the sections it's in, make sure its line is
   * rendered, stop following the tail, and scroll to it.
   */
  private goToMatch(index: number) {
    const { log } = this.props
    const match = this.getMatches(log, this.state.query)[index]
    if (log === null || match === undefined) {
      return
    }
    const line = log.lines[match.lineIndex]
    const toggled = new Set(this.state.toggled)
    let id = line.sectionId
    while (id !== null) {
      const section = log.sections.get(id)
      if (section === undefined) {
        break
      }
      // A line's own section header is always visible; its parents aren't.
      if (line.startsSection !== id) {
        if (section.collapsedByDefault) {
          toggled.add(id)
        } else {
          toggled.delete(id)
        }
      }
      id = section.parentId
    }
    this.scrollToMatch = true
    this.setState({
      currentMatch: index,
      toggled,
      follow: false,
      showAll: true,
    })
  }

  private scrollToEndIfFollowing() {
    const el = this.scrollRef.current
    if (el !== null && this.state.follow) {
      el.scrollTop = el.scrollHeight
    }
  }

  private onScroll = () => {
    const el = this.scrollRef.current
    if (el === null) {
      return
    }
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
    if (atEnd !== this.state.follow) {
      this.setState({ follow: atEnd })
    }
  }

  private onJumpToEnd = () => {
    this.setState({ follow: true }, () => this.scrollToEndIfFollowing())
  }

  private onShowAll = () => {
    this.setState({ showAll: true })
  }

  /**
   * Clicking a section's header line folds it, unless you were selecting
   * text in it.
   */
  private getHeaderClick(id: number) {
    let handler = this.headerClickHandlers.get(id)
    if (handler === undefined) {
      const toggle = this.getToggle(id)
      handler = () => {
        const selection = window.getSelection()
        if (selection === null || selection.isCollapsed) {
          toggle()
        }
      }
      this.headerClickHandlers.set(id, handler)
    }
    return handler
  }

  /**
   * The fold button sits inside the header line, which folds on click too:
   * stop the click reaching it, or the section would fold and unfold.
   */
  private getCaretClick(id: number) {
    let handler = this.caretClickHandlers.get(id)
    if (handler === undefined) {
      const toggle = this.getToggle(id)
      handler = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        toggle()
      }
      this.caretClickHandlers.set(id, handler)
    }
    return handler
  }

  /**
   * Ctrl/Cmd+A after clicking in the log selects the log, not the whole
   * window.
   */
  private onDocumentKeyDown = (event: KeyboardEvent) => {
    const mod = __DARWIN__ ? event.metaKey : event.ctrlKey
    if (mod && !event.altKey && !event.shiftKey && event.key === 'f') {
      event.preventDefault()
      this.openSearch()
      return
    }
    if (event.key === 'F3' && this.state.searchOpen) {
      event.preventDefault()
      this.step(event.shiftKey ? -1 : 1)
      return
    }
    if (!mod || event.altKey || event.shiftKey || event.key !== 'a') {
      return
    }
    const el = this.scrollRef.current
    const selection = window.getSelection()
    const target = event.target
    const inLog =
      el !== null &&
      ((selection?.anchorNode != null && el.contains(selection.anchorNode)) ||
        (target instanceof Node && el.contains(target)))
    if (inLog && el !== null && selection !== null) {
      event.preventDefault()
      const range = document.createRange()
      range.selectNodeContents(el)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }

  private getToggle(id: number) {
    let handler = this.toggleHandlers.get(id)
    if (handler === undefined) {
      handler = () =>
        this.setState(prev => {
          const toggled = new Set(prev.toggled)
          if (toggled.has(id)) {
            toggled.delete(id)
          } else {
            toggled.add(id)
          }
          return { toggled }
        })
      this.toggleHandlers.set(id, handler)
    }
    return handler
  }

  private getCollapsed(log: IParsedLog): ReadonlySet<number> {
    const collapsed = new Set<number>()
    for (const section of log.sections.values()) {
      const toggled = this.state.toggled.has(section.id)
      if (section.collapsedByDefault !== toggled) {
        collapsed.add(section.id)
      }
    }
    return collapsed
  }

  public render() {
    const { log } = this.props
    if (log === null || log.lines.length === 0) {
      return (
        <div className="job-log empty">
          {this.props.isLoading ? 'Loading log…' : this.props.emptyMessage}
        </div>
      )
    }

    const collapsed = this.getCollapsed(log)
    const matches = this.state.searchOpen
      ? this.getMatches(log, this.state.query)
      : []
    const ranges = this.getRanges(log, matches, this.state.currentMatch)
    const visible = log.lines.filter(
      l => !isLineHidden(l, log.sections, collapsed)
    )
    const hidden =
      this.state.showAll || visible.length <= VisibleLineLimit
        ? 0
        : visible.length - VisibleLineLimit
    const shown = hidden > 0 ? visible.slice(hidden) : visible

    return (
      <div className="job-log-container">
        {this.state.searchOpen && this.renderSearchBar(matches)}
        <div
          className="job-log"
          ref={this.scrollRef}
          onScroll={this.onScroll}
          role="log"
          aria-live={this.props.isLive ? 'polite' : 'off'}
        >
          {(hidden > 0 || log.truncatedLines > 0) && (
            <div className="job-log-notice">
              {hidden > 0 ? (
                <>
                  {`${hidden.toLocaleString()} earlier lines hidden. `}
                  <button type="button" onClick={this.onShowAll}>
                    Show all
                  </button>
                </>
              ) : (
                `The first ${log.truncatedLines.toLocaleString()} lines are only in the full log on GitLab.`
              )}
            </div>
          )}
          {shown.map(line =>
            this.renderLine(line, log, collapsed, ranges.get(line.number))
          )}
          {this.props.isLive && (
            <div className="job-log-live" aria-hidden={true}>
              <span className="job-log-cursor" />
            </div>
          )}
        </div>
        {!this.state.follow && (
          <button
            type="button"
            className="job-log-jump"
            onClick={this.onJumpToEnd}
          >
            ↓ Jump to latest
          </button>
        )}
      </div>
    )
  }

  private renderSearchBar(matches: ReadonlyArray<ILogMatch>) {
    const { query, currentMatch } = this.state
    const count = matches.length
    const status =
      query.length === 0
        ? ''
        : count === 0
        ? 'No matches'
        : `${(currentMatch + 1).toLocaleString()} of ${count.toLocaleString()}${
            count >= MaxLogMatches ? '+' : ''
          }`
    return (
      <div className="job-log-search" role="search">
        <input
          ref={this.searchInputRef}
          type="text"
          placeholder="Find in log"
          aria-label="Find in log"
          value={query}
          onChange={this.onQueryChanged}
          onKeyDown={this.onSearchKeyDown}
          spellCheck={false}
        />
        <span
          className={`job-log-search-count${
            query.length > 0 && count === 0 ? ' none' : ''
          }`}
          aria-live="polite"
        >
          {status}
        </span>
        <button
          type="button"
          onClick={this.onPreviousMatch}
          disabled={count === 0}
          aria-label="Previous match (Shift+Enter)"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={this.onNextMatch}
          disabled={count === 0}
          aria-label="Next match (Enter)"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={this.closeSearch}
          aria-label="Close find (Escape)"
        >
          ✕
        </button>
      </div>
    )
  }

  private renderLine(
    line: ILogLine,
    log: IParsedLog,
    collapsed: ReadonlySet<number>,
    ranges: ReadonlyArray<ILineRange> | undefined
  ) {
    const content = highlightSpans(line.spans, ranges ?? []).map((span, i) =>
      span.mark === null ? (
        <span key={i} style={spanStyle(span)}>
          {span.text}
        </span>
      ) : (
        <mark key={i} className={span.mark} style={spanStyle(span)}>
          {span.text}
        </mark>
      )
    )

    if (line.startsSection !== null) {
      const section = log.sections.get(line.startsSection)
      const isCollapsed = collapsed.has(line.startsSection)
      // A plain line (so its text can be selected) with a fold button; the
      // caret button is the keyboard-accessible way to fold.
      return (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          key={line.number}
          className="job-log-line section-header"
          onClick={this.getHeaderClick(line.startsSection)}
        >
          <span className="job-log-number">{line.number}</span>
          <button
            type="button"
            className="job-log-caret"
            onClick={this.getCaretClick(line.startsSection)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${
              section?.name ?? 'section'
            }`}
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
          <span className="job-log-text">{content}</span>
          {section?.duration != null && (
            <span className="job-log-duration">
              {formatDuration(section.duration)}
            </span>
          )}
        </div>
      )
    }

    return (
      <div key={line.number} className="job-log-line">
        <span className="job-log-number">{line.number}</span>
        <span className="job-log-text">{content}</span>
      </div>
    )
  }
}
