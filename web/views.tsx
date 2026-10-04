import { useEffect, useRef, useState } from "react"
import type { Manifest, PrLoad, PrReview, ReviewState, Verdict } from "../src/types"
import { countVerdicts, noteCount, type Entry } from "./model"

const VERDICT_LABEL: Record<Verdict, string> = { approve: "Approved", reject: "Rejected", skip: "Skipped" }
const VERDICT_GLYPH: Record<Verdict, string> = { approve: "✓", reject: "✕", skip: "–" }

export function VerdictPill(props: { verdict: Verdict | null | undefined; compact?: boolean }) {
  if (!props.verdict) return null
  return (
    <span className={`verdict verdict-${props.verdict}`}>
      {props.compact ? VERDICT_GLYPH[props.verdict] : `${VERDICT_GLYPH[props.verdict]} ${VERDICT_LABEL[props.verdict]}`}
    </span>
  )
}

export function StateBadge(props: { state: string }) {
  return <span className={`state state-${props.state.toLowerCase()}`}>{props.state.toLowerCase()}</span>
}

export function Rail(props: {
  manifest: Manifest
  prs: Record<string, PrLoad>
  state: ReviewState
  current: number
  onSelect: (number: number) => void
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
          {group.prs.map((pr) => {
            const load = props.prs[pr.number]
            const meta = load?.ok ? load.data.meta : undefined
            const review = props.state.reviews[pr.number]
            const notes = noteCount(review)
            return (
              <button
                key={pr.number}
                className={`rail-pr${pr.number === props.current ? " is-current" : ""}${review?.verdict ? ` is-${review.verdict}` : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onSelect(pr.number)}
              >
                <span className="rail-mark">
                  {review?.verdict ? <VerdictPill verdict={review.verdict} compact /> : <span className="dot" />}
                </span>
                <span className="rail-main">
                  <span className="rail-line">
                    <span className="rail-num">#{pr.number}</span>
                    <span className="rail-pr-title">{meta ? stripPrefix(meta.title) : load ? "failed to load" : "loading…"}</span>
                  </span>
                  <span className="rail-sub">
                    {meta ? (
                      <>
                        <span className="add">+{meta.additions}</span>
                        <span className="del">−{meta.deletions}</span>
                      </>
                    ) : null}
                    {meta && meta.state !== "OPEN" ? <StateBadge state={meta.state} /> : null}
                    {pr.after?.length ? <span className="after">after {pr.after.map((n) => `#${n}`).join(", ")}</span> : null}
                    {notes ? <span className="rail-notes">✎ {notes}</span> : null}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export function PrHeader(props: { entry: Entry; load: PrLoad | undefined; review: PrReview | undefined; state: ReviewState; total: number }) {
  const meta = props.load?.ok ? props.load.data.meta : undefined
  return (
    <header className="pr-header">
      <div className="pr-kicker">
        <span>{props.entry.group.title}</span>
        <span className="sep">/</span>
        <span>
          {props.entry.index + 1} of {props.total}
        </span>
      </div>
      <div className="pr-title-row">
        <h1>
          <span className="pr-num">#{props.entry.pr.number}</span> {meta?.title ?? "Loading…"}
        </h1>
        {meta ? <StateBadge state={meta.state} /> : null}
        <VerdictPill verdict={props.review?.verdict} />
      </div>
      <p className="pr-why">{props.entry.pr.why}</p>
      {props.entry.group.why ? <p className="group-why">{props.entry.group.why}</p> : null}
      <div className="pr-meta">
        {meta ? (
          <>
            <span className="add">+{meta.additions}</span>
            <span className="del">−{meta.deletions}</span>
            <span>
              {meta.changedFiles} file{meta.changedFiles === 1 ? "" : "s"}
            </span>
            <span className="mono">{meta.headRefName}</span>
            <a href={meta.url} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          </>
        ) : null}
        {props.entry.pr.after?.map((number) => (
          <span key={number} className="after">
            after #{number} <VerdictPill verdict={props.state.reviews[number]?.verdict} compact />
          </span>
        ))}
      </div>
      {props.review?.reason ? (
        <div className="callout callout-reject">
          <span className="callout-label">Reject reason</span>
          {props.review.reason}
        </div>
      ) : null}
      {props.review?.prNote ? (
        <div className="callout">
          <span className="callout-label">PR note</span>
          {props.review.prNote}
        </div>
      ) : null}
    </header>
  )
}

export function StatusBar(props: { order: number[]; state: ReviewState; diffStyle: string; ignoreWhitespace: boolean; position: string }) {
  const counts = countVerdicts(props.order, props.state)
  const reviewed = props.order.length - counts.unreviewed
  return (
    <footer className="status">
      <div className="hints">
        <Hint k="j k">hunk</Hint>
        <Hint k="] [">file</Hint>
        <Hint k="J K">PR</Hint>
        <Hint k="n">note</Hint>
        <Hint k="a">approve</Hint>
        <Hint k="r">reject</Hint>
        <Hint k="s">skip</Hint>
        <Hint k="⏎">summary</Hint>
        <Hint k="?">help</Hint>
      </div>
      <div className="status-right">
        <span className="muted">{props.position}</span>
        <span className="muted">
          {props.diffStyle}
          {props.ignoreWhitespace ? " · ignoring whitespace" : ""}
        </span>
        <span className="progress">
          <span className="progress-bar">
            <span style={{ width: `${(reviewed / Math.max(1, props.order.length)) * 100}%` }} />
          </span>
          {reviewed}/{props.order.length} reviewed
        </span>
      </div>
    </footer>
  )
}

function Hint(props: { k: string; children: string }) {
  return (
    <span className="hint">
      <kbd>{props.k}</kbd>
      {props.children}
    </span>
  )
}

const HELP: [string, string][][] = [
  [
    ["j / k", "Next / previous change"],
    ["Ctrl-n / Ctrl-p", "Next / previous line"],
    ["] / [", "Next / previous file"],
    ["J / K", "Next / previous PR"],
    ["g g / G", "Top / bottom of PR"],
    ["Ctrl-d / Ctrl-u", "Half page down / up"],
  ],
  [
    ["a", "Approve and advance"],
    ["r", "Reject (with reason) and advance"],
    ["s", "Skip and advance"],
    ["u", "Clear verdict"],
    ["n", "Note on cursor line (edit if one exists)"],
    ["N", "PR-level note"],
  ],
  [
    ["v", "Split / unified"],
    ["z", "Ignore whitespace"],
    ["o", "Open PR on GitHub"],
    ["Enter or :", "Summary"],
    ["w", "Write verdicts (summary)"],
    ["?", "This help"],
  ],
]

export function Help(props: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="help" onClick={(event) => event.stopPropagation()}>
        <div className="help-title">Keyboard</div>
        <div className="help-cols">
          {HELP.map((column, index) => (
            <dl key={index}>
              {column.map(([key, label]) => (
                <div key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          ))}
        </div>
        <div className="help-foot">
          Press <kbd>?</kbd> or <kbd>Esc</kbd> to close
        </div>
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
        <div className="draft-hint">
          <kbd>Enter</kbd> confirm · <kbd>Shift Enter</kbd> newline · <kbd>Esc</kbd> cancel
        </div>
      </div>
    </div>
  )
}

export function Summary(props: {
  manifest: Manifest
  entries: Entry[]
  prs: Record<string, PrLoad>
  state: ReviewState
  selected: number
  outPath: string
  written: string | null
  onOpen: (number: number) => void
}) {
  const order = props.entries.map((entry) => entry.pr.number)
  const counts = countVerdicts(order, props.state)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector(".summary-row.is-selected")?.scrollIntoView({ block: "nearest" })
  }, [props.selected])
  return (
    <div className="summary" ref={ref}>
      <div className="summary-inner">
        <div className="pr-kicker">Summary</div>
        <h1 className="summary-title">{props.manifest.title}</h1>
        <div className="counts">
          <Count label="Approved" value={counts.approve} kind="approve" />
          <Count label="Rejected" value={counts.reject} kind="reject" />
          <Count label="Skipped" value={counts.skip} kind="skip" />
          <Count label="Unreviewed" value={counts.unreviewed} kind="none" />
        </div>
        <div className="write-row">
          <span>
            <kbd>w</kbd> write verdicts to <span className="mono">{props.outPath}</span>
          </span>
          {props.written ? <span className="written">✓ Written at {props.written}</span> : null}
        </div>
        <div className="summary-list">
          {props.entries.map((entry, index) => {
            const load = props.prs[entry.pr.number]
            const review = props.state.reviews[entry.pr.number]
            return (
              <div
                key={entry.pr.number}
                className={`summary-row${index === props.selected ? " is-selected" : ""}`}
                onClick={() => props.onOpen(entry.pr.number)}
              >
                <div className="summary-head">
                  <span className="summary-verdict">
                    {review?.verdict ? <VerdictPill verdict={review.verdict} /> : <span className="unreviewed">Unreviewed</span>}
                  </span>
                  <span className="rail-num">#{entry.pr.number}</span>
                  <span className="summary-pr-title">{load?.ok ? load.data.meta.title : ""}</span>
                </div>
                {review?.reason ? <div className="summary-detail reject-reason">{review.reason}</div> : null}
                {review?.prNote ? <div className="summary-detail">{review.prNote}</div> : null}
                {review?.notes.map((note) => (
                  <div key={note.id} className="summary-detail">
                    <span className="mono loc">
                      {note.path}:{note.side === "deletions" ? "L" : "R"}
                      {note.line}
                    </span>
                    {note.body}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        <div className="summary-foot">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open PR · <kbd>Esc</kbd> back to deck
        </div>
      </div>
    </div>
  )
}

function Count(props: { label: string; value: number; kind: string }) {
  return (
    <div className={`count count-${props.kind}`}>
      <div className="count-value">{props.value}</div>
      <div className="count-label">{props.label}</div>
    </div>
  )
}

function stripPrefix(title: string) {
  return title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")
}
