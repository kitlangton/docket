import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type TouchEvent } from "react"
import type { PickAnswer, PickNote, PickOption, PickPayload, PickPosition, PickState } from "../src/types"
import { feed, keyName, type Action, type Pending } from "./keymap"
import { Markdown } from "./markdown"
import { CardMedia, formatTime, MediaView, type Pin, type Playback, type Theme } from "./pick-media"
import { CommandBar, Help, Prompt } from "./views"

type View = "grid" | "flip"
type NotePrompt = { option: string; media: number; at?: PickPosition; noteId?: string; initial: string }

const EMPTY_PENDING: Pending = { count: "", keys: [] }

/**
 * A pick session: a grid of option cards (flip view for one option at a time), a Dark/Light switch for the stills,
 * Pick on each card, and a bottom bar with the overall notes and Send.
 */
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
  const [view, setView] = useState<View>("grid")
  const [mediaIndex, setMediaIndex] = useState<Record<string, number>>({})
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem("docket.pickTheme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"
      ? "dark"
      : "light",
  )
  const [baseline, setBaseline] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [armed, setArmed] = useState(false)
  const [prompt, setPrompt] = useState<NotePrompt | null>(null)
  const [bar, setBar] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const [sent, setSent] = useState(false)
  const [keyboard, setKeyboard] = useState(false)
  const [message, setMessage] = useState<{ text: string } | null>(null)
  const pendingRef = useRef<Pending>(EMPTY_PENDING)
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const time = useRef(0)
  const playback: Playback = { time, playing }

  const answer: PickAnswer | undefined = props.payload.answer
  const picked = answer ? answer.picked : state.none ? [] : state.picked
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

  // The focused card stays in view as the focus ring moves.
  useEffect(() => {
    if (view === "grid" && keyboard) gridRef.current?.querySelector(".pick-card.is-focused")?.scrollIntoView({ block: "nearest" })
  }, [state.current, view, keyboard])

  const focus = (next: number) => {
    setArmed(false)
    setState((prev) => ({ ...prev, current: (next + options.length) % options.length }))
  }
  const open = (at: number, item = 0) => {
    focus(at)
    setMediaIndex((prev) => ({ ...prev, [options[at]!.id]: item }))
    setView("flip")
    window.scrollTo({ top: 0 })
  }
  // Rows in the grid: how many cards sit side by side right now.
  const columns = () => {
    const template = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns : ""
    return Math.max(1, template.split(" ").filter(Boolean).length)
  }
  const stepMedia = (delta: number) => {
    if (option.media.length < 2) return
    setMediaIndex((prev) => ({ ...prev, [option.id]: (index + delta + option.media.length) % option.media.length }))
  }
  const togglePick = (id: string) => {
    if (answer) return
    setState((prev) => {
      const has = prev.picked.includes(id)
      const next = pick.many ? (has ? prev.picked.filter((item) => item !== id) : [...prev.picked, id]) : has ? [] : [id]
      return { ...prev, none: false, picked: next }
    })
  }
  const toggleNone = () => {
    if (answer) return
    const none = !state.none
    setState((prev) => ({ ...prev, none, picked: none ? [] : prev.picked }))
    if (none) notesRef.current?.focus()
  }
  const toggleTheme = (next: Theme = theme === "dark" ? "light" : "dark") => {
    localStorage.setItem("docket.pickTheme", next)
    setTheme(next)
  }

  /** `c`: on a card or a still in flip view, arms a pin (a second `c` skips it); on a video, stamps the time. */
  const startNote = () => {
    const stills = view === "flip" ? media?.kind === "image" : option.media.some((item) => item.kind === "image")
    if (stills && !armed) {
      setArmed(true)
      return say("Click a still to pin")
    }
    setArmed(false)
    const at = view === "flip" && media?.kind === "video" ? { t: Math.round(time.current * 10) / 10 } : undefined
    setPrompt({ option: option.id, media: view === "flip" ? index : 0, at, initial: "" })
  }
  const pinAt = (target: PickOption, item: number, at: PickPosition) => {
    setArmed(false)
    setPrompt({ option: target.id, media: item, at, initial: "" })
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
    setPrompt({ option: note.option, media: note.media, at: note.at, noteId: note.id, initial: note.body })

  const canSend = !answer && (picked.length > 0 || state.none || state.note.trim().length > 0)
  const submit = async () => {
    if (!canSend) return say(answer ? "Already sent" : "Pick an option or write a note")
    const res = await fetch(`${props.base}/handback`, { method: "POST", body: JSON.stringify(state) })
    if (!res.ok) return say("Couldn't send")
    setSent(true)
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
    pickPrev: () => focus(state.current - 1),
    pickNext: () => focus(state.current + 1),
    pickUp: () => focus(Math.max(0, state.current - columns())),
    pickDown: () => focus(Math.min(options.length - 1, state.current + columns())),
    pickOpen: () => open(state.current, index),
    pickJump: (key) => {
      const target = Number(key) - 1
      if (target < options.length) open(target)
    },
    pickMediaNext: () => stepMedia(1),
    pickMediaPrev: () => stepMedia(-1),
    pickBack: () => {
      if (armed) return setArmed(false)
      setView("grid")
    },
    pickToggle: () => togglePick(option.id),
    pickTheme: () => toggleTheme(),
    pickBaseline: () => {
      if (!pick.baseline) return say("No baseline")
      setBaseline(true)
    },
    pickPlay: () => setPlaying((value) => !value),
    pickNote: startNote,
    pickOverall: () => notesRef.current?.focus(),
    pickNone: toggleNone,
    pickCommand: () => setBar(""),
    pickSubmit: () => void submit(),
    help: () => setHelp(true),
  }
  const runKey = (action: Action, key: string) => actions[action]?.(key)
  const runLatest = useRef(runKey)
  runLatest.current = runKey

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
        if (event.key === "Escape") (event.target as HTMLElement).blur()
        return
      }
      if (event.metaKey || event.altKey || prompt || bar !== null) return
      const key = keyName(event)
      if (["Shift", "Control", "Alt", "Meta"].includes(key)) return
      clearTimeout(pendingTimer.current)
      setKeyboard(true)
      if (help) {
        event.preventDefault()
        if (key === "?" || key === "Escape" || key === "q") setHelp(false)
        return
      }
      const result = feed(pendingRef.current, key, [view])
      if (result.kind === "none") {
        pendingRef.current = EMPTY_PENDING
        return
      }
      event.preventDefault()
      if (result.kind === "run") {
        pendingRef.current = EMPTY_PENDING
        if (!event.repeat || result.binding.action !== "pickBaseline") runKey(result.binding.action, key)
        return
      }
      pendingRef.current = result.pending
      pendingTimer.current = setTimeout(() => {
        pendingRef.current = EMPTY_PENDING
        if (result.fallback) runLatest.current(result.fallback.binding.action, key)
      }, result.timeout)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "b") setBaseline(false)
    }
    const onPointer = () => setKeyboard(false)
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("pointerdown", onPointer)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("pointerdown", onPointer)
    }
  })

  // Swipes flip options in the flip view on a phone.
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
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(point.clientY - start.y) * 1.5) focus(state.current + (dx < 0 ? 1 : -1))
    },
  }

  const rank = (id: string) => picked.indexOf(id) + 1
  const optionNotes = (id: string) => state.notes.filter((note) => note.option === id)
  const pinsFor = (target: PickOption, at: number): Pin[] =>
    optionNotes(target.id).flatMap((note, n) => (note.media === at && note.at && "x" in note.at ? [{ n: n + 1, ...note.at }] : []))

  const pickButton = (target: PickOption) => (
    <button
      className={`pick-button${rank(target.id) ? " is-on" : ""}`}
      disabled={Boolean(answer)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => togglePick(target.id)}
    >
      {pick.many && rank(target.id) ? `Pick ${rank(target.id)}` : "Pick"}
    </button>
  )
  const noteButton = (target: PickOption, at: number) => (
    <button
      className={`pick-note-button${armed && option.id === target.id ? " is-on" : ""}`}
      title="Note"
      aria-label="Note"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        focus(at)
        if (target.media.some((item) => item.kind === "image") && !(armed && option.id === target.id)) {
          setArmed(true)
          return say("Click a still to pin")
        }
        setArmed(false)
        setPrompt({ option: target.id, media: 0, initial: "" })
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <path d="M2.5 3.5h9v6h-5l-3 2.5v-2.5h-1z" />
      </svg>
    </button>
  )
  const notesList = (target: PickOption) =>
    optionNotes(target.id).length ? (
      <ol className="pick-notes">
        {optionNotes(target.id).map((note) => (
          <li key={note.id} onClick={() => editNote(note)}>
            {note.at && "t" in note.at ? <span className="pick-note-at">{formatTime(note.at.t)}</span> : null}
            {note.body}
          </li>
        ))}
      </ol>
    ) : null

  return (
    <div className={`pick is-${view}`}>
      <div className="pick-page-inner">
        <header className="pick-top">
          {view === "flip" ? (
            <button className="pick-back" onClick={() => setView("grid")} aria-label="Back to the grid">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path d="M7.5 2.5L4 6l3.5 3.5" />
              </svg>
            </button>
          ) : null}
          <h1>{view === "flip" ? `${option.id} · ${option.label}` : pick.title}</h1>
          {view === "flip" ? (
            <span className="pick-top-actions">
              {noteButton(option, state.current)}
              {pickButton(option)}
            </span>
          ) : null}
        </header>
        {view === "grid" && pick.question ? <Markdown source={pick.question} className="pick-question" /> : null}
        {view === "grid" && pick.previous ? <Previous previous={pick.previous} /> : null}
        <div className="seg" role="tablist">
          {(["dark", "light"] as const).map((scheme) => (
            <button
              key={scheme}
              role="tab"
              aria-selected={theme === scheme}
              className={theme === scheme ? "on" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggleTheme(scheme)}
            >
              {scheme === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>

        {view === "grid" ? (
          <div className="pick-options" ref={gridRef}>
            {options.map((item, at) => (
              <section
                key={item.id}
                className={`pick-card${rank(item.id) ? " is-picked" : ""}${at === state.current && keyboard ? " is-focused" : ""}`}
                onPointerDown={() => {
                  if (at !== state.current) focus(at)
                }}
              >
                <header>
                  <h2>
                    {item.id} · {item.label}
                  </h2>
                  <span className="pick-card-actions">
                    {noteButton(item, at)}
                    {pickButton(item)}
                  </span>
                </header>
                {item.why ? <Markdown source={item.why} className="pick-why" /> : null}
                {baseline && at === state.current && pick.baseline ? (
                  <CardMedia
                    session={session}
                    base={props.base}
                    media={[pick.baseline]}
                    theme={theme}
                    playing={playing}
                    pins={() => []}
                    armed={false}
                    onPin={() => {}}
                    onOpen={() => {}}
                  />
                ) : (
                  <CardMedia
                    session={session}
                    base={props.base}
                    media={item.media}
                    theme={theme}
                    playing={playing}
                    pins={(media) => pinsFor(item, media)}
                    armed={armed && at === state.current}
                    onPin={(media, position) => pinAt(item, media, position)}
                    onOpen={(media) => open(at, media)}
                  />
                )}
                {item.body ? <Markdown source={item.body} className="pick-body" /> : null}
                {notesList(item)}
              </section>
            ))}
          </div>
        ) : (
          <div className="pick-flip" {...swipe}>
            {option.why ? <Markdown source={option.why} className="pick-why" /> : null}
            <div className="pick-stage">
              {(baseline && pick.baseline) || media ? (
                <MediaView
                  session={session}
                  base={props.base}
                  media={baseline && pick.baseline ? pick.baseline : media!}
                  theme={theme}
                  playback={playback}
                  pins={baseline ? [] : pinsFor(option, index)}
                  armed={armed}
                  onPin={baseline ? undefined : (at, touched) => (armed || !touched ? pinAt(option, index, at) : undefined)}
                />
              ) : null}
              {option.body && !media ? <Markdown source={option.body} className="pick-body" /> : null}
            </div>
            {option.media.length > 1 ? (
              <span className="pick-dots" aria-label={`${index + 1} of ${option.media.length}`}>
                {option.media.map((item, at) => (
                  <button
                    key={at}
                    className={at === index ? "is-current" : undefined}
                    title={item.label}
                    onClick={() => setMediaIndex((prev) => ({ ...prev, [option.id]: at }))}
                  />
                ))}
              </span>
            ) : null}
            {notesList(option)}
          </div>
        )}
      </div>

      {message ? <div className="pick-toast">{message.text}</div> : null}
      {bar !== null ? (
        <div className="pick-bar">
          <CommandBar prefix=":" value={bar} onChange={setBar} onSubmit={runCommand} onCancel={() => setBar(null)} />
        </div>
      ) : (
        <form
          className="pick-bar"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {answer ? (
            <p className="pick-done">{sent ? "Sent." : `Answered · ${answer.none ? "None" : answer.picked.join(", ") || "No pick"}`}</p>
          ) : (
            <>
              <AutoGrow
                inputRef={notesRef}
                value={state.note}
                placeholder={state.none ? "None of these" : "Notes"}
                onChange={(note) => setState((prev) => ({ ...prev, note }))}
              />
              <button className="pick-send" type="submit" disabled={!canSend}>
                Send
              </button>
            </>
          )}
        </form>
      )}
      {help ? <Help onClose={() => setHelp(false)} groups={["Pick"]} /> : null}
      {prompt ? (
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
      ) : null}
    </div>
  )
}

/** The overall notes field: one line that grows with its text, up to a third of the screen. */
function AutoGrow(props: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  useLayoutEffect(() => {
    const input = props.inputRef.current
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${input.scrollHeight}px`
  }, [props.value, props.inputRef])
  return (
    <textarea
      ref={props.inputRef}
      rows={1}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.target.value)}
    />
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
