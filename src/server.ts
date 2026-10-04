import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import index from "../web/index.html"
import { loadAll, manifestItems, readCache } from "./load"
import { dataHome, type Session } from "./session"
import {
  sizeOf,
  itemId,
  type InboxEntry,
  type ItemLoad,
  type Manifest,
  type Note,
  type PrReview,
  type Progress,
  type ReviewState,
  type ServerEvent,
  type SessionPayload,
  type VerdictsFile,
} from "./types"

export const APP_ID = "docket"

export type ServerOptions = {
  port: number
  version: string
  /** Exit after this long with no connected tabs and no waiting clients. */
  idleMs: number
}

/** What `docket <args>` sends to register a session. */
export type Registration = { session: Session; cwd?: string; agent?: string; refresh?: boolean }

/** Events a waiting client receives on /api/s/:id/wait. */
export type WaitEvent =
  { type: "hello"; version: string } | { type: "handback"; verdicts: VerdictsFile; outPath: string } | { type: "closed"; statePath: string }

type Entry = {
  session: Session
  cwd?: string
  agent?: string
  registeredAt: string
  handedBackAt?: string
  archived?: boolean
}

type Runtime = { items: Record<string, ItemLoad>; progress: Progress; version: number }

type Stream = { send: (data: unknown) => void; close: () => void }

/** One long-lived server for every session: the inbox, each session's data and state, and the waiting clients. */
export async function serve(options: ServerOptions) {
  const indexPath = join(dataHome(), ".server", "sessions.json")
  const entries = await readIndex(indexPath)
  const runtimes = new Map<string, Runtime>()
  const waiters = new Map<string, Set<Stream>>()
  const tabs = new Map<string, Stream & { at: string }>()
  const writes = new Set<Promise<unknown>>()
  const idle = { since: Date.now() }
  const publicUrl = (await portlessAlias(options.port)) ?? `http://docket.localhost:${options.port}`

  const track = <T>(promise: Promise<T>) => {
    writes.add(promise)
    promise.finally(() => writes.delete(promise))
    return promise
  }
  const write = (path: string, data: string) => track(Bun.write(path, data))
  const saveIndex = () =>
    track(mkdir(join(dataHome(), ".server"), { recursive: true }).then(() => Bun.write(indexPath, JSON.stringify(entries, null, 2))))

  const broadcast = (event: ServerEvent) => tabs.forEach((tab) => tab.send(event))
  const busy = () => tabs.size > 0 || [...waiters.values()].some((set) => set.size > 0)
  const touchIdle = () => {
    idle.since = busy() ? Number.POSITIVE_INFINITY : Date.now()
  }

  const runtime = (id: string, refresh = false) => {
    const existing = runtimes.get(id)
    const entry = entries[id]
    if (existing && !refresh) return existing
    if (!entry) return undefined
    const fresh = startRuntime(entry.session, refresh, (version) => broadcast({ type: "session", id, version }))
    runtimes.set(id, fresh)
    return fresh
  }

  const notifyWaiters = (id: string, event: WaitEvent) => {
    waiters.get(id)?.forEach((waiter) => {
      waiter.send(event)
      waiter.close()
    })
    waiters.delete(id)
    touchIdle()
  }

  const inbox = async () => {
    const rows = await Promise.all(
      Object.entries(entries)
        .filter(([, entry]) => !entry.archived)
        .map(([id, entry]) => inboxEntry(id, entry, waiters.get(id)?.size ?? 0)),
    )
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  const shutdown = async () => {
    broadcast({ type: "restart" })
    // Give tabs a moment to flush pending state, then finish every write in flight.
    await Bun.sleep(300)
    await Promise.all([...writes])
    tabs.forEach((tab) => tab.close())
    waiters.forEach((set) => set.forEach((waiter) => waiter.close()))
    server.stop(true)
    process.exit(0)
  }

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
    development: false,
    idleTimeout: 0,
    routes: {
      "/": index,
      "/s/:id": index,
      "/api/health": {
        GET: () => Response.json({ app: APP_ID, version: options.version, pid: process.pid, port: options.port, url: publicUrl }),
      },
      "/api/shutdown": {
        POST: () => {
          setTimeout(shutdown, 50)
          return Response.json({ ok: true })
        },
      },
      "/api/sessions": {
        GET: async () => Response.json(await inbox()),
        POST: async (req) => {
          const registration: Registration = await req.json()
          const id = registration.session.id
          entries[id] = {
            session: registration.session,
            cwd: registration.cwd,
            agent: registration.agent,
            registeredAt: new Date().toISOString(),
            handedBackAt: entries[id]?.handedBackAt,
          }
          await saveIndex()
          runtime(id, registration.refresh)
          broadcast({ type: "inbox" })
          // Reuse a tab already showing this session or the inbox instead of opening another.
          const tab =
            [...tabs.values()].find((candidate) => candidate.at === `/s/${id}`) ??
            [...tabs.values()].find((candidate) => candidate.at === "/")
          if (tab) tab.send({ type: "navigate", id } satisfies ServerEvent)
          return Response.json({ id, url: `${publicUrl}/s/${encodeURIComponent(id)}`, focused: Boolean(tab) })
        },
      },
      "/api/events": {
        GET: (req) => {
          const params = new URL(req.url).searchParams
          const tabId = params.get("tab") ?? crypto.randomUUID()
          return eventStream((stream) => {
            tabs.get(tabId)?.close()
            tabs.set(tabId, { ...stream, at: params.get("at") ?? "/" })
            touchIdle()
            stream.send({ type: "hello", version: options.version } satisfies ServerEvent)
            return () => {
              if (tabs.get(tabId)?.send === stream.send) tabs.delete(tabId)
              touchIdle()
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
          const loaded = found && runtime(found.id)
          if (!found || !loaded) return notFound()
          const payload: SessionPayload = {
            id: found.id,
            manifest: found.entry.session.manifest,
            label: found.entry.session.manifestPath,
            statePath: found.entry.session.statePath,
            outPath: found.entry.session.outPath,
            progress: loaded.progress,
            version: loaded.version,
            items: loaded.items,
          }
          return Response.json(payload)
        },
      },
      "/api/s/:id/state": {
        GET: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          return Response.json(await readState(found.entry.session.statePath))
        },
        PUT: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          await write(found.entry.session.statePath, JSON.stringify(await req.json(), null, 2))
          broadcast({ type: "inbox" })
          return Response.json({ ok: true })
        },
      },
      "/api/s/:id/wait": {
        GET: (req) => {
          const found = session(req)
          if (!found) return notFound()
          return eventStream((stream) => {
            const set = waiters.get(found.id) ?? new Set()
            set.add(stream)
            waiters.set(found.id, set)
            touchIdle()
            broadcast({ type: "inbox" })
            stream.send({ type: "hello", version: options.version } satisfies WaitEvent)
            return () => {
              set.delete(stream)
              touchIdle()
              broadcast({ type: "inbox" })
            }
          })
        },
      },
      "/api/s/:id/handback": {
        POST: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          const state: ReviewState = await req.json()
          const { session: s } = found.entry
          const verdicts = toVerdicts(s.manifestPath, s.manifest, runtime(found.id)?.items ?? {}, state)
          await Promise.all([
            write(s.statePath, JSON.stringify(state, null, 2)),
            write(s.outPath, JSON.stringify(verdicts, null, 2) + "\n"),
          ])
          found.entry.handedBackAt = new Date().toISOString()
          await saveIndex()
          notifyWaiters(found.id, { type: "handback", verdicts, outPath: s.outPath })
          broadcast({ type: "inbox" })
          return Response.json({ ok: true, path: s.outPath })
        },
      },
      "/api/s/:id/close": {
        POST: async (req) => {
          const found = session(req)
          if (!found) return notFound()
          await write(found.entry.session.statePath, JSON.stringify(await req.json(), null, 2))
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
    fetch: () => new Response("Not found", { status: 404 }),
  })

  setInterval(
    () => {
      if (!busy() && Date.now() - idle.since > options.idleMs) {
        console.log(`docket: idle for ${Math.round(options.idleMs / 1000)}s, shutting down`)
        shutdown()
      }
    },
    Math.min(30_000, Math.max(250, options.idleMs / 4)),
  )
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  return { server, url: publicUrl }
}

function startRuntime(session: Session, refresh: boolean, changed: (version: number) => void): Runtime {
  const manifest = session.manifest
  const ids = manifestItems(manifest).map(itemId)
  const runtime: Runtime = { items: {}, progress: { done: 0, total: ids.length, phase: "Starting" }, version: 0 }
  const bump = () => changed(++runtime.version)
  const cached = (refresh ? Promise.resolve([]) : readCache(manifest)).then((list) => {
    list.forEach((data) => {
      runtime.items[data.meta.id] = { ok: true, data }
    })
    runtime.progress.done = list.length
    const complete = ids.every((id) => runtime.items[id])
    if (complete) runtime.progress.phase = "Ready"
    bump()
    return complete
  })
  cached.then((complete) =>
    loadAll(manifest, {
      phase: (phase) => {
        if (!complete) runtime.progress.phase = phase
      },
      loaded: (load) => {
        const id = load.ok ? load.data.meta.id : load.id
        const previous = runtime.items[id]
        // Keep a good cached copy rather than replacing it with a refresh failure.
        if (!load.ok && previous?.ok) return
        if (load.ok && previous?.ok && JSON.stringify(load.data) === JSON.stringify(previous.data)) return
        runtime.items[id] = load
        if (!complete) runtime.progress.done = Object.keys(runtime.items).length
        bump()
      },
    })
      .then(() => {
        runtime.progress.phase = "Ready"
        bump()
      })
      .catch((error) => {
        if (complete) return console.error(`docket: background refresh failed: ${error}`)
        runtime.progress.phase = `Failed: ${error}`
        bump()
      }),
  )
  return runtime
}

async function inboxEntry(id: string, entry: Entry, waiting: number): Promise<InboxEntry> {
  const manifest = entry.session.manifest
  const order = manifestItems(manifest).map(itemId)
  const state = await readState(entry.session.statePath)
  const verdicts = order.map((item) => state.reviews[item]?.verdict ?? null)
  const count = (value: string | null) => verdicts.filter((verdict) => verdict === value).length
  const stateFile = Bun.file(entry.session.statePath)
  const touched = (await stateFile.exists()) ? new Date(stateFile.lastModified).toISOString() : entry.registeredAt
  const done = entry.handedBackAt !== undefined && entry.handedBackAt >= entry.registeredAt
  return {
    id,
    title: manifest.title,
    repo: manifest.repo.github ?? basename(manifest.repo.path),
    cwd: entry.cwd,
    agent: entry.agent,
    status: waiting > 0 ? "waiting" : done ? "done" : "progress",
    total: order.length,
    reviewed: order.length - count(null),
    notes: order.reduce((sum, item) => sum + (state.reviews[item]?.notes.length ?? 0), 0),
    counts: { approve: count("approve"), reject: count("reject"), skip: count("skip"), unreviewed: count(null) },
    registeredAt: entry.registeredAt,
    updatedAt: [entry.registeredAt, touched, entry.handedBackAt ?? ""].sort().at(-1)!,
    ...(entry.handedBackAt ? { handedBackAt: entry.handedBackAt } : {}),
  }
}

async function readIndex(path: string): Promise<Record<string, Entry>> {
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  return file.json()
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

type LegacyReview = Partial<PrReview> & { prNote?: string }
type LegacyState = { version?: number; current?: string | number | null; reviews?: Record<string, LegacyReview> }

/** Reads review state, upgrading files written before PR notes joined the notes list. */
async function readState(path: string): Promise<ReviewState> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { version: 2, current: null, reviews: {} }
  const raw: LegacyState = await file.json()
  const reviews = Object.fromEntries(
    Object.entries(raw.reviews ?? {}).map(([id, review]): [string, PrReview] => {
      const notes: Note[] = [...(review.prNote ? [{ id: crypto.randomUUID(), body: review.prNote }] : []), ...(review.notes ?? [])]
      return [id, { verdict: review.verdict ?? null, reason: review.reason, notes, viewed: review.viewed }]
    }),
  )
  return { version: 2, current: raw.current === null || raw.current === undefined ? null : String(raw.current), reviews }
}

export function toVerdicts(sessionPath: string, manifest: Manifest, items: Record<string, ItemLoad>, state: ReviewState): VerdictsFile {
  return {
    session: sessionPath,
    reviewedAt: new Date().toISOString(),
    prs: manifestItems(manifest).map((item) => {
      const id = itemId(item)
      const review = state.reviews[id]
      const load = items[id]
      return {
        ...(item.number !== undefined ? { number: item.number } : { ref: item.ref }),
        ...(load?.ok ? { title: load.data.meta.title } : {}),
        ...(item.confidence ? { confidence: item.confidence } : {}),
        ...(load?.ok ? { size: sizeOf(load.data.meta) } : {}),
        verdict: review?.verdict ?? null,
        ...(review?.reason ? { reason: review.reason } : {}),
        notes: (review?.notes ?? []).map((note) => {
          if (!note.path || note.line === undefined) return { body: note.body }
          return {
            path: note.path,
            side: note.side === "deletions" ? ("LEFT" as const) : ("RIGHT" as const),
            ...(note.startLine !== undefined && note.startLine !== note.line ? { startLine: note.startLine } : {}),
            line: note.line,
            body: note.body,
          }
        }),
      }
    }),
  }
}
