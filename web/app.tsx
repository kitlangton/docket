import type { SelectedLineRange } from "@pierre/diffs"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { itemLabel, type Note, type PrReview, type ReviewState, type SessionPayload, type Side, type Verdict } from "../src/types"
import { FileBlock, type Draft } from "./diff"
import { rowElement } from "./dom"
import { buildModel, EMPTY_REVIEW, entries as toEntries, nextUnreviewed, rangeAnchor, type PrModel, type Row } from "./model"
import { feed, keyName, type Action, type Binding, type Mode, type Pending } from "./keymap"
import { findMatches, matchIndexAt, useSearchHighlights, wordAt, type Match, type Query } from "./search"
import {
  CommandBar,
  FilePalette,
  HandedBack,
  Help,
  PrHeader,
  PrNotes,
  PrSkeleton,
  Prompt,
  Rail,
  StatusBar,
  Summary,
  VerdictPrompt,
} from "./views"

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
type ScrollIntent = "top" | "visible" | "none" | "center" | "tight" | "bottom"
type Position = { id: string; index: number }
type VerdictValue = { verdict: Verdict | null; reason?: string }
type Bar = { kind: "search" | "command" | "confirm"; text: string }

const EMPTY_PENDING: Pending = { count: "", keys: [] }
// Matches --diffs-line-height and the file header band height in styles.css.
const LINE_HEIGHT = 20
const FILE_HEADER_HEIGHT = 41
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
  useEffect(() => localStorage.removeItem("docket.separator"), [])
  const [help, setHelp] = useState(false)
  const [palette, setPalette] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [summaryIndex, setSummaryIndex] = useState(0)
  const [handedBack, setHandedBack] = useState<string | null>(null)
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const [stamped, setStamped] = useState<string | null>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const scrollIntent = useRef<ScrollIntent>("top")
  const [pending, setPending] = useState("")
  const pendingRef = useRef<Pending>(EMPTY_PENDING)
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [message, setMessage] = useState<{ text: string; at: number } | null>(null)
  const [bar, setBar] = useState<Bar | null>(null)
  const barOrigin = useRef<{ index: number; search: Query | null; searchIndex: number } | null>(null)
  const [search, setSearch] = useState<Query | null>(null)
  const [searchIndex, setSearchIndex] = useState(-1)
  const [closed, setClosed] = useState(false)
  const jumpsRef = useRef<{ list: Position[]; index: number }>({ list: [], index: 0 })
  const undoRef = useRef<{ id: string; before: VerdictValue; after: VerdictValue }[]>([])
  const redoRef = useRef<typeof undoRef.current>([])
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
  const viewed = useMemo(() => new Set(review?.viewed ?? []), [review?.viewed])
  const isCollapsed = (fileIndex: number) => {
    const file = model?.files[fileIndex]
    if (!file) return false
    const folded = file.type === "deleted" || viewed.has(file.name) || (model.large && !model.focus.has(file.name))
    return folds[`${current}:${file.name}`] ?? folded
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
    const before = state.reviews[current]
    undoRef.current.push({
      id: current,
      before: { verdict: before?.verdict ?? null, reason: before?.reason },
      after: { verdict, reason: verdict === "reject" ? reason || undefined : undefined },
    })
    redoRef.current = []
    const next = nextUnreviewed(order, { ...state, reviews: { ...state.reviews, [current]: { ...EMPTY_REVIEW, verdict } } }, current)
    updateReview(current, (prev) => ({ ...prev, verdict, reason: verdict === "reject" ? reason || undefined : undefined }))
    setStamped(current)
    setTimeout(() => setStamped((value) => (value === current ? null : value)), 400)
    if (next === undefined) {
      setSummaryIndex(order.indexOf(current))
      setView("summary")
      return
    }
    recordJump()
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
      if (!model || !file) return
      const key = `${current}:${path}`
      const folded = file.type === "deleted" || viewed.has(path) || (model.large && !model.focus.has(path))
      scrollIntent.current = "top"
      setFolds((prev) => ({ ...prev, [key]: !(prev[key] ?? folded) }))
    },
    [model, current, viewed],
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

  /** Moves the cursor to a file: its first change, or its header when folded or empty. */
  const jumpToFile = (fileIndex: number) => {
    const rows = model?.rows ?? []
    const index = navBlocks.find((b) => b.file === fileIndex)?.first ?? rows.findIndex((row) => row.file === fileIndex)
    if (index >= 0) return moveCursor(index, "top")
    mainRef.current?.querySelector(`[data-file-index="${fileIndex}"]`)?.scrollIntoView({ block: "start" })
  }

  const toggleViewed = () => {
    if (!cursor || !model) return
    const path = model.files[cursor.file]!.name
    const marking = !viewed.has(path)
    updateReview(current, (prev) => ({
      ...prev,
      viewed: marking ? [...(prev.viewed ?? []), path] : (prev.viewed ?? []).filter((item) => item !== path),
    }))
    setFolds((prev) => {
      const { [`${current}:${path}`]: _, ...rest } = prev
      return rest
    })
    if (marking && cursor.file + 1 < model.files.length) jumpToFile(cursor.file + 1)
  }

  // File headers stick directly under the PR band, whose height changes when it expands.
  useEffect(() => {
    const main = mainRef.current
    const band = main?.querySelector<HTMLElement>(".pr-band")
    if (!main || !band) return
    const observer = new ResizeObserver(() => main.style.setProperty("--sticky-offset", `${band.offsetHeight}px`))
    observer.observe(band)
    return () => observer.disconnect()
  }, [current, view])

  const handBack = async () => {
    const res = await fetch("/api/handback", { method: "POST", body: JSON.stringify(state) })
    const body: { path: string } = await res.json()
    setHandedBack(body.path)
  }

  // Scroll the cursor into place after it moves or the PR changes. Always instant: no smooth scrolling.
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
      if (placeRow(main, cursor, intent)) return
      if (frame.tries++ < 30) frame.id = requestAnimationFrame(attempt)
    }
    attempt()
    return () => cancelAnimationFrame(frame.id)
  }, [cursorIndex, current, view, diffStyle, cursor])

  const say = (text: string) => setMessage({ text, at: Date.now() })
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 2000)
    return () => clearTimeout(timer)
  }, [message])

  // --- Jumplist: big jumps record where they left from; C-o / C-i walk the list.
  const position = (): Position => ({ id: current, index: cursorIndex })
  const recordJump = () => {
    const jumps = jumpsRef.current
    jumps.list = [...jumps.list.slice(0, jumps.index), position()].slice(-100)
    jumps.index = jumps.list.length
  }
  const restore = (pos: Position) => {
    scrollIntent.current = pos.index === HEADER ? "top" : "visible"
    setVisual(null)
    setDraft(null)
    setCursorMode(pos.index === HEADER ? "block" : "line")
    setCursors((prev) => ({ ...prev, [pos.id]: pos.index }))
    setState((prev) => ({ ...prev, current: pos.id }))
    setView("deck")
  }
  const jumpBack = (count: number) => {
    const jumps = jumpsRef.current
    if (jumps.index === jumps.list.length) jumps.list = [...jumps.list, position()]
    const target = Math.max(0, jumps.index - count)
    if (target === jumps.index || !jumps.list[target]) return say("Already at the oldest jump")
    jumps.index = target
    restore(jumps.list[target]!)
  }
  const jumpForward = (count: number) => {
    const jumps = jumpsRef.current
    const target = Math.min(jumps.list.length - 1, jumps.index + count)
    if (target <= jumps.index) return say("Already at the newest jump")
    jumps.index = target
    restore(jumps.list[target]!)
  }
  const switchPr = (id: string) => {
    if (id === current) return
    recordJump()
    goTo(id)
  }

  // --- Verdict undo / redo (this session only).
  const applyVerdict = (id: string, value: VerdictValue, verb: string) => {
    updateReview(id, (prev) => ({ ...prev, verdict: value.verdict, reason: value.reason }))
    if (id !== current) goTo(id)
    const label = entries.find((item) => item.id === id)?.pr
    say(`${verb} ${label ? itemLabel(label) : id}: ${value.verdict ?? "no verdict"}`)
  }
  const undo = () => {
    const change = undoRef.current.pop()
    if (!change) return say("Nothing to undo")
    redoRef.current.push(change)
    applyVerdict(change.id, change.before, "Undid")
  }
  const redo = () => {
    const change = redoRef.current.pop()
    if (!change) return say("Nothing to redo")
    undoRef.current.push(change)
    applyVerdict(change.id, change.after, "Redid")
  }

  // --- Search over the current PR's diff text, both sides.
  const runSearch = (query: Query | null) => {
    setSearch(query)
    if (!query?.pattern) return []
    return findMatches(model?.rows ?? [], query)
  }
  const gotoMatch = (match: Match) => {
    const row = model?.rows[match.row]
    if (!row || !model) return
    const file = model.files[row.file]!
    if (isCollapsed(row.file)) setFolds((prev) => ({ ...prev, [`${current}:${file.name}`]: false }))
    moveCursor(match.row, "visible", "line")
  }
  const stepMatch = (direction: 1 | -1, count = 1, query = search) => {
    const list = query ? findMatches(model?.rows ?? [], query) : []
    if (!list.length) return say(query ? `Pattern not found: ${query.pattern}` : "No previous search")
    const from = Math.max(cursorIndex, HEADER)
    const steps = Array.from({ length: count })
    const final = steps.reduce<{ index: number; wrapped: boolean }>(
      (state) => {
        const at = list[state.index]?.row ?? from
        const next =
          direction === 1
            ? list.findIndex((match, index) => match.row > at || (match.row === at && index > state.index && state.index >= 0))
            : list.findLastIndex((match, index) => match.row < at || (match.row === at && index < state.index))
        if (next >= 0) return { index: next, wrapped: state.wrapped }
        return { index: direction === 1 ? 0 : list.length - 1, wrapped: true }
      },
      { index: matchIndexAt(list, from, search === query ? searchIndex : -1), wrapped: false },
    )
    recordJump()
    setSearchIndex(final.index)
    gotoMatch(list[final.index]!)
    if (final.wrapped) say("Search wrapped")
  }
  const searchWord = (direction: 1 | -1) => {
    const word = cursor ? wordAt(cursor.text) : undefined
    if (!word) return say("No word under the cursor")
    const query: Query = { pattern: word, word: true }
    runSearch(query)
    stepMatch(direction, 1, query)
  }

  // --- The / and : bottom line.
  const openBar = (kind: "search" | "command") => {
    barOrigin.current = { index: cursorIndex, search, searchIndex }
    setBar({ kind, text: "" })
  }
  const closeBar = () => setBar(null)
  const cancelBar = () => {
    const origin = barOrigin.current
    if (bar?.kind === "search" && origin) {
      setSearch(origin.search)
      setSearchIndex(origin.searchIndex)
      moveCursor(origin.index, origin.index === HEADER ? "top" : "visible", origin.index === HEADER ? "block" : "line")
    }
    closeBar()
  }
  const searchInput = (text: string) => {
    setBar({ kind: "search", text })
    const origin = barOrigin.current
    const list = runSearch(text ? { pattern: text, word: false } : null)
    const next = list.findIndex((match) => match.row > (origin?.index ?? HEADER))
    const index = next >= 0 ? next : list.length ? 0 : -1
    setSearchIndex(index)
    if (index >= 0) gotoMatch(list[index]!)
  }
  const submitSearch = (text: string) => {
    closeBar()
    if (!text) return
    const list = findMatches(model?.rows ?? [], { pattern: text, word: false })
    if (!list.length) return say(`Pattern not found: ${text}`)
    const origin = barOrigin.current
    if (origin) {
      const jumps = jumpsRef.current
      jumps.list = [...jumps.list.slice(0, jumps.index), { id: current, index: origin.index }].slice(-100)
      jumps.index = jumps.list.length
    }
  }
  const runCommand = async (text: string) => {
    closeBar()
    const command = text.trim()
    if (command === "w" || command === "wq" || command === "x") return handBack()
    if (command === "q!") return closeWithoutHandBack()
    if (command === "q") {
      if (!reviewedCount) return closeWithoutHandBack()
      return setBar({ kind: "confirm", text: "" })
    }
    if (command === "s" || command === "summary") return openSummary()
    if (/^#?\d+$/.test(command)) {
      const value = Number(command.replace("#", ""))
      const target =
        entries.find((item) => item.pr.number === value) ?? (value >= 1 && value <= entries.length ? entries[value - 1] : undefined)
      if (!target) return say(`No PR ${command}`)
      setView("deck")
      return switchPr(target.id)
    }
    if (command) say(`Not a command: ${command}`)
  }
  const closeWithoutHandBack = async () => {
    await fetch("/api/close", { method: "POST", body: JSON.stringify(state) })
    setClosed(true)
  }
  const openSummary = () => {
    setSummaryIndex(order.indexOf(current))
    setView("summary")
  }

  // --- Scrolling helpers. Everything is instant.
  const stickyTop = () => {
    const main = mainRef.current
    if (!main) return 0
    const band = main.querySelector<HTMLElement>(".pr-band")?.offsetHeight ?? 0
    return band + FILE_HEADER_HEIGHT
  }
  const placeRow = (main: HTMLElement, row: Row, intent: ScrollIntent) => {
    const element = rowElement(main, row)
    if (!element) return false
    const box = element.getBoundingClientRect()
    const top = box.top - main.getBoundingClientRect().top
    const sticky = stickyTop()
    if (intent === "visible" && top > sticky && top + box.height < main.clientHeight - 20) return true
    const target =
      intent === "tight"
        ? sticky
        : intent === "center"
          ? sticky + (main.clientHeight - sticky - box.height) / 2
          : intent === "bottom"
            ? main.clientHeight - box.height - 8
            : Math.max(sticky + 8, main.clientHeight * 0.22)
    main.scrollTop += top - target
    return true
  }
  const scrollCursor = (intent: ScrollIntent) => {
    const main = mainRef.current
    if (!main || !cursor) return say("Cursor is on the header")
    placeRow(main, cursor, intent)
  }
  // After scrolling the page, keep the cursor on screen by moving it to the nearest visible row.
  const clampCursor = () => {
    const main = mainRef.current
    if (!main || !cursor || !model) return
    const sticky = stickyTop()
    const topOf = (index: number) => {
      const element = rowElement(main, model.rows[index]!)
      return element ? element.getBoundingClientRect().top - main.getBoundingClientRect().top : undefined
    }
    const top = topOf(cursorIndex)
    if (top === undefined) return
    const step = top < sticky ? 1 : top > main.clientHeight - 24 ? -1 : 0
    if (!step) return
    const limit = Math.min(model.rows.length, 4000)
    const found = Array.from({ length: limit }, (_, offset) => cursorIndex + step * (offset + 1)).find((index) => {
      if (index < 0 || index >= model.rows.length) return false
      const value = topOf(index)
      return value !== undefined && value >= sticky && value <= main.clientHeight - 24
    })
    if (found !== undefined) moveCursor(found, "none", "line")
  }
  const scrollPage = (pixels: number, settle: "block" | "line") => {
    const main = mainRef.current
    if (!main) return
    main.scrollTop += pixels
    if (main.scrollTop === 0) return moveCursor(HEADER, "none")
    if (settle === "line") return clampCursor()
    const rows = model?.rows ?? []
    const sticky = stickyTop()
    const visible = navBlocks.find((b) => {
      const element = rows[b.first] && rowElement(main, rows[b.first]!)
      return element ? element.getBoundingClientRect().top - main.getBoundingClientRect().top >= sticky : false
    })
    if (visible) moveCursor(visible.first, "none")
  }

  // --- Folds.
  const setFold = (fileIndex: number, folded: boolean) => {
    const file = model?.files[fileIndex]
    if (!file) return
    scrollIntent.current = "top"
    setFolds((prev) => ({ ...prev, [`${current}:${file.name}`]: folded }))
  }
  const setAllFolds = (folded: boolean) => {
    if (!model) return
    scrollIntent.current = "top"
    setFolds((prev) => ({ ...prev, ...Object.fromEntries(model.files.map((file) => [`${current}:${file.name}`, folded])) }))
  }

  const fileStep = (direction: 1 | -1, count: number) => {
    const rows = model?.rows ?? []
    const file = cursor?.file ?? HEADER
    const startsInFile = cursor && rows.findIndex((row) => row.file === file) < cursorIndex
    const target = direction === 1 ? file + count : startsInFile ? file - count + 1 : file - count
    const index = navBlocks.find((b) => b.file === target)?.first ?? rows.findIndex((row) => row.file === target)
    if (index >= 0) moveCursor(index, "top")
  }

  const changeStep = (direction: 1 | -1, count: number) => {
    const blocks = navBlocks
    const target = Array.from({ length: count }).reduce<number>((at) => {
      const block = direction === 1 ? blocks.find((b) => b.first > at) : blocks.findLast((b) => b.first < at)
      return block ? block.first : direction === 1 ? at : HEADER
    }, cursorIndex)
    if (target === cursorIndex) return
    moveCursor(target, "top")
    if (target === HEADER && prNotes.length) setNoteFocus(prNotes.length - 1)
  }

  const gotoLine = (line: number) => {
    const rows = model?.rows ?? []
    const file = cursor?.file ?? 0
    const inFile = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.file === file && row.side === "additions")
    const hit = inFile.find(({ row }) => row.line >= line) ?? inFile.at(-1)
    if (!hit) return say(`No line ${line}`)
    recordJump()
    if (isCollapsed(file)) setFold(file, false)
    moveCursor(hit.index, "center", "line")
    if (hit.row.line !== line) say(`Line ${line} is not in the diff; nearest is ${hit.row.line}`)
  }

  const startVisual = () => {
    const rows = model?.rows ?? []
    const start = cursor ? cursorIndex : (navBlocks[0]?.first ?? 0)
    if (!rows[start]) return
    if (isCollapsed(rows[start]!.file)) toggleFold(model!.files[rows[start]!.file]!.name)
    moveCursor(start, cursor ? "none" : "top", "line")
    setVisual({ anchor: start })
  }

  const extendVisual = (direction: 1 | -1, count: number) => {
    if (!visual) return
    const rows = model?.rows ?? []
    const file = rows[visual.anchor]?.file
    const target = Array.from({ length: count }).reduce<number>((at) => (rows[at + direction]?.file === file ? at + direction : at), cursorIndex)
    moveCursor(target, "visible", "line")
    setVisual({ anchor: visual.anchor })
  }

  // Each action returns false when it does not apply here, so the next mode can handle the key.
  const actions: Record<Action, (count: number | undefined) => boolean | void> = {
    changeNext: (count) => changeStep(1, count ?? 1),
    changePrev: (count) => changeStep(-1, count ?? 1),
    lineNext: (count) => moveCursor(Math.min((model?.rows.length ?? 1) - 1, cursorIndex + (count ?? 1)), "visible", "line"),
    linePrev: (count) => moveCursor(Math.max(HEADER, cursorIndex - (count ?? 1)), "visible", "line"),
    fileNext: (count) => fileStep(1, count ?? 1),
    filePrev: (count) => fileStep(-1, count ?? 1),
    prNext: (count) => {
      const next = order[Math.min(order.length - 1, order.indexOf(current) + (count ?? 1))]
      if (next) switchPr(next)
    },
    prPrev: (count) => {
      const next = order[Math.max(0, order.indexOf(current) - (count ?? 1))]
      if (next) switchPr(next)
    },
    top: () => {
      recordJump()
      moveCursor(HEADER, "top")
      if (mainRef.current) mainRef.current.scrollTop = 0
    },
    bottom: (count) => {
      if (count !== undefined) return gotoLine(count)
      recordJump()
      const last = navBlocks.at(-1)
      if (last) moveCursor(last.first, "top")
      requestAnimationFrame(() => mainRef.current && (mainRef.current.scrollTop = mainRef.current.scrollHeight))
    },
    halfDown: (count) => scrollPage(((mainRef.current?.clientHeight ?? 600) / 2) * (count ?? 1), "block"),
    halfUp: (count) => scrollPage((-(mainRef.current?.clientHeight ?? 600) / 2) * (count ?? 1), "block"),
    pageDown: (count) => scrollPage(((mainRef.current?.clientHeight ?? 600) - 2 * LINE_HEIGHT) * (count ?? 1), "block"),
    pageUp: (count) => scrollPage(-((mainRef.current?.clientHeight ?? 600) - 2 * LINE_HEIGHT) * (count ?? 1), "block"),
    scrollDown: (count) => scrollPage(LINE_HEIGHT * (count ?? 1), "line"),
    scrollUp: (count) => scrollPage(-LINE_HEIGHT * (count ?? 1), "line"),
    cursorCenter: () => scrollCursor("center"),
    cursorTop: () => scrollCursor("tight"),
    cursorBottom: () => scrollCursor("bottom"),
    jumpBack: (count) => jumpBack(count ?? 1),
    jumpForward: (count) => jumpForward(count ?? 1),
    searchStart: () => openBar("search"),
    searchNext: (count) => stepMatch(1, count ?? 1),
    searchPrev: (count) => stepMatch(-1, count ?? 1),
    searchWordForward: () => searchWord(1),
    searchWordBack: () => searchWord(-1),
    approve: () => decide("approve"),
    reject: () => setPrompt({ kind: "reject" }),
    skip: () => decide("skip"),
    undo,
    redo,
    comment: () => setPrompt({ kind: "note", initial: "" }),
    commentPr: () => {
      setVisual(null)
      setPrompt({ kind: "note", initial: "" })
    },
    visual: startVisual,
    visualDown: (count) => extendVisual(1, count ?? 1),
    visualUp: (count) => extendVisual(-1, count ?? 1),
    visualComment: () => {
      if (visual) openRangeDraft(visual.anchor, cursorIndex)
    },
    visualExit: () => setVisual(null),
    noteNext: () => {
      if ((noteFocus ?? -1) >= prNotes.length - 1) return false
      setNoteFocus((noteFocus ?? -1) + 1)
    },
    notePrev: () => {
      if (noteFocus === null) return false
      setNoteFocus(noteFocus === 0 ? null : noteFocus - 1)
    },
    noteEdit: () => {
      const focused = noteFocus === null ? undefined : prNotes[noteFocus]
      if (!focused) return false
      setPrompt({ kind: "note", noteId: focused.id, initial: focused.body })
    },
    noteDelete: () => {
      const focused = noteFocus === null ? undefined : prNotes[noteFocus]
      if (!focused) return false
      deleteNote(focused.id)
      setNoteFocus(prNotes.length > 1 ? Math.max(0, noteFocus! - 1) : null)
    },
    viewed: () => toggleViewed(),
    foldToggle: () => {
      if (cursor && model) toggleFold(model.files[cursor.file]!.name)
    },
    foldOpen: () => {
      if (cursor) setFold(cursor.file, false)
    },
    foldClose: () => {
      if (cursor) setFold(cursor.file, true)
    },
    foldOpenAll: () => setAllFolds(false),
    foldCloseAll: () => setAllFolds(true),
    palette: () => setPalette(true),
    splitToggle: () => {
      const next = diffStyle === "split" ? "unified" : "split"
      localStorage.setItem("docket.diffStyle", next)
      scrollIntent.current = "top"
      setDiffStyle(next)
    },
    whitespaceToggle: () => {
      scrollIntent.current = "top"
      setCursors((prev) => ({ ...prev, [current]: HEADER }))
      setIgnoreWhitespace((value) => !value)
    },
    openGithub: () => {
      const url = session.items[current]?.ok ? session.items[current].data.meta.url : undefined
      if (url) window.open(url, "_blank")
    },
    commandLine: () => openBar("command"),
    summary: () => {
      if (cursor && model && isCollapsed(cursor.file)) return void toggleFold(model.files[cursor.file]!.name)
      openSummary()
    },
    handBackClose: () => void handBack(),
    help: () => setHelp(true),
    cancel: () => {
      setNoteFocus(null)
      setSearch(null)
    },
    summaryNext: () => setSummaryIndex((index) => Math.min(order.length - 1, index + 1)),
    summaryPrev: () => setSummaryIndex((index) => Math.max(0, index - 1)),
    summaryOpen: () => {
      setView("deck")
      switchPr(order[summaryIndex]!)
    },
    summaryBack: () => setView("deck"),
    handBack: () => void handBack(),
  }

  /** Runs a binding; if its action declines, the key is offered to the remaining modes. */
  const run = (binding: Binding, mode: Mode, count: number | undefined, key: string, modes: Mode[]): boolean => {
    if (visual && mode === "normal") setVisual(null)
    if (actions[binding.action](count) !== false) return true
    const rest = modes.slice(modes.indexOf(mode) + 1)
    if (!rest.length) return false
    const retry = feed({ count: count === undefined ? "" : String(count), keys: [] }, key, rest)
    if (retry.kind !== "run") return false
    return run(retry.binding, retry.mode, retry.count, key, rest)
  }

  const activeModes = (): Mode[] => {
    if (view === "summary") return ["summary"]
    if (visual) return ["visual", "normal"]
    if (cursorIndex === HEADER && prNotes.length) return ["note", "normal"]
    return ["normal"]
  }

  const setPendingKeys = (next: Pending) => {
    pendingRef.current = next
    setPending(next.count + next.keys.join(""))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return
      if (event.metaKey || event.altKey) return
      if (prompt || draft || palette || bar || closed) return
      const key = keyName(event)
      if (["Shift", "Control", "Alt", "Meta"].includes(key)) return
      clearTimeout(pendingTimer.current)
      if (help) {
        event.preventDefault()
        if (key === "?" || key === "Escape" || key === "q") setHelp(false)
        return
      }
      const busy = pendingRef.current.count || pendingRef.current.keys.length
      if (key === "Escape" && busy) {
        event.preventDefault()
        return setPendingKeys(EMPTY_PENDING)
      }
      const modes = activeModes()
      const result = feed(pendingRef.current, key, modes)
      if (result.kind === "none") return setPendingKeys(EMPTY_PENDING)
      event.preventDefault()
      if (result.kind === "run") {
        setPendingKeys(EMPTY_PENDING)
        run(result.binding, result.mode, result.count, key, modes)
        return
      }
      setPendingKeys(result.pending)
      pendingTimer.current = setTimeout(() => {
        setPendingKeys(EMPTY_PENDING)
        if (result.fallback) runLatest.current(result.fallback.binding, result.fallback.mode, result.fallback.count, key, modes)
      }, result.timeout)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  // The pending-key timer fires after a re-render; it must call the newest closures.
  const runLatest = useRef(run)
  runLatest.current = run


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
  const matches = useMemo(() => (search ? findMatches(model?.rows ?? [], search) : []), [model, search])
  const matchStatus = matches.length
    ? `${searchIndex >= 0 && searchIndex < matches.length ? searchIndex + 1 : "–"}/${matches.length}  ${search?.word ? "*" : "/"}${search?.pattern}`
    : search?.pattern
      ? `0 matches  /${search.pattern}`
      : ""
  useSearchHighlights(mainRef, matches, searchIndex, model?.rows ?? [], [current, folds, diffStyle, view, ignoreWhitespace])
  const visualAnchor = visual && model ? rangeAnchor(model.rows, visual.anchor, cursorIndex) : undefined
  const visualCount = visualAnchor ? visualAnchor.line - (visualAnchor.startLine ?? visualAnchor.line) + 1 : 0
  const statusPosition = visual
    ? `VISUAL · ${visualCount} line${visualCount === 1 ? "" : "s"} · c to comment`
    : cursor && model
      ? `${model.files[cursor.file]?.name.split("/").at(-1)}:${cursor.side === "deletions" ? "L" : "R"}${cursor.line}`
      : ""

  if (handedBack) return <HandedBack path={handedBack} state={state} order={order} />
  if (closed) return <ClosedScreen />

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
          switchPr(id)
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
            switchPr(id)
            setView("deck")
          }}
        />
      ) : (
        <main className="main" ref={mainRef}>
          <div className="pr-view view-enter" key={current}>
            <PrHeader
              entry={entry}
              load={load}
              review={review}
              state={state}
              expanded={cursorIndex === HEADER}
              viewed={
                model && viewed.size
                  ? { done: model.files.filter((file) => viewed.has(file.name)).length, total: model.files.length }
                  : null
              }
            />
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
            {model?.large ? (
              <p className="large-hint">
                Large change: files start folded. <kbd>f</kbd> jump to a file · <kbd>o</kbd> unfold · <kbd>x</kbd> mark viewed
              </p>
            ) : null}
            <div className="files" key={`${current}-${ignoreWhitespace}`}>
              {model?.files.map((file, index) => (
                <FileBlock
                  key={file.name}
                  index={index}
                  file={file}
                  focus={model.focus.has(file.name)}
                  collapsed={isCollapsed(index)}
                  viewed={viewed.has(file.name)}
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
          Comment <kbd>c</kbd>
        </button>
      ) : null}
      {bar?.kind === "search" ? (
        <CommandBar prefix="/" value={bar.text} onChange={searchInput} onSubmit={submitSearch} onCancel={cancelBar} />
      ) : bar?.kind === "command" ? (
        <CommandBar prefix=":" value={bar.text} onChange={(text) => setBar({ kind: "command", text })} onSubmit={runCommand} onCancel={closeBar} />
      ) : bar?.kind === "confirm" ? (
        <CommandBar
          prefix={`Close without handing back ${reviewedCount} verdict${reviewedCount === 1 ? "" : "s"}? (y/n)`}
          value={bar.text}
          onChange={(text) => {
            closeBar()
            if (text.trim().toLowerCase().startsWith("y")) closeWithoutHandBack()
          }}
          onSubmit={closeBar}
          onCancel={closeBar}
        />
      ) : (
      <StatusBar
        order={order}
        state={state}
        position={view === "deck" ? statusPosition : ""}
        pending={pending}
        matches={search && view === "deck" ? matchStatus : ""}
        mode={[diffStyle === "unified" ? "unified" : "", ignoreWhitespace ? "ignoring whitespace" : ""].filter(Boolean).join(" · ")}
        message={message?.text ?? ""}
      />
      )}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
      {palette && model ? (
        <FilePalette
          files={model.files.map((file) => ({
            name: file.name,
            additions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
            deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
          }))}
          viewed={viewed}
          onClose={() => setPalette(false)}
          onPick={(index) => {
            setPalette(false)
            recordJump()
            if (isCollapsed(index)) setFold(index, false)
            jumpToFile(index)
          }}
        />
      ) : null}
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

function ClosedScreen() {
  return (
    <div className="splash view-enter">
      <div className="handed-back">
        <h1>Closed without handing back</h1>
        <p className="muted">Your progress is saved. You can close this tab.</p>
      </div>
    </div>
  )
}
