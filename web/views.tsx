import { useEffect, useRef, useState } from "react"
import { itemId, itemLabel, type ItemLoad, type Manifest, type Note, type PrReview, type ReviewState, type Verdict } from "../src/types"
import { countVerdicts, displayTitle, noteCount, noteLocation, type Entry } from "./model"

const VERDICT_LABEL: Record<Verdict, string> = { approve: "Approved", reject: "Rejected", skip: "Skipped" }
const STATE_LABEL = { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed", LOCAL: "Local" }
const VERDICT_GLYPH: Record<Verdict, string> = { approve: "✓", reject: "✕", skip: "–" }

export function Glyph(props: { verdict: Verdict | null | undefined }) {
  if (!props.verdict) return <span className="glyph">○</span>
  return <span className={`glyph is-${props.verdict}`}>{VERDICT_GLYPH[props.verdict]}</span>
}

export function VerdictLabel(props: { verdict: Verdict | null | undefined }) {
  if (!props.verdict) return <span className="verdict-label">Unreviewed</span>
  return (
    <span className={`verdict-label is-${props.verdict}`}>
      {VERDICT_GLYPH[props.verdict]} {VERDICT_LABEL[props.verdict]}
    </span>
  )
}

export function Rail(props: {
  manifest: Manifest
  items: Record<string, ItemLoad>
  state: ReviewState
  current: string
  onSelect: (id: string) => void
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.querySelector(".rail-pr.is-current")?.scrollIntoView({ block: "nearest" })
  }, [props.current])
  return (
    <nav className="rail" ref={ref}>
      <div className="rail-title">{props.manifest.title}</div>
      {props.manifest.groups.map((group) => (
        <div className="rail-group" key={group.title}>
          <div className="rail-group-title">{group.title}</div>
          {group.why ? (
            <div className="rail-group-why" title={group.why}>
              {group.why}
            </div>
          ) : null}
          {group.prs.map((pr) => {
            const id = itemId(pr)
            const load = props.items[id]
            const review = props.state.reviews[id]
            const notes = noteCount(review)
            const title = load?.ok ? displayTitle(load.data.meta.title) : load ? "Failed to load" : "Loading…"
            return (
              <button
                key={id}
                className={`rail-pr${id === props.current ? " is-current" : ""}${review?.verdict ? " is-done" : ""}`}
                title={pr.after?.length ? `${title}\nAfter ${pr.after.map((n) => `#${n}`).join(", ")}` : title}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onSelect(id)}
              >
                <Glyph verdict={review?.verdict} />
                <span className="rail-pr-title">{title}</span>
                {notes ? <span className="rail-notes">{notes}</span> : null}
                <span className="rail-num">{pr.number ?? ""}</span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export function PrHeader(props: { entry: Entry; load: ItemLoad | undefined; review: PrReview | undefined; state: ReviewState; total: number }) {
  const meta = props.load?.ok ? props.load.data.meta : undefined
  const stats = meta
    ? [
        meta.commits ? `${meta.commits} commit${meta.commits === 1 ? "" : "s"}` : null,
        `${meta.changedFiles} file${meta.changedFiles === 1 ? "" : "s"}`,
        meta.additions ? `+${meta.additions}` : null,
        meta.deletions ? `−${meta.deletions}` : null,
      ].filter((value) => value !== null)
    : []
  return (
    <header className="pr-header">
      <div className="pr-context">
        <span>{props.entry.group.title}</span>
        <span className="dot-sep">·</span>
        <span>
          {props.entry.index + 1} of {props.total}
        </span>
        <span className="dot-sep">·</span>
        <span>{itemLabel(props.entry.pr)}</span>
        {meta && meta.state !== "OPEN" ? <span className="pr-state">{STATE_LABEL[meta.state]}</span> : null}
        <span className="spacer" />
        {props.review?.verdict ? <VerdictLabel verdict={props.review.verdict} /> : null}
        {meta?.url ? (
          <a href={meta.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        ) : null}
      </div>
      <h1>{meta ? displayTitle(meta.title) : "Loading…"}</h1>
      {props.entry.pr.why ? <p className="pr-why">{props.entry.pr.why}</p> : null}
      <div className="pr-stats">
        {stats.join(" · ")}
        {props.entry.pr.after?.map((number) => (
          <span key={number}>
            {" · "}after #{number}
            {props.state.reviews[number]?.verdict ? <> <Glyph verdict={props.state.reviews[number]?.verdict} /></> : null}
          </span>
        ))}
      </div>
      {props.review?.reason ? (
        <p className="pr-aside">
          <span className="pr-aside-label">Reject reason</span>
          {props.review.reason}
        </p>
      ) : null}
    </header>
  )
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
            {props.focus === index ? (
              <span className="pr-note-keys">
                <kbd>e</kbd> edit <kbd>d</kbd> delete
              </span>
            ) : null}
            <button onClick={() => props.onEdit(note)}>Edit</button>
            <button onClick={() => props.onDelete(note.id)}>Delete</button>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function StatusBar(props: { order: string[]; state: ReviewState; mode: string; position: string }) {
  const counts = countVerdicts(props.order, props.state)
  const reviewed = props.order.length - counts.unreviewed
  return (
    <footer className="status">
      <span className="status-left">
        <span>
          <kbd>?</kbd> keys
        </span>
        {props.position ? <span className="muted">{props.position}</span> : null}
        {props.mode ? <span className="muted">{props.mode}</span> : null}
      </span>
      <span className="progress">
        <span className="progress-bar">
          <span style={{ width: `${(reviewed / Math.max(1, props.order.length)) * 100}%` }} />
        </span>
        {reviewed} of {props.order.length} reviewed
      </span>
    </footer>
  )
}

const HELP: [string, [string, string][]][] = [
  [
    "Move",
    [
      ["j  k", "Next / previous change"],
      ["⌃n  ⌃p", "Next / previous line"],
      ["]  [", "Next / previous file"],
      ["J  K", "Next / previous PR"],
      ["gg  G", "Top / bottom of PR"],
      ["⌃d  ⌃u", "Half page down / up"],
    ],
  ],
  [
    "Review",
    [
      ["a", "Approve and advance"],
      ["r", "Reject with reason and advance"],
      ["s", "Skip and advance"],
      ["u", "Clear verdict"],
      ["n", "Note on the PR"],
      ["V  v", "Select lines, then n to comment"],
    ],
  ],
  [
    "View",
    [
      ["o  ⏎", "Fold / unfold file"],
      ["t", "Split / unified"],
      ["z", "Ignore whitespace"],
      ["O", "Open on GitHub"],
      ["⏎  :", "Summary"],
      ["w", "Write verdicts (in summary)"],
    ],
  ],
]

export function Help(props: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="help" onClick={(event) => event.stopPropagation()}>
        {HELP.map(([title, rows]) => (
          <section key={title}>
            <h2>{title}</h2>
            <dl>
              {rows.map(([key, label]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
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
          rows={props.multiline ? 5 : 2}
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
        <div className="draft-hint">Enter to confirm · Shift-Enter for newline · Esc to cancel</div>
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
}) {
  const order = props.entries.map((entry) => entry.id)
  const counts = countVerdicts(order, props.state)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector(".summary-row.is-selected")?.scrollIntoView({ block: "nearest" })
  }, [props.selected])
  return (
    <div className="summary" ref={ref}>
      <div className="summary-inner">
        <div className="pr-context">Summary</div>
        <h1>{props.manifest.title}</h1>
        <p className="summary-counts">
          <span className="is-approve">{counts.approve} approved</span>
          <span className="dot-sep">·</span>
          <span className="is-reject">{counts.reject} rejected</span>
          <span className="dot-sep">·</span>
          <span className="is-skip">{counts.skip} skipped</span>
          <span className="dot-sep">·</span>
          <span>{counts.unreviewed} unreviewed</span>
        </p>
        <p className="summary-write">
          <kbd>w</kbd> hands back: writes <span className="mono">{props.outPath}</span> and closes docket
        </p>
        <div className="summary-list">
          {props.entries.map((entry, index) => {
            const load = props.items[entry.id]
            const review = props.state.reviews[entry.id]
            return (
              <div
                key={entry.id}
                className={`summary-row${index === props.selected ? " is-selected" : ""}`}
                onClick={() => props.onOpen(entry.id)}
              >
                <div className="summary-head">
                  <Glyph verdict={review?.verdict} />
                  <span className="summary-pr-title">{load?.ok ? displayTitle(load.data.meta.title) : ""}</span>
                  <span className="rail-num">{itemLabel(entry.pr)}</span>
                </div>
                {review?.reason ? <div className="summary-detail">{review.reason}</div> : null}
                {review?.notes.map((note) => (
                  <div key={note.id} className="summary-detail">
                    <span className="loc">
                      {note.path ? noteLocation(note) : "PR"}
                    </span>
                    {note.body}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        <div className="summary-foot">j k move · ⏎ open · Esc back</div>
      </div>
    </div>
  )
}
