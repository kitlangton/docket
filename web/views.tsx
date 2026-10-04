import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  sizeOf,
  type Confidence,
  itemId,
  itemLabel,
  type ItemLoad,
  type Manifest,
  type ManifestGroup,
  type Note,
  type PrReview,
  type ReviewState,
  type Verdict,
} from "../src/types"
import { ClampedMarkdown, Markdown, markdownSummary } from "./markdown"
import { displayKeys, helpRows } from "./keymap"
import { countVerdicts, displayTitle, fuzzyScore, middleTruncate, noteCount, noteLocation, type Entry } from "./model"

const VERDICT_LABEL: Record<Verdict, string> = { approve: "Approved", reject: "Rejected", skip: "Skipped" }
const STATE_LABEL = { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed", LOCAL: "Local" }

/** Verdict glyph drawn on a 14px grid so it stays crisp at any zoom. */
export function Glyph(props: { verdict: Verdict | null | undefined; stamp?: boolean; stale?: boolean }) {
  const className = `glyph${props.verdict ? ` is-${props.verdict}` : ""}${props.stamp ? " is-stamp" : ""}${props.stale ? " is-stale" : ""}`
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      {props.verdict === "approve" ? <path d="M3.5 7.4l2.3 2.3 4.7-5" /> : null}
      {props.verdict === "reject" ? <path d="M4.2 4.2l5.6 5.6M9.8 4.2l-5.6 5.6" /> : null}
      {props.verdict === "skip" ? <path d="M4 7h6M7.6 4.6L10 7l-2.4 2.4" /> : null}
      {!props.verdict ? <circle cx="7" cy="7" r="3.6" /> : null}
    </svg>
  )
}

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "High", medium: "Medium", low: "Low" }
const CONFIDENCE_BARS: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }

/** Three ascending bars, filled to the agent's confidence; deliberately unlike the round verdict glyphs. */
function ConfidenceMeter(props: { confidence: Confidence }) {
  const filled = CONFIDENCE_BARS[props.confidence]
  return (
    <svg
      className={`meter-bars is-${props.confidence}`}
      width="11"
      height="10"
      viewBox="0 0 11 10"
      aria-label={`${CONFIDENCE_LABEL[props.confidence]} confidence`}
    >
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={index * 4}
          y={6 - index * 3}
          width="3"
          height={4 + index * 3}
          rx="0.8"
          className={index < filled ? "on" : undefined}
        />
      ))}
    </svg>
  )
}

/** "High · S": the agent's confidence and docket's computed size, either of which may be missing. */
function Assessment(props: { confidence?: Confidence; load: ItemLoad | undefined }) {
  const size = props.load?.ok ? sizeOf(props.load.data.meta) : undefined
  if (!props.confidence && !size) return null
  return (
    <span
      className="assessment"
      title={props.confidence ? `${CONFIDENCE_LABEL[props.confidence]} confidence${size ? ` · size ${size}` : ""}` : `Size ${size}`}
    >
      {props.confidence ? (
        <span className={`assessment-confidence is-${props.confidence}`}>
          <ConfidenceMeter confidence={props.confidence} />
        </span>
      ) : null}
      {size ? <span className="assessment-size">{size}</span> : null}
    </span>
  )
}

function Keys(props: { children: string }) {
  return (
    <span className="keys">
      {props.children.split(" ").map((key, index) => (
        <kbd key={index}>{key}</kbd>
      ))}
    </span>
  )
}

function Skeleton(props: { width: number | string; height?: number }) {
  return <span className="skeleton" style={{ width: props.width, height: props.height ?? 10 }} />
}

function groupProgress(group: ManifestGroup, state: ReviewState) {
  const ids = group.prs.map(itemId)
  return { done: ids.filter((id) => state.reviews[id]?.verdict).length, total: ids.length }
}

export const Rail = memo(function Rail(props: {
  manifest: Manifest
  items: Record<string, ItemLoad>
  state: ReviewState
  current: string
  stamped: string | null
  /** PRs with commits since their review. */
  updated: Set<string>
  /** The current PR's file tree, shown in place of the PR list. */
  tree?: ReactNode
  onSelect: (id: string) => void
  onHome: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.querySelector(".rail-pr.is-current")?.scrollIntoView({ block: "nearest" })
  }, [props.current])
  const ids = props.manifest.groups.flatMap((group) => group.prs.map(itemId))
  const done = ids.filter((id) => props.state.reviews[id]?.verdict).length
  const loading = ids.filter((id) => !props.items[id]).length
  return (
    <nav className="rail" ref={ref}>
      <div className="rail-head">
        <button className="rail-home" onMouseDown={(event) => event.preventDefault()} onClick={props.onHome} title="Inbox (g h)">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M7.5 2.5L4 6l3.5 3.5" />
          </svg>
          Inbox
        </button>
        <div className="rail-title" title={props.manifest.summary ?? props.manifest.title}>
          {props.manifest.title}
        </div>
        <div className="rail-progress">
          <span className="meter">
            <span style={{ width: `${(done / Math.max(1, ids.length)) * 100}%` }} />
          </span>
          <span className="tabular">{loading ? `Loading ${ids.length - loading}/${ids.length}` : `${done}/${ids.length}`}</span>
        </div>
      </div>
      {props.tree ??
        props.manifest.groups.map((group) => {
          const progress = groupProgress(group, props.state)
          const isCurrentGroup = group.prs.some((pr) => itemId(pr) === props.current)
          const single = props.manifest.groups.length === 1
          return (
            <section className={`rail-group${isCurrentGroup ? " is-current" : ""}`} key={group.title}>
              {single ? null : (
                <div className="rail-group-head" title={group.why}>
                  <span className="rail-group-title">{group.title}</span>
                  <span className={`rail-group-count tabular${progress.done === progress.total ? " is-done" : ""}`}>
                    {progress.done}/{progress.total}
                  </span>
                </div>
              )}
              {group.prs.map((pr) => {
                const id = itemId(pr)
                const load = props.items[id]
                const review = props.state.reviews[id]
                const notes = noteCount(review)
                const title = load?.ok ? itemTitle(load.data.meta) : load ? "Failed to load" : null
                return (
                  <button
                    key={id}
                    className={`rail-pr${id === props.current ? " is-current" : ""}${review?.verdict ? " is-done" : ""}`}
                    title={pr.after?.length ? `${title ?? ""}\nAfter ${pr.after.map((n) => `#${n}`).join(", ")}` : (title ?? "")}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => props.onSelect(id)}
                  >
                    <Glyph verdict={review?.verdict} stamp={props.stamped === id} stale={props.updated.has(id)} />
                    <span className="rail-pr-title">{title ?? <Skeleton width="70%" />}</span>
                    {props.updated.has(id) ? <span className="updated-dot" title="New commits since your review" /> : null}
                    {notes ? <span className="rail-notes tabular">{notes}</span> : null}
                    {pr.confidence ? <ConfidenceMeter confidence={pr.confidence} /> : null}
                    {load?.ok ? <span className="rail-size">{sizeOf(load.data.meta)}</span> : null}
                    <span className="rail-num tabular">{pr.number ?? ""}</span>
                  </button>
                )
              })}
            </section>
          )
        })}
    </nav>
  )
})

/**
 * The PR header: one sticky band. On the header cursor it expands in place to show the full description,
 * risk, and stack; otherwise it is a single line whose hover popover carries the same details.
 */
export function PrHeader(props: {
  entry: Entry
  load: ItemLoad | undefined
  review: PrReview | undefined
  state: ReviewState
  viewed: { done: number; total: number } | null
  expanded: boolean
  updated: boolean
}) {
  const meta = props.load?.ok ? props.load.data.meta : undefined
  const pr = props.entry.pr
  const title = meta ? itemTitle(meta) : null
  const body = meta?.body.trim() ?? ""
  const summary = useMemo(() => markdownSummary(pr.why || body), [pr.why, body])
  const label = itemLabel(pr)
  const details = (
    <>
      {pr.why ? <Markdown source={pr.why} className="pr-why" /> : null}
      {pr.risk ? (
        <div className="pr-risk">
          <span>Risk</span>
          <Markdown source={pr.risk} />
        </div>
      ) : null}
      {body ? <ClampedMarkdown source={body} className="pr-body" /> : null}
      {props.review?.reason ? (
        <p className="pr-risk is-reject">
          <span>Rejected</span>
          {props.review.reason}
        </p>
      ) : null}
      {pr.after?.length ? (
        <p className="pr-after">
          {pr.after.map((number) => (
            <span key={number} className="after">
              After #{number}
              <Glyph verdict={props.state.reviews[number]?.verdict} />
            </span>
          ))}
        </p>
      ) : null}
    </>
  )
  return (
    <header className={`pr-band${props.expanded ? " is-expanded" : ""}`}>
      <div className="pr-line">
        <span className="pr-num" title={label.length > 22 ? label : undefined}>
          {middleTruncate(label)}
        </span>
        <span className="pr-text">
          <span className={`pr-title${meta?.titleIsRef ? " is-ref" : ""}`} title={title ?? undefined}>
            {title ?? <Skeleton width={360} height={12} />}
          </span>
          {props.review?.verdict ? (
            <span className={`verdict-chip is-${props.review.verdict}${props.updated ? " is-stale" : ""}`}>
              <Glyph verdict={props.review.verdict} />
              {VERDICT_LABEL[props.review.verdict]}
            </span>
          ) : null}
          {props.updated ? <span className="pr-updated">updated</span> : null}
          {summary && !props.expanded ? <span className="pr-desc">{summary}</span> : null}
          {pr.risk && !props.expanded ? <span className="pr-risk-mark">Risk</span> : null}
          {props.expanded ? null : <div className="pr-popover">{details}</div>}
        </span>
        <Assessment confidence={pr.confidence} load={props.load} />
        {meta ? (
          <span className="pr-counts tabular">
            {meta.commits && meta.commits > 1 ? <span>{meta.commits} commits</span> : null}
            <span>{`${meta.changedFiles} file${meta.changedFiles === 1 ? "" : "s"}`}</span>
            {meta.additions ? <span className="add">+{meta.additions}</span> : null}
            {meta.deletions ? <span className="del">−{meta.deletions}</span> : null}
            {props.viewed ? (
              <span className={props.viewed.done === props.viewed.total ? "is-all-viewed" : undefined}>
                {props.viewed.done}/{props.viewed.total} viewed
              </span>
            ) : null}
            {meta.state !== "OPEN" ? <span>{STATE_LABEL[meta.state]}</span> : null}
            {meta.url ? (
              <a className="pr-link" href={meta.url} target="_blank" rel="noreferrer" title="Open on GitHub">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <path d="M4 2.5h5.5V8M9.5 2.5L3 9" />
                </svg>
              </a>
            ) : null}
          </span>
        ) : (
          <Skeleton width={140} />
        )}
      </div>
      <div className="pr-more" aria-hidden={!props.expanded}>
        <div className="pr-more-inner">{details}</div>
      </div>
    </header>
  )
}

/** A PR or commit title for display: conventional prefixes are tidied, git refs are left exactly as they are. */
function itemTitle(meta: { title: string; titleIsRef?: boolean }) {
  if (meta.titleIsRef) return meta.title
  return displayTitle(meta.title)
}

export function PrNotes(props: { notes: Note[]; focus: number | null; onEdit: (note: Note) => void; onDelete: (id: string) => void }) {
  if (!props.notes.length) return null
  return (
    <ul className="pr-notes">
      {props.notes.map((note, index) => (
        <li key={note.id} className={`pr-note${props.focus === index ? " is-focus" : ""}`}>
          <span className="pr-note-body" onClick={() => props.onEdit(note)}>
            {note.body}
          </span>
          <span className="pr-note-actions">
            <button onClick={() => props.onEdit(note)}>Edit</button>
            <button onClick={() => props.onDelete(note.id)}>Delete</button>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Closes a PR: where the eye lands after the last hunk, with the verdict keys right there. */
export function VerdictPrompt(props: {
  label: string
  verdict: Verdict | null | undefined
  /** New commits since the verdict: it stands until re-confirmed. */
  stale: boolean
  onDecide: (verdict: Verdict) => void
}) {
  const verdict = props.verdict
  const stale = Boolean(verdict && props.stale)
  return (
    <div className={`verdict-prompt${verdict ? ` is-decided is-${verdict}` : ""}${stale ? " is-stale" : ""}`}>
      {verdict ? (
        <>
          <Glyph verdict={verdict} stale={stale} />
          <span>
            {VERDICT_LABEL[verdict]} {props.label}
          </span>
        </>
      ) : null}
      {stale ? <span className="pr-updated">updated</span> : null}
      {!verdict || stale ? (
        <>
          <span className="spacer" />
          <VerdictButton verdict="approve" k="a" label="Approve" onDecide={props.onDecide} />
          <VerdictButton verdict="reject" k="r" label="Reject" onDecide={props.onDecide} />
          <VerdictButton verdict="skip" k="s" label="Skip" onDecide={props.onDecide} />
        </>
      ) : null}
    </div>
  )
}

function VerdictButton(props: { verdict: Verdict; k: string; label: string; onDecide: (verdict: Verdict) => void }) {
  return (
    <button
      className={`verdict-button is-${props.verdict}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onDecide(props.verdict)}
    >
      <Glyph verdict={props.verdict} />
      {props.label}
      <kbd>{props.k}</kbd>
    </button>
  )
}

export function PrSkeleton() {
  return (
    <div className="pr-skeleton" aria-hidden>
      {[92, 64, 78, 40, 86, 58, 70, 30].map((width, index) => (
        <Skeleton key={index} width={`${width}%`} />
      ))}
    </div>
  )
}

export function StatusBar(props: {
  order: string[]
  state: ReviewState
  mode: string
  position: string
  pending: string
  message: string
}) {
  const counts = countVerdicts(props.order, props.state)
  const reviewed = props.order.length - counts.unreviewed
  return (
    <footer className="status">
      <span className="status-left">
        <span className="hint">
          <kbd>?</kbd> keys
        </span>
        {props.position ? <span className="muted">{props.position}</span> : null}
        {props.mode ? <span className="muted">{props.mode}</span> : null}
        {props.message ? <span className="status-message">{props.message}</span> : null}
      </span>
      {props.pending ? <span className="status-pending">{props.pending}</span> : null}
      <span className="status-right tabular">
        {reviewed} of {props.order.length} reviewed
      </span>
    </footer>
  )
}

export function Help(props: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="help" onClick={(event) => event.stopPropagation()}>
        {helpRows().map(({ group, rows }) => (
          <section key={group}>
            <h2>{group}</h2>
            <dl>
              {rows.map((binding) => (
                <div key={binding.action + binding.keys.join()}>
                  <dt>
                    {binding.keys.map((sequence, index) => (
                      <span key={sequence} className="help-alt">
                        {index ? <span className="help-or">/</span> : null}
                        <Keys>{displayKeys(sequence)}</Keys>
                      </span>
                    ))}
                  </dt>
                  <dd>
                    {binding.label}
                    {binding.modes?.length === 1 && binding.modes[0] !== "normal" ? (
                      <span className="help-mode">{binding.modes[0]}</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}

/** The vim-style bottom line for `:` commands. */
export function CommandBar(props: {
  prefix: string
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  return (
    <footer className="status command-bar">
      <span className="command-prefix">{props.prefix}</span>
      <input
        autoFocus
        className="command-input"
        value={props.value}
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={props.onCancel}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Escape") return props.onCancel()
          if (event.key === "Backspace" && !props.value) return props.onCancel()
          if (event.key === "Enter") {
            event.preventDefault()
            props.onSubmit(props.value)
          }
        }}
      />
    </footer>
  )
}

export function Prompt(props: {
  title: string
  placeholder: string
  initial: string
  multiline?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(props.initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <div className="overlay" onClick={props.onCancel}>
      <div className="prompt" onClick={(event) => event.stopPropagation()}>
        <div className="prompt-title">{props.title}</div>
        <textarea
          ref={ref}
          value={value}
          rows={props.multiline ? 4 : 2}
          placeholder={props.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Escape") return props.onCancel()
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              props.onSubmit(value.trim())
            }
          }}
        />
      </div>
    </div>
  )
}

export function Summary(props: {
  manifest: Manifest
  entries: Entry[]
  items: Record<string, ItemLoad>
  state: ReviewState
  selected: number
  outPath: string
  onOpen: (id: string) => void
  onHandBack: () => void
}) {
  const order = props.entries.map((entry) => entry.id)
  const counts = countVerdicts(order, props.state)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector(".ledger-row.is-selected")?.scrollIntoView({ block: "nearest" })
  }, [props.selected])
  const selectedId = order[props.selected]
  return (
    <div className="summary view-enter" ref={ref}>
      <div className="summary-inner">
        <h1>{props.manifest.title}</h1>
        {props.manifest.summary ? <p className="pr-why">{props.manifest.summary}</p> : null}
        <div className="stats">
          <Stat value={counts.approve} label="Approved" kind="approve" />
          <Stat value={counts.reject} label="Rejected" kind="reject" />
          <Stat value={counts.skip} label="Skipped" kind="skip" />
          <Stat value={counts.unreviewed} label="Unreviewed" kind="none" />
        </div>
        <div className="handback">
          <div className="handback-path">{props.outPath}</div>
          <button className="handback-button" onMouseDown={(event) => event.preventDefault()} onClick={props.onHandBack}>
            <kbd>w</kbd> Hand back
          </button>
        </div>
        {props.manifest.groups.map((group) => {
          const progress = groupProgress(group, props.state)
          return (
            <section className="ledger-group" key={group.title}>
              {props.manifest.groups.length > 1 ? (
                <div className="ledger-group-head">
                  <span>{group.title}</span>
                  <span className="tabular">
                    {progress.done}/{progress.total}
                  </span>
                </div>
              ) : null}
              {group.why && props.manifest.groups.length > 1 ? <p className="ledger-group-why">{group.why}</p> : null}
              {group.prs.map((pr) => {
                const id = itemId(pr)
                const load = props.items[id]
                const review = props.state.reviews[id]
                return (
                  <div key={id} className={`ledger-row${id === selectedId ? " is-selected" : ""}`} onClick={() => props.onOpen(id)}>
                    <div className="ledger-head">
                      <Glyph verdict={review?.verdict} />
                      <span className="ledger-title">{load?.ok ? itemTitle(load.data.meta) : itemLabel(pr)}</span>
                      <span className="ledger-confidence">
                        {pr.confidence ? (
                          <span className={`assessment-confidence is-${pr.confidence}`}>
                            <ConfidenceMeter confidence={pr.confidence} />
                            {CONFIDENCE_LABEL[pr.confidence]}
                          </span>
                        ) : null}
                      </span>
                      <span className="ledger-size">{load?.ok ? sizeOf(load.data.meta) : ""}</span>
                      <span className="rail-num tabular">{itemLabel(pr)}</span>
                    </div>
                    {pr.risk && review?.verdict === "approve" ? <LedgerLine tag="Risk">{pr.risk}</LedgerLine> : null}
                    {review?.reason ? (
                      <LedgerLine tag="Reason" tone="reject">
                        {review.reason}
                      </LedgerLine>
                    ) : null}
                    {review?.notes.map((note) => (
                      <LedgerLine key={note.id} tag={note.path ? noteLocation(note) : "Note"}>
                        {note.body}
                      </LedgerLine>
                    ))}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function LedgerLine(props: { tag: string; tone?: string; children: ReactNode }) {
  return (
    <div className={`ledger-line${props.tone ? ` is-${props.tone}` : ""}`}>
      <span className="ledger-tag">{props.tag}</span>
      <span className="ledger-body">{props.children}</span>
    </div>
  )
}

function Stat(props: { value: number; label: string; kind: string }) {
  return (
    <div className={`stat is-${props.kind}`}>
      <span className="stat-value tabular">{props.value}</span>
      <span className="stat-label">{props.label}</span>
    </div>
  )
}

export function HandedBack(props: { path: string; state: ReviewState; order: string[]; onHome: () => void }) {
  const counts = countVerdicts(props.order, props.state)
  return (
    <div className="splash view-enter">
      <div className="handed-back">
        <svg className="handed-back-mark" width="40" height="40" viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r="19" />
          <path d="M13 20.5l4.8 4.8L27.5 15" />
        </svg>
        <h1>Handed back</h1>
        <p className="tabular">
          {counts.approve} approved · {counts.reject} rejected · {counts.skip} skipped
          {counts.unreviewed ? ` · ${counts.unreviewed} unreviewed` : ""}
        </p>
        <p className="handed-back-path">{props.path}</p>
        <button className="link-button" onMouseDown={(event) => event.preventDefault()} onClick={props.onHome}>
          Inbox
        </button>
      </div>
    </div>
  )
}

export function FilePalette(props: {
  files: { name: string; additions: number; deletions: number }[]
  viewed: Set<string>
  onPick: (index: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const matches = props.files
    .map((file, index) => ({ file, index, score: fuzzyScore(file.name, query) }))
    .filter((match): match is typeof match & { score: number } => match.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index)
  const active = Math.min(selected, Math.max(0, matches.length - 1))
  useEffect(() => {
    listRef.current?.querySelector(".palette-row.is-selected")?.scrollIntoView({ block: "nearest" })
  }, [active])
  return (
    <div className="overlay is-top" onClick={props.onClose}>
      <div className="palette" onClick={(event) => event.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          value={query}
          placeholder="File"
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            const move = (delta: number) => {
              event.preventDefault()
              setSelected(Math.max(0, Math.min(matches.length - 1, active + delta)))
            }
            if (event.key === "Escape") return props.onClose()
            if (event.key === "ArrowDown" || (event.ctrlKey && (event.key === "n" || event.key === "j"))) return move(1)
            if (event.key === "ArrowUp" || (event.ctrlKey && (event.key === "p" || event.key === "k"))) return move(-1)
            if (event.key === "Enter" && matches[active]) return props.onPick(matches[active].index)
          }}
        />
        <div className="palette-list" ref={listRef}>
          {matches.map((match, position) => {
            const slash = match.file.name.lastIndexOf("/")
            return (
              <div
                key={match.file.name}
                className={`palette-row${position === active ? " is-selected" : ""}${props.viewed.has(match.file.name) ? " is-viewed" : ""}`}
                onMouseMove={() => setSelected(position)}
                onClick={() => props.onPick(match.index)}
              >
                <span className="palette-name">{match.file.name.slice(slash + 1)}</span>
                <span className="palette-dir">{match.file.name.slice(0, slash + 1)}</span>
                <span className="spacer" />
                {props.viewed.has(match.file.name) ? <span className="palette-viewed">Viewed</span> : null}
                <span className="palette-count tabular">
                  {match.file.additions ? <span className="add">+{match.file.additions}</span> : null}
                  {match.file.deletions ? <span className="del">−{match.file.deletions}</span> : null}
                </span>
              </div>
            )
          })}
          {matches.length ? null : <div className="palette-empty">No matching files</div>}
        </div>
      </div>
    </div>
  )
}
