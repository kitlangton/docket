import { useEffect, useRef, useState, type RefObject } from "react"
import { mediaUrl, type PickMedia, type PickPosition } from "../src/types"
import { Markdown } from "./markdown"

export type Theme = "light" | "dark"
export type Pin = { n: number; x: number; y: number }

/** Shared across every video on screen, so flipping options keeps the same moment. */
export type Playback = { time: RefObject<number>; playing: boolean }

export function sourceOf(media: PickMedia, theme: Theme) {
  return theme === "dark" && media.dark ? media.dark : media.src
}

/** One media item, as large as its box allows. Images take pins; videos follow the shared playback. */
export function MediaView(props: {
  session: string
  base: string
  media: PickMedia
  theme: Theme
  playback: Playback
  pins?: Pin[]
  armed?: boolean
  onPin?: (at: PickPosition, touch: boolean) => void
}) {
  const src = sourceOf(props.media, props.theme)
  const url = props.media.kind === "url" ? src : mediaUrl(props.session, src)
  if (props.media.kind === "image") return <ImageView url={url} pins={props.pins ?? []} armed={props.armed} onPin={props.onPin} />
  if (props.media.kind === "video") return <VideoView key={url} url={url} playback={props.playback} />
  if (props.media.kind === "text") return <TextView url={url} />
  return <FrameView url={url} live={props.media.kind === "url"} base={props.base} />
}

function ImageView(props: { url: string; pins: Pin[]; armed?: boolean; onPin?: (at: PickPosition, touch: boolean) => void }) {
  const pointer = useRef("mouse")
  // The frame takes the image's shape at the largest size that fits, so pins (fractions of it) stay on the image.
  const [ratio, setRatio] = useState<number>()
  return (
    <div
      className={`pick-frame${props.armed ? " is-armed" : ""}`}
      style={ratio ? { aspectRatio: ratio, width: `min(100cqw, ${ratio} * 100cqh)` } : undefined}
    >
      <img
        src={props.url}
        onLoad={(event) => setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)}
        alt=""
        draggable={false}
        onPointerDown={(event) => {
          pointer.current = event.pointerType
        }}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
          const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
          props.onPin?.({ x: round(x), y: round(y) }, pointer.current === "touch")
        }}
      />
      {props.pins.map((pin) => (
        <span key={pin.n} className="pick-pin" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}>
          {pin.n}
        </span>
      ))}
    </div>
  )
}

function VideoView(props: { url: string; playback: Playback }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [progress, setProgress] = useState({ time: 0, duration: 0 })
  const { playing, time } = props.playback
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [playing])
  return (
    <div className="pick-video">
      <video
        ref={ref}
        src={props.url}
        muted
        loop
        playsInline
        autoPlay={playing}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          if (video.duration) video.currentTime = (time.current ?? 0) % video.duration
          setProgress({ time: video.currentTime, duration: video.duration })
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget
          time.current = video.currentTime
          setProgress({ time: video.currentTime, duration: video.duration })
        }}
      />
      <input
        className="pick-scrub"
        type="range"
        min={0}
        max={progress.duration || 0}
        step={0.05}
        value={progress.time}
        onChange={(event) => {
          const video = ref.current
          if (!video) return
          video.currentTime = Number(event.target.value)
          time.current = video.currentTime
        }}
      />
    </div>
  )
}

function TextView(props: { url: string }) {
  const [text, setText] = useState<string>()
  useEffect(() => {
    fetch(props.url).then(async (res) => setText(res.ok ? await res.text() : ""))
  }, [props.url])
  return <div className="pick-text">{text === undefined ? null : <Markdown source={text} />}</div>
}

/** A live URL or local prototype. Live pages that refuse framing get only the open link. */
function FrameView(props: { url: string; live: boolean; base: string }) {
  const [frameable, setFrameable] = useState(true)
  useEffect(() => {
    if (!props.live) return
    fetch(`${props.base}/frame?url=${encodeURIComponent(props.url)}`)
      .then((res) => (res.ok ? res.json() : { frameable: true }))
      .then((body: { frameable: boolean }) => setFrameable(body.frameable))
  }, [props.url, props.live, props.base])
  return (
    <div className="pick-page">
      {frameable ? (
        <iframe src={props.url} title={props.url} />
      ) : (
        <div className="pick-unframeable">{new URL(props.url, location.href).host}</div>
      )}
      <a className="pick-open" href={props.url} target="_blank" rel="noreferrer" title="Open in a new tab">
        Open
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
          <path d="M4 2.5h5.5V8M9.5 2.5L3 9" />
        </svg>
      </a>
    </div>
  )
}

/** A grid card's preview: small, quiet, and never interactive. */
export function Thumb(props: { session: string; media?: PickMedia; body?: string; theme: Theme }) {
  const media = props.media
  if (!media) return <div className="pick-thumb is-text">{props.body ? <Markdown source={props.body} /> : null}</div>
  const src = sourceOf(media, props.theme)
  const url = media.kind === "url" ? src : mediaUrl(props.session, src)
  if (media.kind === "image") return <img className="pick-thumb" src={url} alt="" draggable={false} />
  if (media.kind === "video") return <video className="pick-thumb" src={url} muted loop autoPlay playsInline />
  if (media.kind === "page") return <iframe className="pick-thumb is-page" src={url} title={media.label} tabIndex={-1} />
  if (media.kind === "url") return <div className="pick-thumb is-text">{new URL(url).host}</div>
  return <div className="pick-thumb is-text">{media.label}</div>
}

export function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}
