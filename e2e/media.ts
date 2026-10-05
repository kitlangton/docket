import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { deflateSync } from "node:zlib"

/** A solid PNG with a darker band across the middle, so pins and screenshots have something to land on. */
export function png(width: number, height: number, [r, g, b]: [number, number, number]) {
  const row = (y: number) => {
    const band = y > height * 0.4 && y < height * 0.6
    const pixel = band ? [r * 0.6, g * 0.6, b * 0.6] : [r, g, b]
    return [0, ...Array.from({ length: width }, () => pixel).flat()]
  }
  const raw = Uint8Array.from(Array.from({ length: height }, (_, y) => row(y)).flat())
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data])
    const out = new DataView(new ArrayBuffer(12 + data.length))
    out.setUint32(0, data.length)
    new Uint8Array(out.buffer).set(body, 4)
    out.setUint32(8 + data.length, Bun.hash.crc32(body))
    return new Uint8Array(out.buffer)
  }
  const header = new DataView(new ArrayBuffer(13))
  header.setUint32(0, width)
  header.setUint32(4, height)
  header.setUint8(8, 8)
  header.setUint8(9, 2)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", new Uint8Array(header.buffer)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ])
}

/** A two-second test video, or undefined without ffmpeg. */
export async function video(path: string, color: string) {
  if (!Bun.which("ffmpeg")) return undefined
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x200:d=2,format=yuv420p`,
      "-movflags",
      "+faststart",
      path,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  return (await proc.exited) === 0 ? path : undefined
}

/**
 * A pick folder: three image options (light/dark pairs on A), a local prototype, a video option when ffmpeg is
 * available, and a baseline. Returns the manifest path.
 */
export async function makePick(dir: string, extra: Record<string, unknown> = {}) {
  await mkdir(join(dir, "proto"), { recursive: true })
  await Promise.all([
    Bun.write(join(dir, "a-light.png"), png(320, 200, [230, 236, 250])),
    Bun.write(join(dir, "a-dark.png"), png(320, 200, [30, 34, 48])),
    Bun.write(join(dir, "b.png"), png(320, 200, [240, 200, 200])),
    Bun.write(join(dir, "b-detail.png"), png(200, 320, [200, 240, 200])),
    Bun.write(join(dir, "current.png"), png(320, 200, [128, 128, 128])),
    Bun.write(join(dir, "proto", "index.html"), `<link rel="stylesheet" href="style.css"><h1 id="proto">Prototype</h1>`),
    Bun.write(join(dir, "proto", "style.css"), "h1 { color: rgb(200, 0, 0); font-family: sans-serif }"),
  ])
  const clip = await video(join(dir, "scroll.mp4"), "blue")
  const options = [
    { label: "Card", why: "Quiet borders.", media: [{ light: "a-light.png", dark: "a-dark.png" }] },
    { label: "Inline", media: ["b.png", { src: "b-detail.png", label: "Detail" }] },
    { label: "Prototype", media: ["proto"] },
    ...(clip ? [{ label: "Scroll", media: ["scroll.mp4"] }] : []),
  ]
  const manifest = join(dir, "pick.json")
  await Bun.write(
    manifest,
    JSON.stringify({ title: "Code block style", question: "Which **code block** style?", baseline: "current.png", options, ...extra }),
  )
  return { manifest, video: Boolean(clip) }
}
