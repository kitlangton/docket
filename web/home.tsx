import { useEffect, useRef, useState } from "react"
import type { InboxEntry, SessionStatus } from "../src/types"
import { feed, keyName, type Pending } from "./keymap"
import { Glyph, Help } from "./views"

const SECTIONS: { status: SessionStatus; title: string }[] = [
  { status: "waiting", title: "Waiting on you" },
  { status: "progress", title: "In progress" },
  { status: "done", title: "Done" },
]

// The last inbox seen, so coming back home renders at once while it refreshes.
const cache: { rows: InboxEntry[] | null } = { rows: null }

/** The inbox: every session the server knows, grouped by who is waiting on whom. */
export function Home(props: { tick: number; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<InboxEntry[] | null>(cache.rows)
  const [selected, setSelected] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const [message, setMessage] = useState("")
  const pending = useRef<Pending>({ count: "", keys: [] })

  useEffect(() => {
    fetch("/api/sessions")
      .then((res) => res.json())
      .then((value: InboxEntry[]) => {
        cache.rows = value
        setRows(value)
      })
  }, [props.tick])

  const ordered = SECTIONS.flatMap((section) => (rows ?? []).filter((row) => row.status === section.status))
  const index = Math.max(
    0,
    ordered.findIndex((row) => row.id === selected),
  )
  const current = ordered[index]
  const waiting = ordered.filter((row) => row.status === "waiting").length

  useEffect(() => {
    document.title = waiting ? `docket · ${waiting} waiting` : "docket"
  }, [waiting])

  useEffect(() => {
    document.querySelector(".inbox-row.is-selected")?.scrollIntoView({ block: "nearest" })
  }, [current?.id])

  const archive = async (row: InboxEntry) => {
    if (row.status === "waiting") return setMessage("Still waiting")
    await fetch(`/api/s/${encodeURIComponent(row.id)}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) })
    setSelected(ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null)
    setMessage(`Archived ${row.title}`)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.metaKey || event.altKey) return
      const key = keyName(event)
      if (help) {
        if (key === "?" || key === "Escape" || key === "q") setHelp(false)
        event.preventDefault()
        return
      }
      const result = feed(pending.current, key, ["home"])
      pending.current = result.kind === "wait" ? result.pending : { count: "", keys: [] }
      if (result.kind === "none") return
      event.preventDefault()
      if (result.kind !== "run") return
      const step = result.count ?? 1
      const move = (delta: number) => setSelected(ordered[Math.max(0, Math.min(ordered.length - 1, index + delta))]?.id ?? null)
      if (result.binding.action === "homeNext") move(step)
      if (result.binding.action === "homePrev") move(-step)
      if (result.binding.action === "homeOpen" && current) props.onOpen(current.id)
      if (result.binding.action === "homeArchive" && current) archive(current)
      if (result.binding.action === "help") setHelp(true)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div className="home">
      <div className="home-inner view-enter">
        <header className="home-head">
          <span className="home-mark" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 32 32">
              <rect width="32" height="32" rx="8" fill="var(--raised)" />
              <path d="M9 11h14M9 16h9M9 21h6" stroke="var(--text-3)" strokeWidth="2.2" strokeLinecap="round" />
              <path
                d="M18.5 21l2.2 2.2 4.3-4.7"
                fill="none"
                stroke="var(--approve)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1>docket</h1>
        </header>
        {rows === null ? null : rows.length === 0 ? (
          <EmptyInbox />
        ) : (
          SECTIONS.map((section) => {
            const list = ordered.filter((row) => row.status === section.status)
            if (!list.length) return null
            return (
              <section className="inbox-section" key={section.status}>
                <h2>
                  {section.title}
                  <span className="tabular">{list.length}</span>
                </h2>
                {list.map((row) => (
                  <InboxRow
                    key={row.id}
                    row={row}
                    selected={row.id === current?.id}
                    onOpen={() => props.onOpen(row.id)}
                    onArchive={() => archive(row)}
                  />
                ))}
              </section>
            )
          })
        )}
      </div>
      <footer className="status">
        <span className="status-left">
          <span className="hint">
            <kbd>?</kbd> keys
          </span>
          {message ? <span className="status-message">{message}</span> : null}
        </span>
      </footer>
      {help ? <Help onClose={() => setHelp(false)} /> : null}
    </div>
  )
}

function InboxRow(props: { row: InboxEntry; selected: boolean; onOpen: () => void; onArchive: () => void }) {
  const row = props.row
  const source = [row.repo, row.cwd && !row.cwd.endsWith(`/${row.repo.split("/").at(-1)}`) ? shortPath(row.cwd) : "", row.agent]
    .filter(Boolean)
    .join(" · ")
  return (
    <div className={`inbox-row is-${row.status}${props.selected ? " is-selected" : ""}`} onClick={props.onOpen}>
      <span className="inbox-status" aria-label={row.status}>
        {row.status === "waiting" ? (
          <span className="pulse" />
        ) : row.status === "done" ? (
          <Glyph verdict="approve" />
        ) : (
          <Glyph verdict={null} />
        )}
      </span>
      {row.kind === "pick" ? <PickGlyph /> : null}
      <span className="inbox-main">
        <span className="inbox-title">{row.title}</span>
        <span className="inbox-source">{source}</span>
      </span>
      {row.pick && row.status === "done" ? (
        <span className="inbox-answer">
          {row.pick.thumb ? <img className="inbox-thumb" src={row.pick.thumb} alt="" /> : null}
          <span className="tabular">{row.pick.none ? "None" : row.pick.picked.join(" · ") || "No pick"}</span>
        </span>
      ) : row.status === "done" ? (
        <span className="inbox-verdicts tabular">
          {row.counts.approve ? <span className="is-approve">✓ {row.counts.approve}</span> : null}
          {row.counts.reject ? <span className="is-reject">✕ {row.counts.reject}</span> : null}
          {row.counts.skip ? <span className="is-skip">→ {row.counts.skip}</span> : null}
          {row.counts.unreviewed ? <span>○ {row.counts.unreviewed}</span> : null}
        </span>
      ) : (
        <span className="inbox-progress tabular">
          <span className="meter">
            <span style={{ width: `${(row.reviewed / Math.max(1, row.total)) * 100}%` }} />
          </span>
          {row.reviewed}/{row.total}
        </span>
      )}
      <span className="inbox-notes tabular">{row.notes ? <span className="rail-notes">{row.notes}</span> : null}</span>
      <span className="inbox-age tabular" title={new Date(row.updatedAt).toLocaleString()}>
        {age(row.updatedAt)}
      </span>
      {row.status === "waiting" ? (
        <span className="inbox-archive" aria-hidden />
      ) : (
        <button
          className="inbox-archive"
          title="Archive (d)"
          onClick={(event) => {
            event.stopPropagation()
            props.onArchive()
          }}
        >
          Archive
        </button>
      )}
    </div>
  )
}

/** Marks a pick session: a small 2×2 grid, unlike the round review glyphs. */
function PickGlyph() {
  return (
    <svg className="inbox-kind" width="12" height="12" viewBox="0 0 12 12" aria-label="pick">
      <rect x="1" y="1" width="4" height="4" rx="1" />
      <rect x="7" y="1" width="4" height="4" rx="1" />
      <rect x="1" y="7" width="4" height="4" rx="1" />
      <rect x="7" y="7" width="4" height="4" rx="1" />
    </svg>
  )
}

function EmptyInbox() {
  return (
    <div className="inbox-empty">
      <code>docket &lt;prs&gt;</code>
    </div>
  )
}

function age(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function shortPath(path: string) {
  const home = path.replace(/^\/Users\/[^/]+/, "~")
  const parts = home.split("/")
  return parts.length > 4 ? `…/${parts.slice(-2).join("/")}` : home
}
