import { DIFFS_TAG_NAME, type SelectedLineRange } from "@pierre/diffs"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { itemLabel, type Note, type PrReview, type ReviewState, type SessionPayload, type Side, type Verdict } from "../src/types"
import { FileBlock, type Draft } from "./diff"
import { buildModel, EMPTY_REVIEW, entries as toEntries, nextUnreviewed, rangeAnchor, type PrModel, type Row } from "./model"
import { HandedBack, Help, PrHeader, PrNotes, PrSkeleton, Prompt, Rail, StatusBar, Summary, VerdictPrompt } from "./views"

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
      const status: { version: number } = await fetch("/api/version").then((res) => res.json())
      if (status.version === seen.version) return
      seen.version = status.version
      load()
    }, 700)
    return () => clearInterval(timer)
  }, [])

  if (!session || !state) return <div className="splash" />
  return <Deck session={session} initial={state} />
}

type PromptState = { kind: "reject" } | { kind: "note"; noteId?: string; initial: string }
type ScrollIntent = "top" | "visible" | "none"
type Visual = { anchor: number; pill?: { x: number; y: number } }

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
  const [visual, setVisual] = useState<Visual | null>(null)
  const [noteFocus, setNoteFocus] = useState<number | null>(null)
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">(() =>
    localStorage.getItem("docket.diffStyle") === "unified" ? "unified" : "split",
  )
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [help, setHelp] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [summaryIndex, setSummaryIndex] = useState(0)
  const [handedBack, setHandedBack] = useState<string | null>(null)
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const [stamped, setStamped] = useState<string | null>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const scrollIntent = useRef<ScrollIntent>("top")
  const pendingG = useRef(0)
  const pointer = useRef({ x: 0, y: 0 })

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
  const prNotes = useMemo(() => (review?.notes ?? []).filter((note) => !note.path), [review?.notes])
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

  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY }
    }
    window.addEventListener("pointerup", track, true)
    return () => window.removeEventListener("pointerup", track, true)
  }, [])

  const updateReview = useCallback((id: string, fn: (review: PrReview) => PrReview) => {
    setState((prev) => ({ ...prev, reviews: { ...prev.reviews, [id]: fn(prev.reviews[id] ?? EMPTY_REVIEW) } }))
  }, [])

  const goTo = useCallback((id: string) => {
    scrollIntent.current = "top"
    setDraft(null)
    setVisual(null)
    setNoteFocus(null)
    setCursorMode("block")
    setCursors((prev) => ({ ...prev, [id]: HEADER }))
    setState((prev) => ({ ...prev, current: id }))
  }, [])

  const moveCursor = useCallback(
    (index: number, intent: ScrollIntent, mode: "block" | "line" = "block") => {
      scrollIntent.current = intent
      setCursorMode(mode)
      setNoteFocus(null)
      setCursors((prev) => ({ ...prev, [current]: index }))
    },
    [current],
  )

  const decide = (verdict: Verdict, reason?: string) => {
    const next = nextUnreviewed(order, { ...state, reviews: { ...state.reviews, [current]: { ...EMPTY_REVIEW, verdict } } }, current)
    updateReview(current, (prev) => ({ ...prev, verdict, reason: verdict === "reject" ? reason || undefined : undefined }))
    setStamped(current)
    setTimeout(() => setStamped((value) => (value === current ? null : value)), 400)
    if (next === undefined) {
      setSummaryIndex(order.indexOf(current))
      setView("summary")
      return
    }
    goTo(next)
  }

  /** Opens the line-note editor on rows `a..b` of the current PR, reusing a note already anchored there. */
  const openRangeDraft = useCallback(
    (a: number, b: number) => {
      if (!model) return
      const row = model.rows[Math.max(a, b)]
      if (!row) return
      const path = model.files[row.file]!.name
      const anchor = rangeAnchor(model.rows, a, b)
      const existing = (state.reviews[current]?.notes ?? []).findLast(
        (note) => note.path === path && note.side === anchor.side && note.line === anchor.line && note.startLine === anchor.startLine,
      )
      setVisual(null)
      setCursorMode("line")
      setCursors((prev) => ({ ...prev, [current]: Math.max(a, b) }))
      setDraft({
        path,
        side: anchor.side,
        startLine: anchor.startLine,
        line: anchor.line,
        body: existing?.body ?? "",
        noteId: existing?.id,
      })
    },
    [model, state.reviews, current],
  )

  const saveDraft = useCallback(
    (body: string) => {
      if (!draft) return
      const trimmed = body.trim()
      updateReview(current, (prev) => {
        const others = prev.notes.filter((note) => note.id !== draft.noteId)
        if (!trimmed) return { ...prev, notes: others }
        const note: Note = {
          id: draft.noteId ?? crypto.randomUUID(),
          path: draft.path,
          side: draft.side,
          ...(draft.startLine ? { startLine: draft.startLine } : {}),
          line: draft.line,
          body: trimmed,
        }
        const notes = draft.noteId ? prev.notes.map((item) => (item.id === draft.noteId ? note : item)) : [...prev.notes, note]
        return { ...prev, notes }
      })
      setDraft(null)
    },
    [draft, current, updateReview],
  )

  const savePrNote = (noteId: string | undefined, body: string) => {
    updateReview(current, (prev) => {
      if (!body) return { ...prev, notes: prev.notes.filter((note) => note.id !== noteId) }
      if (noteId) return { ...prev, notes: prev.notes.map((note) => (note.id === noteId ? { ...note, body } : note)) }
      return { ...prev, notes: [...prev.notes, { id: crypto.randomUUID(), body }] }
    })
  }

  const deleteNote = useCallback(
    (noteId: string) => updateReview(current, (prev) => ({ ...prev, notes: prev.notes.filter((note) => note.id !== noteId) })),
    [current, updateReview],
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
    if (!note.path || !note.side || note.line === undefined) return setPrompt({ kind: "note", noteId: note.id, initial: note.body })
    setDraft({ path: note.path, side: note.side, startLine: note.startLine, line: note.line, body: note.body, noteId: note.id })
  }, [])
  const rowIndex = useCallback(
    (file: number, side: Side, line: number) =>
      model?.rows.findIndex((row) => row.file === file && row.side === side && row.line === line) ?? -1,
    [model],
  )
  const clickLine = useCallback(
    (file: number, side: Side, line: number) => {
      const index = rowIndex(file, side, line)
      if (index < 0) return
      setVisual(null)
      moveCursor(index, "none", "line")
    },
    [rowIndex, moveCursor],
  )
  const pickRange = useCallback(
    (file: number, range: SelectedLineRange, compose: boolean) => {
      const a = rowIndex(file, range.side ?? "additions", range.start)
      const b = rowIndex(file, range.endSide ?? range.side ?? "additions", range.end)
      if (a < 0 || b < 0) return
      if (compose) return openRangeDraft(a, b)
      if (a === b) return clickLine(file, range.side ?? "additions", range.start)
      setCursorMode("line")
      setCursors((prev) => ({ ...prev, [current]: b }))
      setVisual({ anchor: a, pill: { ...pointer.current } })
    },
    [rowIndex, openRangeDraft, clickLine, current],
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

  // Visual mode: j/k extend by line within the anchor's file; n or Enter opens the range editor.
  const visualKey = (key: string, anchor: number) => {
    const rows = model?.rows ?? []
    const file = rows[anchor]?.file
    switch (key) {
      case "j":
      case "k":
      case "C-n":
      case "C-p":
      case "ArrowDown":
      case "ArrowUp": {
        const down = key === "j" || key === "C-n" || key === "ArrowDown"
        const index = cursorIndex + (down ? 1 : -1)
        if (rows[index]?.file === file) moveCursor(index, "visible", "line")
        setVisual({ anchor })
        return true
      }
      case "n":
      case "N":
      case "Enter":
        openRangeDraft(anchor, cursorIndex)
        return true
      case "Escape":
      case "v":
      case "V":
        setVisual(null)
        return true
      case "?":
        setHelp(true)
        return true
      default:
        setVisual(null)
        return deckKey(key)
    }
  }

  // On the header, j/k step through the PR notes before reaching the diff.
  const headerNoteKey = (key: string) => {
    if (cursorIndex !== HEADER || !prNotes.length) return false
    const focused = noteFocus === null ? undefined : prNotes[noteFocus]
    if (key === "j" && (noteFocus ?? -1) < prNotes.length - 1) {
      setNoteFocus((noteFocus ?? -1) + 1)
      return true
    }
    if (key === "k" && noteFocus !== null) {
      setNoteFocus(noteFocus === 0 ? null : noteFocus - 1)
      return true
    }
    if (!focused) return false
    if (key === "e" || key === "Enter") {
      setPrompt({ kind: "note", noteId: focused.id, initial: focused.body })
      return true
    }
    if (key === "d") {
      deleteNote(focused.id)
      setNoteFocus(prNotes.length > 1 ? Math.max(0, noteFocus! - 1) : null)
      return true
    }
    if (key === "Escape") {
      setNoteFocus(null)
      return true
    }
    return false
  }

  const deckKey = (key: string): boolean => {
    if (help) return closeHelp(key)
    if (visual) return visualKey(key, visual.anchor)
    if (headerNoteKey(key)) return true
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
        if (!block && key === "k") {
          moveCursor(HEADER, "top")
          if (cursorIndex !== HEADER && prNotes.length) setNoteFocus(prNotes.length - 1)
        }
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
        setPrompt({ kind: "reject" })
        return true
      case "u":
        updateReview(current, (prev) => ({ ...prev, verdict: null, reason: undefined }))
        return true
      case "n":
      case "N":
        setPrompt({ kind: "note", initial: "" })
        return true
      case "v":
      case "V": {
        const start = cursor ? cursorIndex : (blocks[0]?.first ?? 0)
        if (!rows[start]) return true
        if (isCollapsed(rows[start]!.file)) toggleFold(model!.files[rows[start]!.file]!.name)
        moveCursor(start, cursor ? "none" : "top", "line")
        setVisual({ anchor: start })
        return true
      }
      case "t": {
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
        const url = session.items[current]?.ok ? session.items[current].data.meta.url : undefined
        if (url) window.open(url, "_blank")
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
    if (!cursor || cursor.file !== fileIndex || !model) return null
    if (visual) return rangeAnchor(model.rows, visual.anchor, cursorIndex).selection
    const block = cursor.block === null ? undefined : model.blocks[cursor.block]
    if (cursorMode === "block" && block) return block.range
    return { start: cursor.line, end: cursor.line, side: cursor.side }
  }

  const load = session.items[current]
  const visualAnchor = visual && model ? rangeAnchor(model.rows, visual.anchor, cursorIndex) : undefined
  const visualCount = visualAnchor ? visualAnchor.line - (visualAnchor.startLine ?? visualAnchor.line) + 1 : 0
  const position = visual
    ? `VISUAL · ${visualCount} line${visualCount === 1 ? "" : "s"} · n to comment`
    : cursor && model
      ? `${model.files[cursor.file]?.name.split("/").at(-1)}:${cursor.side === "deletions" ? "L" : "R"}${cursor.line}`
      : ""

  if (handedBack) return <HandedBack path={handedBack} state={state} order={order} />

  return (
    <div className="app">
      <Rail
        manifest={session.manifest}
        items={session.items}
        state={state}
        current={current}
        stamped={stamped}
        onSelect={(id) => {
          setView("deck")
          goTo(id)
        }}
      />
      {view === "summary" ? (
        <Summary
          manifest={session.manifest}
          entries={entries}
          items={session.items}
          state={state}
          selected={summaryIndex}
          outPath={session.outPath}
          onHandBack={handBack}
          onOpen={(id) => {
            goTo(id)
            setView("deck")
          }}
        />
      ) : (
        <main className="main" ref={mainRef}>
          <div className="pr-view view-enter" key={current}>
            <PrHeader entry={entry} load={load} review={review} state={state} total={order.length} />
            <PrNotes
              notes={prNotes}
              focus={cursorIndex === HEADER ? noteFocus : null}
              onEdit={(note) => setPrompt({ kind: "note", noteId: note.id, initial: note.body })}
              onDelete={deleteNote}
            />
            {load && !load.ok ? (
              <div className="error">
                Could not load {current}: {load.error}
              </div>
            ) : null}
            {model && model.files.length === 0 ? (
              <div className="empty">No file changes{ignoreWhitespace ? " outside whitespace" : ""}.</div>
            ) : null}
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
                  visual={Boolean(visual) && cursor?.file === index}
                  diffStyle={diffStyle}
                  onLine={clickLine}
                  onRange={pickRange}
                  onSaveDraft={saveDraft}
                  onCancelDraft={cancelDraft}
                  onEditNote={editNote}
                  onToggle={toggleFold}
                />
              ))}
            </div>
            {load ? (
              <VerdictPrompt
                label={itemLabel(entry.pr)}
                verdict={review?.verdict}
                onDecide={(verdict) => (verdict === "reject" ? setPrompt({ kind: "reject" }) : decide(verdict))}
              />
            ) : (
              <PrSkeleton />
            )}
          </div>
        </main>
      )}
      {visual?.pill ? (
        <button
          className="comment-pill"
          style={{ left: visual.pill.x + 12, top: visual.pill.y + 12 }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openRangeDraft(visual.anchor, cursorIndex)}
        >
          Comment <kbd>n</kbd>
        </button>
      ) : null}
      <StatusBar
        order={order}
        state={state}
        position={view === "deck" ? position : ""}
        mode={[diffStyle === "unified" ? "unified" : "", ignoreWhitespace ? "ignoring whitespace" : ""].filter(Boolean).join(" · ")}
      />
      {help ? <Help onClose={() => setHelp(false)} /> : null}
      {prompt?.kind === "reject" ? (
        <Prompt
          title="Reject"
          placeholder="Reason (optional)"
          initial={review?.reason ?? ""}
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => {
            setPrompt(null)
            decide("reject", value)
          }}
        />
      ) : null}
      {prompt?.kind === "note" ? (
        <Prompt
          title={prompt.noteId ? "Edit note" : "Note on this PR"}
          placeholder="Write a note for the agent…"
          initial={prompt.initial}
          multiline
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => {
            setPrompt(null)
            savePrNote(prompt.noteId, value)
          }}
        />
      ) : null}
    </div>
  )
}

const NO_NOTES: Note[] = []

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
