import { mkdir, rename } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import index from "../web/index.html"
import { fileAt, interdiff, loadAll, manifestItems, readCache } from "./load"
import { writeAtomic } from "./files"
import { EMPTY_PICK_STATE, mediaPath, mediaResponse, toAnswer } from "./pick"
import { dataHome } from "./session"
import { readState, toVerdicts } from "./state"
import {
  APP_ID,
  itemId,
  mediaUrl,
  type InboxEntry,
  type ItemLoad,
  type Manifest,
  type PickPayload,
  type PickSession,
  type PickState,
  type Registration,
  type ReviewSession,
  type ReviewState,
  type ServerEvent,
  type Session,
  type SessionPayload,
  type WaitEvent,
} from "./types"

/** `DOCKET_DEV=1` serves the web app through Bun's development bundler, with hot reloading, for working on docket. */
const DEV = process.env.DOCKET_DEV === "1"
const REFRESH_MS = Number(process.env.DOCKET_REFRESH_MS ?? 60_000)
/** Exit after this long with no connected tabs and no waiting clients. */
const IDLE_MS = Number(process.env.DOCKET_IDLE_MS ?? 30 * 60_000)

type ServerOptions = { port: number; version: string }
/** "stop" ends waiting clients; "restart" and "idle" let them reconnect. An idle shutdown cancels if anyone arrives. */
type ShutdownMode = "stop" | "restart" | "idle"

type Entry = {
  session: Session
  cwd?: string
  agent?: string
  registeredAt: string
  handedBackAt?: string
  archived?: boolean
}

type Runtime = {
  items: Record<string, ItemLoad>
  version: number
  /** Reloads every item, or only local refs, picking up new commits. */
  refresh: (only?: "local") => void
}

type Stream = { send: (data: unknown) => void; close: () => void }

/** The review half of a session; picks have no runtime, diffs, or verdicts. */
function reviewOf(session: Session): ReviewSession | undefined {
  return session.kind === "pick" ? undefined : session
}

/** One long-lived server for every session: the inbox, each session's data and state, and the waiting clients. */
export async function serve(options: ServerOptions) {
  const serverDir = join(dataHome(), ".server")
  await mkdir(serverDir, { recursive: true })
  const indexPath = join(serverDir, "sessions.json")
  const entries = await readIndex(indexPath)
  const runtimes = new Map<string, Runtime>()
  const waiters = new Map<string, Set<Stream>>()
  const tabs = new Map<string, Stream & { at: string }>()
  const idle = { since: Date.now() }
  const [publicUrl, app] = await Promise.all([
    portlessAlias(options.port).then((alias) => alias ?? `http://docket.localhost:${options.port}`),
    DEV ? undefined : buildApp(),
  ])

  // Saves run one after another, so an older snapshot never lands after a newer one.
  const saving = { chain: Promise.resolve() }
  const saveIndex = () => {
    saving.chain = saving.chain.catch(() => undefined).then(() => writeAtomic(indexPath, JSON.stringify(entries, null, 2)))
    return saving.chain
  }

  const broadcast = (event: ServerEvent) => tabs.forEach((tab) => tab.send(event))
  const busy = () => tabs.size > 0 || waiters.size > 0

  const start = (id: string, ignoreCache: boolean) => {
    const review = reviewOf(entries[id]!.session)
    if (!review) return undefined
    // Versions continue from the replaced runtime, whose own late loads are ignored.
    const fresh = startRuntime(review.manifest, ignoreCache, runtimes.get(id)?.version ?? 0, (version) => {
      if (runtimes.get(id) === fresh) broadcast({ type: "session", id, version })
    })
    runtimes.set(id, fresh)
    return fresh
  }
  // Sessions from an earlier server load lazily, on first use.
  const runtime = (id: string) => runtimes.get(id) ?? (entries[id] ? start(id, false) : undefined)

  const notifyWaiters = (id: string, event: WaitEvent) => {
    waiters.get(id)?.forEach((waiter) => {
      waiter.send(event)
      waiter.close()
    })
    waiters.delete(id)
  }

  // One unreadable state file hides its row instead of failing the whole inbox.
  const inbox = async () => {
    const rows = await Promise.all(
      Object.entries(entries)
        .filter(([, entry]) => !entry.archived)
        .map(([id, entry]) =>
          inboxEntry(id, entry, waiters.get(id)?.size ?? 0).catch((error: unknown) => {
            console.error(`docket: skipping session ${id} in the inbox: ${error}`)
            return undefined
          }),
        ),
    )
    return rows.filter((row) => row !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Stops the server. A restart (new code) or an idle exit leaves waiting clients to reconnect to the next
   * server; a stop tells them the session closed, so they exit instead of starting another server. While
   * stopping, health, register, and wait answer 503 so clients wait for the next server.
   */
  const stopping: { mode?: ShutdownMode } = {}
  const shutdown = async (mode: ShutdownMode) => {
    if (stopping.mode) {
      // An explicit stop wins over a restart or idle exit already under way.
      if (mode === "stop") stopping.mode = "stop"
      return
    }
    stopping.mode = mode
    broadcast({ type: "restart" })
    // Give tabs a moment to save pending state; stop() then waits for those requests to finish.
    await Bun.sleep(300)
    if (stopping.mode === "idle" && busy()) {
      stopping.mode = undefined
      idle.since = Date.now()
      return
    }
    waiters.forEach((_, id) => {
      if (stopping.mode === "stop") return notifyWaiters(id, { type: "closed", statePath: entries[id]!.session.statePath })
      waiters.get(id)?.forEach((waiter) => waiter.close())
    })
    if (stopping.mode === "stop") broadcast({ type: "stopped" })
    tabs.forEach((tab) => tab.close())
    await Promise.race([server.stop(), Bun.sleep(5000)])
    process.exit(0)
  }
  const unavailable = () => Response.json({ error: "stopping" }, { status: 503 })

  const session = (req: Request & { params: { id: string } }) => {
    const id = req.params.id
    const entry = entries[id]
    if (!entry) return undefined
    return { id, entry }
  }
  const notFound = () => Response.json({ error: "unknown session" }, { status: 404 })

  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    development: DEV,
    // Without this, Bun lets a second server bind the same port and requests split between them.
    reusePort: false,
    idleTimeout: 0,
    routes: {
      ...(app ?? { "/": index, "/s/:id": index }),
      "/api/health": {
        GET: () =>
          stopping.mode
            ? unavailable()
            : Response.json({
                app: APP_ID,
                version: options.version,
                pid: process.pid,
                port: options.port,
                url: publicUrl,
              }),
      },
      "/api/shutdown": {
        POST: async (req) => {
          const body: { mode?: ShutdownMode } = await req.json().catch(() => ({}))
          setTimeout(() => shutdown(body.mode === "restart" ? "restart" : "stop"), 50)
          return Response.json({ ok: true })
        },
      },
      "/api/sessions": {
        GET: async () => Response.json(await inbox()),
        POST: async (req) => {
          if (stopping.mode) return unavailable()
          const registration: Registration = await req.json()
          const id = registration.session.id
          // A changed manifest (edited file, different flags) needs a fresh load, not the old runtime's items.
          const changed = JSON.stringify(entries[id]?.session) !== JSON.stringify(registration.session)
          entries[id] = {
            session: registration.session,
            cwd: registration.cwd,
            agent: registration.agent,
            registeredAt: new Date().toISOString(),
          }
          await saveIndex()
          if (changed || registration.refresh || !runtimes.has(id)) start(id, Boolean(registration.refresh))
          broadcast({ type: "inbox" })
          // Reuse a tab already showing this session or the inbox instead of opening another.
          const tab =
            [...tabs.values()].find((candidate) => candidate.at === `/s/${id}`) ??
            [...tabs.values()].find((candidate) => candidate.at === "/")
          if (tab) tab.send({ type: "navigate", id } satisfies ServerEvent)
          const path = `/s/${encodeURIComponent(id)}`
          return Response.json({ id, url: publicUrl + path, focused: Boolean(tab) })
        },
      },
      "/api/events": {
        GET: (req) => {
          const params = new URL(req.url).searchParams
          const tabId = params.get("tab") ?? crypto.randomUUID()
          return eventStream((stream) => {
            tabs.get(tabId)?.close()
            tabs.set(tabId, { ...stream, at: params.get("at") ?? "/" })
            stream.send({ type: "hello", version: options.version } satisfies ServerEvent)
            return () => {
              if (tabs.get(tabId)?.send === stream.send) tabs.delete(tabId)
            }
          })
        },
      },
      "/api/tabs/:tab": {
        POST: async (req) => {
          const body: { at: string } = await req.json()
          const tab = tabs.get(req.params.tab)
          if (tab) tab.at = body.at
          return Response.json({ ok: Boolean(tab) })
        },
      },
      "/api/s/:id/session": {
        GET: (req) => {
          const found = session(req)
          if (!found) return notFound()
          const s = found.entry.session
          if (s.kind === "pick")
            return Response.json({ id: found.id, kind: "pick", pick: s.pick, outPath: s.outPath } satisfies PickPayload)
          const loaded = runtime(found.id)
          if (!loaded) return notFound()
          const payload: SessionPayload = { id: found.id, manifest: s.manifest, outPath: s.outPath, items: loaded.items }
          return Response.json(payload)
        },
      },
      "/api/s/:id/state": {
        GET: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          const s = found.entry.session
          return Response.json(await (s.kind === "pick" ? readState<PickState>(s.statePath, EMPTY_PICK_STATE) : readState(s.statePath)))
        },
        PUT: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          await writeAtomic(found.entry.session.statePath, JSON.stringify(await req.json(), null, 2))
          broadcast({ type: "inbox" })
          return Response.json({ ok: true })
        },
      },
      "/api/s/:id/wait": {
        GET: async (req) => {
          if (stopping.mode) return unavailable()
          const found = session(req)
          if (!found) return notFound()
          // Handed back while this client was away (say, reconnecting after a restart): deliver it now.
          const { handedBackAt, session: s } = found.entry
          const result = handedBackAt
            ? await Bun.file(s.outPath)
                .json()
                .catch(() => undefined)
            : undefined
          if (result)
            return eventStream((stream) => {
              stream.send(
                (s.kind === "pick"
                  ? { type: "answer", answer: result, outPath: s.outPath }
                  : { type: "handback", verdicts: result, outPath: s.outPath }) satisfies WaitEvent,
              )
              queueMicrotask(stream.close)
              return () => {}
            })
          return eventStream((stream) => {
            const set = waiters.get(found.id) ?? new Set()
            set.add(stream)
            waiters.set(found.id, set)
            broadcast({ type: "inbox" })
            stream.send({ type: "hello", version: options.version } satisfies WaitEvent)
            return () => {
              set.delete(stream)
              if (!set.size && waiters.get(found.id) === set) waiters.delete(found.id)
              broadcast({ type: "inbox" })
            }
          })
        },
      },
      // Content-addressed: the same commit and path always give the same file, so it can be cached forever.
      "/api/s/:id/file": {
        GET: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          const params = new URL(req.url).searchParams
          const oid = params.get("oid") ?? ""
          if (!/^[0-9a-f]{40,64}$/.test(oid)) return new Response("Bad commit", { status: 400 })
          const review = reviewOf(found.entry.session)
          if (!review) return notFound()
          const contents = await fileAt(review.manifest, oid, params.get("path") ?? "")
          if (contents === undefined) return new Response("Not found", { status: 404 })
          return new Response(contents, {
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "max-age=31536000, immutable" },
          })
        },
      },
      // Whether a live URL in a pick allows framing; only URLs from the session's own manifest are checked.
      "/api/s/:id/frame": {
        GET: async (req) => {
          const found = session(req)
          const s = found?.entry.session
          const url = new URL(req.url).searchParams.get("url") ?? ""
          const listed =
            s?.kind === "pick" && s.pick.options.some((option) => option.media.some((media) => media.kind === "url" && media.src === url))
          if (!listed) return notFound()
          return Response.json({ frameable: await frameable(url) })
        },
      },
      "/api/s/:id/refresh": {
        POST: (req) => {
          const found = session(req)
          if (!found) return notFound()
          runtime(found.id)?.refresh("local")
          return Response.json({ ok: true })
        },
      },
      "/api/s/:id/interdiff": {
        GET: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          const params = new URL(req.url).searchParams
          const load = runtime(found.id)?.items[params.get("item") ?? ""]
          const review = reviewOf(found.entry.session)
          if (!load?.ok || !review) return notFound()
          return Response.json(await interdiff(review.manifest, load.data, params.get("from") ?? ""))
        },
      },
      "/api/s/:id/handback": {
        POST: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          const { session: s } = found.entry
          const body: unknown = await req.json()
          const event: WaitEvent =
            s.kind === "pick"
              ? { type: "answer", answer: toAnswer(s, body as PickState), outPath: s.outPath }
              : {
                  type: "handback",
                  verdicts: toVerdicts(s.manifestPath, s.manifest, runtime(found.id)?.items ?? {}, body as ReviewState),
                  outPath: s.outPath,
                }
          const result = event.type === "answer" ? event.answer : event.type === "handback" ? event.verdicts : undefined
          await Promise.all([
            writeAtomic(s.statePath, JSON.stringify(body, null, 2)),
            writeAtomic(s.outPath, JSON.stringify(result, null, 2) + "\n"),
          ])
          found.entry.handedBackAt = new Date().toISOString()
          await saveIndex()
          notifyWaiters(found.id, event)
          broadcast({ type: "inbox" })
          return Response.json({ ok: true, path: s.outPath })
        },
      },
      "/api/s/:id/close": {
        POST: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          await writeAtomic(found.entry.session.statePath, JSON.stringify(await req.json(), null, 2))
          notifyWaiters(found.id, { type: "closed", statePath: found.entry.session.statePath })
          broadcast({ type: "inbox" })
          return Response.json({ ok: true })
        },
      },
      "/api/s/:id/archive": {
        POST: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          const body: { archived: boolean } = await req.json()
          found.entry.archived = body.archived
          await saveIndex()
          broadcast({ type: "inbox" })
          return Response.json({ ok: true })
        },
      },
    },
    // Media for pick sessions, served from the manifest's folder only, so prototypes' relative assets resolve.
    fetch: async (req) => {
      const match = new URL(req.url).pathname.match(/^\/api\/s\/([^/]+)\/media\/(.+)$/)
      const s = match && entries[decodeURIComponent(match[1]!)]?.session
      if (!s || s.kind !== "pick") return new Response("Not found", { status: 404 })
      const path = await mediaPath(dirname(s.manifestPath), match[2]!)
      if (!path) return new Response("Not found", { status: 404 })
      return mediaResponse(path, req)
    },
  })

  setInterval(
    () => {
      if (busy()) idle.since = Date.now()
      if (Date.now() - idle.since <= IDLE_MS) return
      console.log(`docket: idle for ${Math.round(IDLE_MS / 1000)}s, shutting down`)
      shutdown("idle")
    },
    Math.min(30_000, Math.max(250, IDLE_MS / 4)),
  )
  // Pick up new commits on sessions someone is looking at; local refs also refresh when their tab gains focus.
  setInterval(() => {
    const open = new Set([...tabs.values()].flatMap((tab) => tab.at.match(/^\/s\/([^/]+)/)?.slice(1) ?? []).map(decodeURIComponent))
    open.forEach((id) => runtimes.get(id)?.refresh())
  }, REFRESH_MS)
  process.on("SIGTERM", () => shutdown("stop"))
  process.on("SIGINT", () => shutdown("stop"))
  return { server, url: publicUrl }
}

function startRuntime(manifest: Manifest, ignoreCache: boolean, version: number, changed: (version: number) => void): Runtime {
  const bump = () => changed(++runtime.version)
  const accept = (load: ItemLoad) => {
    const id = load.ok ? load.data.meta.id : load.id
    const previous = runtime.items[id]
    // Keep a good copy rather than replacing it with a refresh failure.
    if (!load.ok && previous?.ok) return false
    if (load.ok && previous?.ok && JSON.stringify(load.data) === JSON.stringify(previous.data)) return false
    runtime.items[id] = load
    return true
  }
  // Busy from the start, so a refresh can't race the first load.
  const reloading = { busy: true }
  const load = (only?: "local") => {
    reloading.busy = true
    const groups = only ? [{ title: "local", prs: manifestItems(manifest).filter((item) => item.number === undefined) }] : manifest.groups
    return loadAll({ ...manifest, groups }, (item) => accept(item) && bump())
      .catch((error) => console.error(`docket: loading ${manifest.title} failed: ${error}`))
      .finally(() => {
        reloading.busy = false
      })
  }
  const runtime: Runtime = {
    items: {},
    version,
    refresh: (only) => {
      if (!reloading.busy) void load(only)
    },
  }
  ;(ignoreCache ? Promise.resolve([]) : readCache(manifest))
    .then((list) => {
      list.forEach((data) => {
        runtime.items[data.meta.id] = { ok: true, data }
      })
      bump()
    })
    .catch((error) => console.error(`docket: reading the cache for ${manifest.title} failed: ${error}`))
    .then(() => load())
  return runtime
}

async function inboxEntry(id: string, entry: Entry, waiting: number) {
  const s = entry.session
  const stateFile = Bun.file(s.statePath)
  const touched = (await stateFile.exists()) ? new Date(stateFile.lastModified).toISOString() : entry.registeredAt
  const common = {
    id,
    cwd: entry.cwd,
    agent: entry.agent,
    status: waiting > 0 ? "waiting" : entry.handedBackAt !== undefined ? "done" : "progress",
    updatedAt: [entry.registeredAt, touched, entry.handedBackAt ?? ""].sort().at(-1)!,
  } as const
  return s.kind === "pick" ? pickEntry(id, s, common) : reviewEntry(s, common)
}

async function pickEntry(
  id: string,
  s: PickSession,
  common: Omit<InboxEntry, "kind" | "title" | "repo" | "total" | "reviewed" | "notes" | "counts">,
) {
  const state = await readState<PickState>(s.statePath, EMPTY_PICK_STATE)
  const options = s.pick.options
  const picked = state.none ? [] : state.picked
  const image = options.find((option) => option.id === picked[0])?.media.find((media) => media.kind === "image")
  return {
    ...common,
    kind: "pick",
    title: s.pick.title,
    repo: basename(dirname(s.manifestPath)),
    total: options.length,
    reviewed: picked.length,
    notes: state.notes.length + (state.note ? 1 : 0),
    counts: { approve: picked.length, reject: 0, skip: 0, unreviewed: options.length - picked.length },
    pick: { picked, none: state.none, thumb: image && mediaUrl(id, image.src) },
  } satisfies InboxEntry
}

async function reviewEntry(
  s: ReviewSession,
  common: Omit<InboxEntry, "kind" | "title" | "repo" | "total" | "reviewed" | "notes" | "counts">,
) {
  const manifest = s.manifest
  const order = manifestItems(manifest).map(itemId)
  const state = await readState(s.statePath)
  const verdicts = order.map((item) => state.reviews[item]?.verdict ?? null)
  const count = (value: string | null) => verdicts.filter((verdict) => verdict === value).length
  return {
    ...common,
    kind: "review",
    title: manifest.title,
    repo: manifest.repo.github ?? basename(manifest.repo.path),
    total: order.length,
    reviewed: order.length - count(null),
    notes: order.reduce((sum, item) => sum + (state.reviews[item]?.notes.length ?? 0), 0),
    counts: { approve: count("approve"), reject: count("reject"), skip: count("skip"), unreviewed: count(null) },
  } satisfies InboxEntry
}

/** The registered sessions. An unreadable index is moved aside, so the server still starts. */
async function readIndex(path: string): Promise<Record<string, Entry>> {
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  return file.json().catch(async (error: unknown) => {
    const aside = `${path}.unreadable-${Date.now()}`
    console.error(`docket: ${path} is unreadable (${error}); moved it to ${aside}`)
    await rename(path, aside)
    return {}
  })
}

/**
 * The web app as minified static routes. Code splitting keeps syntax-highlighting grammars and themes in their
 * own chunks, which load only when a diff needs them.
 */
async function buildApp() {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "web", "index.html")],
    minify: true,
    splitting: true,
    target: "browser",
    publicPath: "/",
  })
  if (!result.success) throw new AggregateError(result.logs, "building the web app failed")
  const routes = Object.fromEntries(
    await Promise.all(
      result.outputs.map(async (output) => {
        const html = output.path.endsWith(".html")
        const headers = { "content-type": output.type, "cache-control": html ? "no-cache" : "max-age=31536000, immutable" }
        return [`/${output.path.replace(/^\.\//, "")}`, new Response(await output.arrayBuffer(), { headers })] as const
      }),
    ),
  )
  const page = Object.entries(routes).find(([path]) => path.endsWith(".html"))![1]
  return { ...routes, "/": page, "/s/:id": page }
}

/** False when the page refuses to be framed (X-Frame-Options, or CSP frame-ancestors); true if unsure. */
async function frameable(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "follow" }).catch(() => undefined)
  if (!res) return true
  void res.body?.cancel()
  const options = res.headers.get("x-frame-options")?.toLowerCase()
  if (options && /deny|sameorigin/.test(options)) return false
  const ancestors = res.headers
    .get("content-security-policy")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("frame-ancestors"))
  return !ancestors || ancestors.includes("*")
}

/** If portless is installed, serve docket at https://docket.localhost through it. */
async function portlessAlias(port: number) {
  if (!Bun.which("portless")) return undefined
  const proc = Bun.spawn(["portless", "alias", "docket", String(port)], { stdout: "ignore", stderr: "ignore" })
  const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => -1)])
  if (code !== 0) return undefined
  return "https://docket.localhost"
}

/** A server-sent event stream. `setup` returns its cleanup, which runs on close from either end. */
function eventStream(setup: (stream: Stream) => () => void) {
  const encoder = new TextEncoder()
  const state: { closed: boolean; cleanup: () => void; cancel?: () => void; ping?: ReturnType<typeof setInterval> } = {
    closed: false,
    cleanup: () => {},
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = () => {
        if (state.closed) return
        state.closed = true
        clearInterval(state.ping)
        state.cleanup()
      }
      const stream: Stream = {
        send: (data) => {
          if (!state.closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        },
        close: () => {
          if (state.closed) return
          finish()
          controller.close()
        },
      }
      state.ping = setInterval(() => {
        if (!state.closed) controller.enqueue(encoder.encode(": ping\n\n"))
      }, 15_000)
      state.cleanup = setup(stream)
      // A close from the other end arrives as cancel; keep the finish handle for it.
      state.cancel = finish
    },
    cancel() {
      state.cancel?.()
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
}
