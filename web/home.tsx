import { useEffect, useRef, useState } from "react"
import type { InboxEntry, SessionStatus } from "../src/types"
import { feed, keyName, type Pending } from "./keymap"
import { Glyph, Help, Keys } from "./views"

const SECTIONS: { status: SessionStatus; title: string; empty: string }[] = [
  { status: "waiting", title: "Waiting on you", empty: "Nothing is waiting on you." },
  { status: "progress", title: "In progress", empty: "" },
  { status: "done", title: "Done", empty: "" },
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
    if (row.status === "waiting") return setMessage("A client is still waiting on that session")
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
          <span className="home-sub">{waiting ? `${waiting} waiting on you` : rows?.length ? "Nothing waiting" : ""}</span>
        </header>
        {rows === null ? null : rows.length === 0 ? (
          <EmptyInbox />
        ) : (
          SECTIONS.map((section) => {
            const list = ordered.filter((row) => row.status === section.status)
            if (!list.length && !section.empty) return null
            return (
              <section className="inbox-section" key={section.status}>
                <h2>
                  {section.title}
                  <span className="tabular">{list.length || ""}</span>
                </h2>
                {list.length ? (
                  list.map((row) => (
                    <InboxRow
                      key={row.id}
                      row={row}
                      selected={row.id === current?.id}
                      onOpen={() => props.onOpen(row.id)}
                      onArchive={() => archive(row)}
                    />
                  ))
                ) : (
                  <p className="inbox-empty-section">{section.empty}</p>
                )}
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
          {rows?.length ? (
            <>
              <span className="hint">
                <Keys>j k</Keys> move
              </span>
              <span className="hint">
                <kbd>↵</kbd> open
              </span>
              <span className="hint">
                <kbd>d</kbd> archive
              </span>
            </>
          ) : null}
          {message ? <span className="status-message">{message}</span> : null}
        </span>
        <span className="status-right">{location.host}</span>
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
      <span className="inbox-main">
        <span className="inbox-title">{row.title}</span>
        <span className="inbox-source">{source}</span>
      </span>
      {row.status === "done" ? (
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

function EmptyInbox() {
  return (
    <div className="inbox-empty">
      <p className="inbox-empty-title">No sessions yet</p>
      <p>Put pull requests on the docket from any checkout, and they show up here.</p>
      <pre>
        <code>{"docket 52985 52988\ndocket --author @me --state open\ndocket my-branch"}</code>
      </pre>
      <p className="muted">The command waits until you hand the session back, then prints your verdicts.</p>
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
