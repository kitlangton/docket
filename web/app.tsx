import { DIFFS_TAG_NAME } from "@pierre/diffs"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Note, PrReview, ReviewState, SessionPayload, Side, Verdict } from "../src/types"
import { FileBlock, type Draft } from "./diff"
import { buildModel, EMPTY_REVIEW, entries as toEntries, nextUnreviewed, type PrModel, type Row } from "./model"
import { Help, PrHeader, Prompt, Rail, StatusBar, Summary } from "./views"

export function App() {
  const [session, setSession] = useState<SessionPayload>()
  const [state, setState] = useState<ReviewState>()

  useEffect(() => {
    const load = () =>
      fetch("/api/session")
        .then((res) => res.json())
        .then((payload: SessionPayload) => setSession(payload))
    load()
    fetch("/api/state")
      .then((res) => res.json())
      .then((value: ReviewState) => setState(value))
    const seen = { version: -1 }
    const timer = setInterval(async () => {
      const status: { version: number; progress: SessionPayload["progress"] } = await fetch("/api/version").then((res) =>
        res.json(),
      )
      if (status.version !== seen.version) {
        seen.version = status.version
        load()
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  if (!session || !state) return <div className="splash">docket</div>
  const ready = session.progress.done >= session.progress.total || session.progress.phase === "Ready"
  if (!ready) return <Loading session={session} />
  return <Deck session={session} initial={state} />
}

function Loading(props: { session: SessionPayload }) {
  const progress = props.session.progress
  return (
    <div className="splash">
      <div className="loading">
        <div className="loading-title">{props.session.manifest.title}</div>
        <div className="progress-bar wide">
          <span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
        </div>
        <div className="muted">
          {progress.phase} · {progress.done}/{progress.total} PRs
        </div>
      </div>
    </div>
  )
}

type PromptKind = "reject" | "prNote"
type ScrollIntent = "top" | "visible" | "none"

// Cursor position above the first change: the PR header, shown at scroll top.
const HEADER = -1

function Deck(props: { session: SessionPayload; initial: ReviewState }) {
  const session = props.session
  const entries = useMemo(() => toEntries(session.manifest), [session.manifest])
  const order = useMemo(() => entries.map((entry) => entry.id), [entries])
  const [state, setState] = useState<ReviewState>(() => ({
    ...props.initial,
    current: props.initial.current && order.includes(props.initial.current) ? props.initial.current : order[0]!,
  }))
  const current = state.current ?? order[0]!
  const [view, setView] = useState<"deck" | "summary">("deck")
  const [cursors, setCursors] = useState<Record<string, number>>({})
  const [cursorMode, setCursorMode] = useState<"block" | "line">("block")
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">(
    () => (localStorage.getItem("docket.diffStyle") === "unified" ? "unified" : "split"),
  )
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [help, setHelp] = useState(false)
  const [prompt, setPrompt] = useState<PromptKind | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [summaryIndex, setSummaryIndex] = useState(0)
  const [handedBack, setHandedBack] = useState<string | null>(null)
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const mainRef = useRef<HTMLDivElement>(null)
  const scrollIntent = useRef<ScrollIntent>("top")
  const pendingG = useRef(0)

  const models = useMemo(() => {
    const result = new Map<string, PrModel>()
    entries.forEach((entry) => {
      const load = session.items[entry.id]
      if (!load?.ok) return
      const patch = ignoreWhitespace ? load.data.patchIgnoreWhitespace : load.data.patch
      result.set(entry.id, buildModel(patch, `${entry.id}-${load.data.meta.headRefOid}-${ignoreWhitespace ? "w" : ""}`, entry.pr.focus))
    })
    return result
  }, [entries, session.items, ignoreWhitespace])

  const entry = entries[order.indexOf(current)]!
  const model = models.get(current)
  const review = state.reviews[current]
  const cursorIndex = model?.rows.length ? Math.min(cursors[current] ?? HEADER, model.rows.length - 1) : HEADER
  const cursor: Row | undefined = cursorIndex === HEADER ? undefined : model?.rows[cursorIndex]
  const isCollapsed = (fileIndex: number) => {
    const file = model?.files[fileIndex]
    if (!file) return false
    return folds[`${current}:${file.name}`] ?? file.type === "deleted"
  }
  // Blocks inside a folded file collapse into one stop at that file's header.
  const navBlocks = (model?.blocks ?? []).filter(
    (block, index, blocks) => !isCollapsed(block.file) || blocks.findIndex((b) => b.file === block.file) === index,
  )

  const reviewedCount = order.filter((id) => state.reviews[id]?.verdict).length
  useEffect(() => {
    document.title = `docket · ${reviewedCount}/${order.length}`
  }, [reviewedCount, order.length])

  // Persist review state shortly after each change.
  const firstSave = useRef(true)
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false
      return
    }
    const timer = setTimeout(() => {
      fetch("/api/state", { method: "PUT", body: JSON.stringify(state) })
    }, 250)
    return () => clearTimeout(timer)
  }, [state])

  const updateReview = useCallback((id: string, fn: (review: PrReview) => PrReview) => {
    setState((prev) => ({ ...prev, reviews: { ...prev.reviews, [id]: fn(prev.reviews[id] ?? EMPTY_REVIEW) } }))
  }, [])

  const goTo = useCallback((id: string) => {
    scrollIntent.current = "top"
    setDraft(null)
    setCursorMode("block")
    setCursors((prev) => ({ ...prev, [id]: HEADER }))
    setState((prev) => ({ ...prev, current: id }))
  }, [])

  const moveCursor = useCallback(
    (index: number, intent: ScrollIntent, mode: "block" | "line" = "block") => {
      scrollIntent.current = intent
      setCursorMode(mode)
      setCursors((prev) => ({ ...prev, [current]: index }))
    },
    [current],
  )

  const decide = (verdict: Verdict, reason?: string) => {
    const next = nextUnreviewed(order, { ...state, reviews: { ...state.reviews, [current]: { ...EMPTY_REVIEW, verdict } } }, current)
    updateReview(current, (prev) => ({ ...prev, verdict, reason: verdict === "reject" ? reason || undefined : undefined }))
    if (next === undefined) {
      setSummaryIndex(order.indexOf(current))
      setView("summary")
      return
    }
    goTo(next)
  }

  const openDraft = useCallback(
    (path: string, side: Side, line: number) => {
      const existing = (state.reviews[current]?.notes ?? []).findLast(
        (note) => note.path === path && note.side === side && note.line === line,
      )
      setDraft({ path, side, line, body: existing?.body ?? "", noteId: existing?.id })
    },
    [state.reviews, current],
  )

  const saveDraft = useCallback(
    (body: string) => {
      if (!draft) return
      const trimmed = body.trim()
      updateReview(current, (prev) => {
        const others = prev.notes.filter((note) => note.id !== draft.noteId)
        if (!trimmed) return { ...prev, notes: others }
        const note: Note = { id: draft.noteId ?? crypto.randomUUID(), path: draft.path, side: draft.side, line: draft.line, body: trimmed }
        const notes = draft.noteId ? prev.notes.map((item) => (item.id === draft.noteId ? note : item)) : [...prev.notes, note]
        return { ...prev, notes }
      })
      setDraft(null)
    },
    [draft, current, updateReview],
  )

  const toggleFold = useCallback(
    (path: string) => {
      const file = model?.files.find((item) => item.name === path)
      if (!file) return
      const key = `${current}:${path}`
      scrollIntent.current = "top"
      setFolds((prev) => ({ ...prev, [key]: !(prev[key] ?? file.type === "deleted") }))
    },
    [model, current],
  )

  const cancelDraft = useCallback(() => setDraft(null), [])
  const editNote = useCallback((note: Note) => {
    if (!note.path || !note.side || note.line === undefined) return
    setDraft({ path: note.path, side: note.side, line: note.line, body: note.body, noteId: note.id })
  }, [])
  const clickLine = useCallback(
    (file: number, side: Side, line: number) => {
      const index = model?.rows.findIndex((row) => row.file === file && row.side === side && row.line === line) ?? -1
      if (index >= 0) moveCursor(index, "none", "line")
    },
    [model, moveCursor],
  )

  const handBack = async () => {
    const res = await fetch("/api/handback", { method: "POST", body: JSON.stringify(state) })
    const body: { path: string } = await res.json()
    setHandedBack(body.path)
  }

  // Scroll the cursor into place after it moves or the PR changes.
  useEffect(() => {
    const intent = scrollIntent.current
    scrollIntent.current = "none"
    const main = mainRef.current
    if (!main || view !== "deck" || intent === "none") return
    if (!cursor) {
      main.scrollTop = 0
      return
    }
    const frame = { id: 0, tries: 0 }
    const attempt = () => {
      const element = rowElement(main, cursor)
      if (!element) {
        if (frame.tries++ < 30) frame.id = requestAnimationFrame(attempt)
        return
      }
      const top = element.getBoundingClientRect().top - main.getBoundingClientRect().top
      const margin = main.clientHeight * 0.22
      if (intent === "visible" && top > 60 && top < main.clientHeight - 60) return
      main.scrollTop += top - margin
    }
    attempt()
    return () => cancelAnimationFrame(frame.id)
  }, [cursorIndex, current, view, diffStyle, cursor])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return
      if (event.metaKey || event.altKey) return
      if (prompt || draft) return
      const key = event.ctrlKey ? `C-${event.key}` : event.key
      const handled = view === "summary" ? summaryKey(key) : deckKey(key)
      if (!handled) return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const summaryKey = (key: string) => {
    if (help) return closeHelp(key)
    switch (key) {
      case "j":
      case "ArrowDown":
        setSummaryIndex((index) => Math.min(order.length - 1, index + 1))
        return true
      case "k":
      case "ArrowUp":
        setSummaryIndex((index) => Math.max(0, index - 1))
        return true
      case "Enter":
        goTo(order[summaryIndex]!)
        setView("deck")
        return true
      case "Escape":
      case "q":
        setView("deck")
        return true
      case "w":
        handBack()
        return true
      case "?":
        setHelp(true)
        return true
      default:
        return false
    }
  }

  const closeHelp = (key: string) => {
    if (key === "?" || key === "Escape" || key === "q") setHelp(false)
    return true
  }

  const deckKey = (key: string) => {
    if (help) return closeHelp(key)
    const rows = model?.rows ?? []
    const blocks = navBlocks
    const half = (mainRef.current?.clientHeight ?? 600) / 2
    const isG = key === "g" && Date.now() - pendingG.current < 600
    pendingG.current = key === "g" && !isG ? Date.now() : 0
    if (key === "g") {
      if (isG) moveCursor(HEADER, "top")
      return true
    }
    switch (key) {
      case "j":
      case "k": {
        const block = key === "j" ? blocks.find((b) => b.first > cursorIndex) : blocks.findLast((b) => b.first < cursorIndex)
        if (block) moveCursor(block.first, "top")
        if (!block && key === "k") moveCursor(HEADER, "top")
        return true
      }
      case "C-n":
      case "C-p": {
        const index = key === "C-n" ? Math.min(rows.length - 1, cursorIndex + 1) : Math.max(HEADER, cursorIndex - 1)
        moveCursor(index, "visible", "line")
        return true
      }
      case "]":
      case "[": {
        const file = cursor?.file ?? HEADER
        const target = key === "]" ? file + 1 : cursor && rows.findIndex((row) => row.file === file) < cursorIndex ? file : file - 1
        const index = blocks.find((b) => b.file === target)?.first ?? rows.findIndex((row) => row.file === target)
        if (index >= 0) moveCursor(index, "top")
        return true
      }
      case "J":
      case "K": {
        const next = order[order.indexOf(current) + (key === "J" ? 1 : -1)]
        if (next !== undefined) goTo(next)
        return true
      }
      case "G": {
        const last = blocks.at(-1)
        if (last) moveCursor(last.first, "top")
        requestAnimationFrame(() => mainRef.current && (mainRef.current.scrollTop = mainRef.current.scrollHeight))
        return true
      }
      case "C-d":
      case "C-u": {
        const main = mainRef.current
        if (!main) return true
        main.scrollTop += key === "C-d" ? half : -half
        if (main.scrollTop === 0) {
          moveCursor(HEADER, "none")
          return true
        }
        const visible = blocks.find((b) => {
          const element = rows[b.first] && rowElement(main, rows[b.first]!)
          return element ? element.getBoundingClientRect().top - main.getBoundingClientRect().top > 40 : false
        })
        if (visible) moveCursor(visible.first, "none")
        return true
      }
      case "a":
        decide("approve")
        return true
      case "s":
        decide("skip")
        return true
      case "r":
        setPrompt("reject")
        return true
      case "u":
        updateReview(current, (prev) => ({ ...prev, verdict: null, reason: undefined }))
        return true
      case "n":
        if (!cursor || !model) {
          setPrompt("prNote")
          return true
        }
        if (isCollapsed(cursor.file)) toggleFold(model.files[cursor.file]!.name)
        openDraft(model.files[cursor.file]!.name, cursor.side, cursor.line)
        return true
      case "N":
        setPrompt("prNote")
        return true
      case "v": {
        const next = diffStyle === "split" ? "unified" : "split"
        localStorage.setItem("docket.diffStyle", next)
        scrollIntent.current = "top"
        setDiffStyle(next)
        return true
      }
      case "z":
        scrollIntent.current = "top"
        setCursors((prev) => ({ ...prev, [current]: HEADER }))
        setIgnoreWhitespace((value) => !value)
        return true
      case "o":
        if (cursor && model) toggleFold(model.files[cursor.file]!.name)
        return true
      case "O": {
        const load = session.items[current]
        if (load?.ok) window.open(load.data.meta.url, "_blank")
        return true
      }
      case "?":
        setHelp(true)
        return true
      case "Enter":
        if (cursor && model && isCollapsed(cursor.file)) {
          toggleFold(model.files[cursor.file]!.name)
          return true
        }
        setSummaryIndex(order.indexOf(current))
        setView("summary")
        return true
      case ":":
        setSummaryIndex(order.indexOf(current))
        setView("summary")
        return true
      default:
        return false
    }
  }

  const notesByFile = useMemo(() => {
    const map = new Map<string, Note[]>()
    review?.notes.forEach((note) => {
      if (note.path) map.set(note.path, [...(map.get(note.path) ?? []), note])
    })
    return map
  }, [review?.notes])

  const selectionFor = (fileIndex: number) => {
    if (!cursor || cursor.file !== fileIndex) return null
    const block = cursor.block === null ? undefined : model?.blocks[cursor.block]
    if (cursorMode === "block" && block) return block.range
    return { start: cursor.line, end: cursor.line, side: cursor.side }
  }

  const load = session.items[current]
  const position = cursor && model ? `${model.files[cursor.file]?.name.split("/").at(-1)}:${cursor.side === "deletions" ? "L" : "R"}${cursor.line}` : ""

  if (handedBack) return <HandedBack path={handedBack} />

  return (
    <div className="app">
      <Rail manifest={session.manifest} items={session.items} state={state} current={current} onSelect={(id) => {
        setView("deck")
        goTo(id)
      }} />
      {view === "summary" ? (
        <Summary
          manifest={session.manifest}
          entries={entries}
          items={session.items}
          state={state}
          selected={summaryIndex}
          outPath={session.outPath}
          onOpen={(id) => {
            goTo(id)
            setView("deck")
          }}
        />
      ) : (
        <main className="main" ref={mainRef}>
          <PrHeader entry={entry} load={load} review={review} state={state} total={order.length} />
          {load && !load.ok ? <div className="error">Could not load #{current}: {load.error}</div> : null}
          {model && model.files.length === 0 ? <div className="empty">This PR has no file changes{ignoreWhitespace ? " outside whitespace" : ""}.</div> : null}
          <div className="files" key={`${current}-${ignoreWhitespace}`}>
            {model?.files.map((file, index) => (
              <FileBlock
                key={file.name}
                index={index}
                file={file}
                focus={model.focus.has(file.name)}
                collapsed={isCollapsed(index)}
                cursorHere={cursor?.file === index}
                notes={notesByFile.get(file.name) ?? NO_NOTES}
                draft={draft && draft.path === file.name ? draft : null}
                selection={selectionFor(index)}
                diffStyle={diffStyle}
                onLine={clickLine}
                onAddNote={openDraft}
                onSaveDraft={saveDraft}
                onCancelDraft={cancelDraft}
                onEditNote={editNote}
                onToggle={toggleFold}
              />
            ))}
          </div>
          <div className="end-of-pr">End of #{current}</div>
        </main>
      )}
      <StatusBar
        order={order}
        state={state}
        position={view === "deck" ? position : ""}
        mode={[diffStyle === "unified" ? "unified" : "", ignoreWhitespace ? "ignoring whitespace" : ""].filter(Boolean).join(" · ")}
      />
      {help ? <Help onClose={() => setHelp(false)} /> : null}
      {prompt === "reject" ? (
        <Prompt
          title={`Reject #${current}`}
          placeholder="Reason (optional)"
          initial={review?.reason ?? ""}
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => {
            setPrompt(null)
            decide("reject", value)
          }}
        />
      ) : null}
      {prompt === "prNote" ? (
        <Prompt
          title={`Note on #${current}`}
          placeholder="PR-level note"
          initial=""
          multiline
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => {
            setPrompt(null)
            if (value) updateReview(current, (prev) => ({ ...prev, notes: [...prev.notes, { id: crypto.randomUUID(), body: value }] }))
          }}
        />
      ) : null}
    </div>
  )
}

const NO_NOTES: Note[] = []

function HandedBack(props: { path: string }) {
  return (
    <div className="splash">
      <div className="handed-back">
        <div className="handed-back-title">Handed back</div>
        <p>Verdicts are in {props.path}. You can close this tab.</p>
      </div>
    </div>
  )
}

function rowElement(main: HTMLElement, row: Row) {
  const section = main.querySelector<HTMLElement>(`[data-file-index="${row.file}"]`)
  if (section?.hasAttribute("data-collapsed")) return section
  const host = section?.querySelector(DIFFS_TAG_NAME)
  const root = host?.shadowRoot
  if (!root) return null
  const column = root.querySelector(row.side === "deletions" ? "[data-deletions]" : "[data-additions]") ?? root
  const type = row.kind === "context" ? "context" : row.kind === "add" ? "change-addition" : "change-deletion"
  const candidates = [...column.querySelectorAll<HTMLElement>(`[data-line="${row.line}"]`)]
  return candidates.find((element) => element.dataset.lineType?.startsWith(type)) ?? candidates[0] ?? null
}
