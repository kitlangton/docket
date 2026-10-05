import { useCallback, useEffect, useRef, useState, type RefObject, type TouchEvent } from "react"
import type { PickNote, PickOption, PickPayload, PickPosition, PickState } from "../src/types"
import { feed, keyName, type Action, type Pending } from "./keymap"
import { Markdown } from "./markdown"
import { formatTime, MediaView, Thumb, type Pin, type Playback, type Theme } from "./pick-media"
import { CommandBar, Help, Prompt } from "./views"

type View = "flip" | "grid" | "side"
type NotePrompt = { kind: "note"; option: string; media: number; at?: PickPosition; noteId?: string; initial: string }
type PromptState = NotePrompt | { kind: "overall" }

const EMPTY_PENDING: Pending = { count: "", keys: [] }

/** A pick session: flip through options, compare, pick in rank order, leave notes, submit. */
export function PickDeck(props: {
  payload: PickPayload
  initial: PickState
  base: string
  flush: RefObject<() => void>
  onHome: () => void
}) {
  const { pick, id: session } = props.payload
  const options = pick.options
  const [state, setState] = useState<PickState>(() => ({ ...props.initial, current: Math.min(props.initial.current, options.length - 1) }))
  const [view, setView] = useState<View>("flip")
  const [mediaIndex, setMediaIndex] = useState<Record<string, number>>({})
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem("docket.pickTheme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"
      ? "dark"
      : "light",
  )
  const [baseline, setBaseline] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [armed, setArmed] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [bar, setBar] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const [answered, setAnswered] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string } | null>(null)
  const [pending, setPending] = useState("")
  const pendingRef = useRef<Pending>(EMPTY_PENDING)
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const time = useRef(0)
  const playback: Playback = { time, playing }

  const option = options[state.current]!
  const index = Math.min(mediaIndex[option.id] ?? 0, Math.max(0, option.media.length - 1))
  const media = option.media[index]
  const say = (text: string) => setMessage({ text })

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 2000)
    return () => clearTimeout(timer)
  }, [message])
  useEffect(() => {
    document.title = `docket · ${pick.title}`
  }, [pick.title])

  // Persist shortly after each change, and at once when leaving or when the server restarts.
  const unsaved = useRef<PickState | null>(null)
  const save = useCallback(() => {
    const next = unsaved.current
    unsaved.current = null
    if (next) fetch(`${props.base}/state`, { method: "PUT", body: JSON.stringify(next), keepalive: true })
  }, [props.base])
  const firstSave = useRef(true)
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false
      return
    }
    unsaved.current = state
    const timer = setTimeout(save, 250)
    return () => clearTimeout(timer)
  }, [state, save])
  useEffect(() => {
    props.flush.current = save
    window.addEventListener("pagehide", save)
    return () => {
      window.removeEventListener("pagehide", save)
      save()
    }
  }, [save, props.flush])

  const goTo = (next: number) => {
    setArmed(false)
    setState((prev) => ({ ...prev, current: (next + options.length) % options.length }))
  }
  const step = (delta: number) => goTo(state.current + delta)
  const stepMedia = (delta: number) => {
    if (option.media.length < 2) return say("One media item")
    setMediaIndex((prev) => ({ ...prev, [option.id]: (index + delta + option.media.length) % option.media.length }))
  }
  const togglePick = (id: string) =>
    setState((prev) => ({
      ...prev,
      none: false,
      picked: prev.picked.includes(id) ? prev.picked.filter((item) => item !== id) : [...prev.picked, id],
    }))
  const toggleNone = () => {
    const none = !state.none
    setState((prev) => ({ ...prev, none, picked: none ? [] : prev.picked }))
    if (none) setPrompt({ kind: "overall" })
  }
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark"
    localStorage.setItem("docket.pickTheme", next)
    setTheme(next)
  }

  /** `c`: arms a pin on an image (a second `c` skips the pin), stamps a video's time, or just opens the note. */
  const startNote = () => {
    if (view === "flip" && media?.kind === "image" && !armed) {
      setArmed(true)
      return say("Click to pin")
    }
    setArmed(false)
    const at = view === "flip" && media?.kind === "video" ? { t: Math.round(time.current * 10) / 10 } : undefined
    setPrompt({ kind: "note", option: option.id, media: index, at, initial: "" })
  }
  const pinAt = (at: PickPosition, touch: boolean) => {
    // On a phone a tap goes fullscreen unless a note is armed; with a mouse, a click pins.
    if (touch && !armed) return setImmersive((value) => !value)
    setArmed(false)
    setPrompt({ kind: "note", option: option.id, media: index, at, initial: "" })
  }
  const saveNote = (target: NotePrompt, body: string) =>
    setState((prev) => {
      const others = prev.notes.filter((note) => note.id !== target.noteId)
      if (!body) return { ...prev, notes: others }
      const note: PickNote = {
        id: target.noteId ?? crypto.randomUUID(),
        option: target.option,
        body,
        media: target.media,
        ...(target.at ? { at: target.at } : {}),
      }
      return { ...prev, notes: target.noteId ? prev.notes.map((item) => (item.id === target.noteId ? note : item)) : [...others, note] }
    })
  const editNote = (note: PickNote) =>
    setPrompt({ kind: "note", option: note.option, media: note.media, at: note.at, noteId: note.id, initial: note.body })

  const submit = async () => {
    const res = await fetch(`${props.base}/handback`, { method: "POST", body: JSON.stringify(state) })
    if (!res.ok) return say("Couldn't submit")
    const body: { path: string } = await res.json()
    setAnswered(body.path)
  }
  const close = async () => {
    await fetch(`${props.base}/close`, { method: "POST", body: JSON.stringify(state) })
    props.onHome()
  }
  const runCommand = (text: string) => {
    setBar(null)
    const command = text.trim()
    if (command === "w" || command === "wq" || command === "x") return void submit()
    if (command === "q" || command === "q!") return void close()
    if (command) say(`Not a command: ${command}`)
  }

  const actions: Partial<Record<Action, (key: string) => void>> = {
    pickPrev: () => step(-1),
    pickNext: () => step(1),
    pickJump: (key) => {
      const target = Number(key) - 1
      if (target < options.length) goTo(target)
      if (view === "grid") setView("flip")
    },
    pickMediaNext: () => stepMedia(1),
    pickMediaPrev: () => stepMedia(-1),
    pickGrid: () => setView(view === "grid" ? "flip" : "grid"),
    pickOpen: () => setView("flip"),
    pickSide: () => {
      if (options.length < 2) return say("Only one option")
      setView(view === "side" ? "flip" : "side")
    },
    pickTheme: toggleTheme,
    pickBaseline: () => {
      if (!pick.baseline) return say("No baseline")
      setBaseline(true)
    },
    pickPlay: () => setPlaying((value) => !value),
    pickToggle: () => togglePick(option.id),
    pickNote: startNote,
    pickOverall: () => setPrompt({ kind: "overall" }),
    pickNone: toggleNone,
    pickCommand: () => setBar(""),
    pickSubmit: () => void submit(),
    pickBack: () => {
      if (armed) return setArmed(false)
      if (immersive) return setImmersive(false)
      setView("flip")
    },
    help: () => setHelp(true),
  }

  const setPendingKeys = (next: Pending) => {
    pendingRef.current = next
    setPending(next.count + next.keys.join(""))
  }
  const runKey = (action: Action, key: string) => actions[action]?.(key)
  const runLatest = useRef(runKey)
  runLatest.current = runKey

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
      if (event.metaKey || event.altKey || prompt || bar !== null || answered) return
      const key = keyName(event)
      if (["Shift", "Control", "Alt", "Meta"].includes(key)) return
      clearTimeout(pendingTimer.current)
      if (help) {
        event.preventDefault()
        if (key === "?" || key === "Escape" || key === "q") setHelp(false)
        return
      }
      const result = feed(pendingRef.current, key, [view === "grid" ? "grid" : "pick"])
      if (result.kind === "none") return setPendingKeys(EMPTY_PENDING)
      event.preventDefault()
      if (result.kind === "run") {
        setPendingKeys(EMPTY_PENDING)
        if (!event.repeat || result.binding.action !== "pickBaseline") runKey(result.binding.action, key)
        return
      }
      setPendingKeys(result.pending)
      pendingTimer.current = setTimeout(() => {
        setPendingKeys(EMPTY_PENDING)
        if (result.fallback) runLatest.current(result.fallback.binding.action, key)
      }, result.timeout)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "b") setBaseline(false)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKeyUp)
    }
  })

  // Swipes flip options on a phone.
  const touch = useRef<{ x: number; y: number } | null>(null)
  const swipe = {
    onTouchStart: (event: TouchEvent) => {
      const point = event.touches[0]
      touch.current = point ? { x: point.clientX, y: point.clientY } : null
    },
    onTouchEnd: (event: TouchEvent) => {
      const start = touch.current
      const point = event.changedTouches[0]
      touch.current = null
      if (!start || !point) return
      const dx = point.clientX - start.x
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(point.clientY - start.y) * 1.5) step(dx < 0 ? 1 : -1)
    },
  }

  if (answered) return <Answered path={answered} state={state} onHome={props.onHome} />

  const rank = (id: string) => state.picked.indexOf(id) + 1
  const optionNotes = (id: string) => state.notes.filter((note) => note.option === id)
  const pinsFor = (target: PickOption, at: number): Pin[] =>
    optionNotes(target.id).flatMap((note, n) => (note.media === at && note.at && "x" in note.at ? [{ n: n + 1, ...note.at }] : []))
  const shown = baseline && pick.baseline ? pick.baseline : media

  const stage = (target: PickOption, at: number, primary: boolean) => {
    const item = primary ? shown : target.media[at]
    return (
      <div className="pick-stage-item">
        {item ? (
          <div className="pick-media">
            <MediaView
              session={session}
              base={props.base}
              media={item}
              theme={theme}
              playback={playback}
              pins={baseline && primary ? [] : pinsFor(target, at)}
              armed={primary && armed}
              onPin={primary && !baseline ? pinAt : undefined}
            />
          </div>
        ) : null}
        {target.body && (!item || item.kind !== "text") ? <Markdown source={target.body} className="pick-body" /> : null}
      </div>
    )
  }

  return (
    <div className={`pick${immersive ? " is-immersive" : ""}`}>
      <header className="pick-head">
        <button className="rail-home" onMouseDown={(event) => event.preventDefault()} onClick={props.onHome} title="Inbox">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M7.5 2.5L4 6l3.5 3.5" />
          </svg>
        </button>
        <div className="pick-title">
          <h1>{pick.title}</h1>
          {pick.question ? <Markdown source={pick.question} className="pick-question" /> : null}
        </div>
        <nav className="pick-strip">
          {options.map((item, at) => (
            <button
              key={item.id}
              className={`pick-tab${at === state.current ? " is-current" : ""}${rank(item.id) ? " is-picked" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => goTo(at)}
              title={item.label}
            >
              {item.id}
              {rank(item.id) ? <span className="pick-rank">{rank(item.id)}</span> : null}
            </button>
          ))}
        </nav>
        <button className="pick-submit" onMouseDown={(event) => event.preventDefault()} onClick={() => void submit()}>
          Submit
        </button>
      </header>
      {pick.previous ? <Previous previous={pick.previous} /> : null}

      {view === "grid" ? (
        <div className="pick-grid">
          {options.map((item, at) => (
            <button
              key={item.id}
              className={`pick-card${at === state.current ? " is-current" : ""}`}
              onClick={() => {
                goTo(at)
                setView("flip")
              }}
            >
              <Thumb session={session} media={item.media[0]} body={item.body} theme={theme} />
              <span className="pick-card-label">
                <span className="pick-id">{item.id}</span>
                {item.label}
                {rank(item.id) ? <span className="pick-rank">{rank(item.id)}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : view === "side" ? (
        <div className="pick-side" {...swipe}>
          {[option, options[(state.current + 1) % options.length]!].map((item, at) => (
            <section key={item.id} className="pick-side-pane">
              <div className="pick-side-label">
                <span className="pick-id">{item.id}</span>
                {item.label}
                {rank(item.id) ? <span className="pick-rank">{rank(item.id)}</span> : null}
              </div>
              {stage(item, at === 0 ? index : 0, at === 0)}
            </section>
          ))}
        </div>
      ) : (
        <div className="pick-stage" {...swipe}>
          {stage(option, index, true)}
        </div>
      )}

      {view === "grid" ? null : (
        <div className="pick-caption">
          <span className="pick-id">{baseline ? "Before" : option.id}</span>
          <span className="pick-label">{baseline ? (pick.baseline?.label ?? "") : option.label}</span>
          {option.media.length > 1 ? (
            <span className="pick-dots" aria-label={`${index + 1} of ${option.media.length}`}>
              {option.media.map((item, at) => (
                <span key={at} className={at === index ? "is-current" : undefined} title={item.label} />
              ))}
            </span>
          ) : null}
          {option.why ? <Markdown source={option.why} className="pick-why" /> : null}
          {optionNotes(option.id).length ? (
            <ol className="pick-notes">
              {optionNotes(option.id).map((note) => (
                <li key={note.id} onClick={() => editNote(note)}>
                  {note.at && "t" in note.at ? <span className="pick-note-at">{formatTime(note.at.t)}</span> : null}
                  {note.body}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}

      <div className="pick-actions">
        <button className={rank(option.id) ? "is-on" : undefined} onClick={() => togglePick(option.id)}>
          {rank(option.id) ? `Picked ${rank(option.id)}` : "Pick"}
        </button>
        <button className={armed ? "is-on" : undefined} onClick={startNote}>
          Note
        </button>
        {pick.baseline ? (
          <button
            onPointerDown={() => setBaseline(true)}
            onPointerUp={() => setBaseline(false)}
            onPointerLeave={() => setBaseline(false)}
            onContextMenu={(event) => event.preventDefault()}
          >
            Before
          </button>
        ) : null}
        <button className="pick-actions-submit" onClick={() => void submit()}>
          Submit
        </button>
      </div>

      {bar !== null ? (
        <CommandBar prefix=":" value={bar} onChange={setBar} onSubmit={runCommand} onCancel={() => setBar(null)} />
      ) : (
        <footer className="status">
          <span className="status-left">
            <span className="hint">
              <kbd>?</kbd> keys
            </span>
            {state.none ? <span className="muted">none of these</span> : null}
            {theme === "dark" ? <span className="muted">dark</span> : null}
            {message ? <span className="status-message">{message.text}</span> : null}
          </span>
          {pending ? <span className="status-pending">{pending}</span> : null}
          <span className="status-right tabular">{state.picked.length ? `${state.picked.length} picked` : ""}</span>
        </footer>
      )}
      {help ? <Help onClose={() => setHelp(false)} groups={["Pick"]} /> : null}
      {prompt?.kind === "note" ? (
        <Prompt
          title={`Note · ${prompt.option}${prompt.at ? ("t" in prompt.at ? ` · ${formatTime(prompt.at.t)}` : " · pin") : ""}`}
          placeholder=""
          initial={prompt.initial}
          multiline
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => {
            setPrompt(null)
            saveNote(prompt, value.trim())
          }}
        />
      ) : prompt?.kind === "overall" ? (
        <Prompt
          title={state.none ? "None of these" : "Note"}
          placeholder=""
          initial={state.note}
          multiline
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => {
            setPrompt(null)
            setState((prev) => ({ ...prev, note: value.trim() }))
          }}
        />
      ) : null}
    </div>
  )
}

/** The prior round's answer, collapsed to one line until opened. */
function Previous(props: { previous: NonNullable<PickPayload["pick"]["previous"]> }) {
  const previous = props.previous
  return (
    <details className="pick-previous">
      <summary>
        Previous · {previous.none ? "none" : previous.picked.join(" · ") || "no pick"}
        {previous.note ? ` · ${previous.note.split("\n")[0]}` : ""}
      </summary>
      <ul>
        {previous.notes.map((note, at) => (
          <li key={at}>
            <span className="pick-id">{note.option}</span>
            {note.body}
          </li>
        ))}
      </ul>
    </details>
  )
}

function Answered(props: { path: string; state: PickState; onHome: () => void }) {
  return (
    <div className="splash view-enter">
      <div className="handed-back">
        <svg className="handed-back-mark" width="40" height="40" viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r="19" />
          <path d="M13 20.5l4.8 4.8L27.5 15" />
        </svg>
        <h1>Answered</h1>
        <p className="tabular">{props.state.none ? "None of these" : props.state.picked.join(" · ") || "No pick"}</p>
        <p className="handed-back-path">{props.path}</p>
        <button className="link-button" onMouseDown={(event) => event.preventDefault()} onClick={props.onHome}>
          Inbox
        </button>
      </div>
    </div>
  )
}
