import { realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import { slug } from "./session"
import type { MediaKind, PickAnswer, PickManifest, PickMedia, PickOption, PickSession, PickState } from "./types"

/** A media entry as written: a path or URL, a light/dark pair, or either with a label. */
type RawMedia = string | { src?: string; light?: string; dark?: string; label?: string }

type RawManifest = {
  title?: unknown
  question?: unknown
  baseline?: RawMedia
  options?: { id?: unknown; label?: unknown; why?: unknown; body?: unknown; media?: RawMedia[] }[]
  previous?: unknown
}

const KINDS: Record<string, MediaKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".html": "page",
  ".htm": "page",
  ".md": "text",
}

export const EMPTY_PICK_STATE: PickState = { version: 1, current: 0, picked: [], none: false, note: "", notes: [] }

/** Reads and validates a pick manifest. Every problem is reported at once, each with where it is. */
export async function resolvePick(path: string, out?: string): Promise<PickSession> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`pick manifest not found: ${path}`)
  const raw: RawManifest = await file.json().catch((error: unknown) => {
    throw new Error(`pick manifest ${path} is not valid JSON: ${error}`)
  })
  const pick = await validatePick(raw, dirname(path))
  return {
    kind: "pick",
    id: `pick-${slug([pick.title])}-${Bun.hash(path).toString(36).slice(0, 6)}`,
    pick,
    manifestPath: path,
    statePath: join(dirname(path), `${basename(path, ".json")}.state.json`),
    outPath: resolve(out ?? join(dirname(path), "answer.json")),
  }
}

export async function validatePick(raw: RawManifest, root: string): Promise<PickManifest> {
  const errors: string[] = []
  const text = (value: unknown, where: string) => {
    if (value === undefined) return undefined
    if (typeof value === "string") return value
    errors.push(`${where}: expected a string`)
    return undefined
  }
  const title = text(raw.title, "title")
  if (!title) errors.push("title: required")
  if (!Array.isArray(raw.options) || !raw.options.length) errors.push("options: at least one option is required")
  const options = await Promise.all(
    (Array.isArray(raw.options) ? raw.options : []).map(async (option, index): Promise<PickOption> => {
      const where = `options[${index}]`
      const media = await Promise.all((option.media ?? []).map((entry, at) => resolveMedia(entry, root, `${where}.media[${at}]`, errors)))
      const found = media.filter((item) => item !== undefined)
      const body = text(option.body, `${where}.body`)
      if (!found.length && !body && !errors.some((error) => error.startsWith(where))) errors.push(`${where}: needs media or a body`)
      const id = option.id === undefined ? String.fromCharCode(65 + index) : String(option.id)
      return {
        id,
        label: text(option.label, `${where}.label`) ?? found[0]?.label ?? id,
        why: text(option.why, `${where}.why`),
        body,
        media: found,
      }
    }),
  )
  const ids = options.map((option) => option.id)
  ids.filter((id, index) => ids.indexOf(id) !== index).forEach((id) => errors.push(`options: duplicate id ${id}`))
  const baseline = raw.baseline === undefined ? undefined : await resolveMedia(raw.baseline, root, "baseline", errors)
  const previousPath = text(raw.previous, "previous")
  const previous = previousPath ? await readPrevious(resolve(root, previousPath), errors) : undefined
  if (errors.length) throw new Error(`invalid pick manifest:\n  ${errors.join("\n  ")}`)
  return { title: title!, question: text(raw.question, "question"), baseline, options, previous }
}

async function resolveMedia(entry: RawMedia, root: string, where: string, errors: string[]): Promise<PickMedia | undefined> {
  const light = typeof entry === "string" ? entry : (entry.src ?? entry.light)
  const dark = typeof entry === "string" ? undefined : entry.dark
  if (typeof light !== "string" || !light) {
    errors.push(`${where}: expected a path, a URL, or { "light": …, "dark": … }`)
    return undefined
  }
  const first = await resolveSource(light, root, where, errors)
  if (!first) return undefined
  const second = dark === undefined ? undefined : await resolveSource(dark, root, `${where}.dark`, errors)
  if (second && second.kind !== first.kind) errors.push(`${where}: light is ${first.kind} but dark is ${second.kind}`)
  const label = typeof entry === "string" ? undefined : entry.label
  return { kind: first.kind, src: first.src, ...(second ? { dark: second.src } : {}), label: label ?? first.name }
}

/** Infers the kind from the extension; `http(s)` is a live URL, a folder with index.html a local prototype. */
async function resolveSource(source: string, root: string, where: string, errors: string[]) {
  if (/^https?:\/\//.test(source)) return { kind: "url" as const, src: source, name: new URL(source).host }
  if (/^[a-z]+:/i.test(source)) {
    errors.push(`${where}: unsupported URL ${source}`)
    return undefined
  }
  const path = resolve(root, source)
  if (!isInside(resolve(root), path)) {
    errors.push(`${where}: ${source} is outside the manifest's folder`)
    return undefined
  }
  const info = await stat(path).catch(() => undefined)
  if (!info) {
    errors.push(`${where}: file not found: ${source}`)
    return undefined
  }
  const relative = path
    .slice(resolve(root).length + 1)
    .split(sep)
    .join("/")
  if (info.isDirectory()) {
    if (await Bun.file(join(path, "index.html")).exists())
      return { kind: "page" as const, src: `${relative}/index.html`, name: basename(path) }
    errors.push(`${where}: folder ${source} has no index.html`)
    return undefined
  }
  const kind = KINDS[extname(path).toLowerCase()]
  if (!kind) {
    errors.push(`${where}: unknown media kind for ${source} (images, videos, .html, .md, folders with index.html, or http(s) URLs)`)
    return undefined
  }
  return { kind, src: relative, name: basename(path, extname(path)) }
}

async function readPrevious(path: string, errors: string[]) {
  const answer = await Bun.file(path)
    .json()
    .catch(() => undefined)
  if (!answer || !Array.isArray(answer.picked)) errors.push(`previous: not a readable answer.json: ${path}`)
  return answer as PickAnswer | undefined
}

function isInside(root: string, path: string) {
  return path === root || path.startsWith(root + sep)
}

/**
 * The file under `root` that a URL path names, or undefined if it would leave `root` (`..`, encoded slashes,
 * absolute paths, or a symlink pointing out).
 */
export async function mediaPath(root: string, urlPath: string) {
  const parts = urlPath.split("/").map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return "\0"
    }
  })
  if (parts.some((part) => part === ".." || part.includes("\0") || part.includes("/") || part.includes("\\"))) return undefined
  const path = resolve(root, ...parts.filter(Boolean))
  if (!isInside(resolve(root), path)) return undefined
  const [real, realRoot] = await Promise.all([realpath(path).catch(() => undefined), realpath(root)])
  if (!real || !isInside(realRoot, real)) return undefined
  return real
}

/** Serves a media file, honoring a single byte range so videos can seek. */
export async function mediaResponse(path: string, req: Request) {
  const file = Bun.file(path)
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return new Response("Not found", { status: 404 })
  const headers = { "content-type": file.type, "accept-ranges": "bytes", "cache-control": "no-cache" }
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/)
  if (!range) return new Response(file, { headers })
  const size = info.size
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } })
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  })
}

/** The answer agents read: picks in rank order, the overall note, and per-option notes without their ids. */
export function toAnswer(session: PickSession, state: PickState): PickAnswer {
  const ids = new Set(session.pick.options.map((option) => option.id))
  return {
    session: session.manifestPath,
    answeredAt: new Date().toISOString(),
    picked: state.none ? [] : state.picked.filter((id) => ids.has(id)),
    none: state.none,
    note: state.note,
    notes: state.notes.filter((note) => ids.has(note.option)).map(({ id: _, ...note }) => note),
  }
}

/** "picked B, A" or "none of these", for the CLI and the inbox. */
export function answerSummary(answer: Pick<PickAnswer, "picked" | "none">) {
  if (answer.none) return "none of these"
  if (!answer.picked.length) return "no pick"
  return `picked ${answer.picked.join(", ")}`
}
