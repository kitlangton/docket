import index from "../web/index.html"
import { loadAll, manifestItems, readCache } from "./load"
import type { Session } from "./session"
import { itemId, type ItemLoad, type Manifest, type Note, type PrReview, type Progress, type ReviewState, type SessionPayload, type VerdictsFile } from "./types"

export type ServeOptions = {
  session: Session
  port: number
  refresh: boolean
  onHandback: (verdicts: VerdictsFile) => void
}

export async function serve(options: ServeOptions) {
  const session = options.session
  const manifest = session.manifest
  const ids = manifestItems(manifest).map(itemId)

  const items: Record<string, ItemLoad> = {}
  const progress: Progress = { done: 0, total: ids.length, phase: "Starting" }
  const counter = { version: 0 }

  const cached = options.refresh ? [] : await readCache(manifest)
  cached.forEach((data) => {
    items[data.meta.id] = { ok: true, data }
  })
  const complete = ids.every((id) => items[id])
  progress.done = cached.length

  const loading = loadAll(manifest, {
    phase: (phase) => {
      progress.phase = phase
    },
    loaded: (load) => {
      const id = load.ok ? load.data.meta.id : load.id
      const previous = items[id]
      // Keep a good cached copy rather than replacing it with a refresh failure.
      if (!load.ok && previous?.ok) return
      if (load.ok && previous?.ok && JSON.stringify(load.data) === JSON.stringify(previous.data)) return
      items[id] = load
      if (!complete) progress.done = Object.keys(items).length
      counter.version++
    },
  })
  if (complete) progress.phase = "Ready"
  loading.catch((error) => {
    if (complete) return console.error(`docket: background refresh failed: ${error}`)
    progress.phase = `Failed: ${error}`
  })

  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    development: false,
    routes: {
      "/": index,
      "/api/session": {
        GET: () => {
          const payload: SessionPayload = {
            manifest,
            label: session.manifestPath,
            statePath: session.statePath,
            outPath: session.outPath,
            progress,
            version: counter.version,
            items,
          }
          return Response.json(payload)
        },
      },
      "/api/version": {
        GET: () => Response.json({ version: counter.version, progress }),
      },
      "/api/state": {
        GET: async () => Response.json(await readState(session.statePath)),
        PUT: async (req) => {
          const state: ReviewState = await req.json()
          await Bun.write(session.statePath, JSON.stringify(state, null, 2))
          return Response.json({ ok: true })
        },
      },
      "/api/handback": {
        POST: async (req) => {
          const state: ReviewState = await req.json()
          await Bun.write(session.statePath, JSON.stringify(state, null, 2))
          const verdicts = toVerdicts(session.manifestPath, manifest, items, state)
          await Bun.write(session.outPath, JSON.stringify(verdicts, null, 2) + "\n")
          // Let the response reach the browser before the process exits.
          setTimeout(() => options.onHandback(verdicts), 150)
          return Response.json({ ok: true, path: session.outPath })
        },
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  })
  return { url: `http://127.0.0.1:${server.port}/`, server }
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

function toVerdicts(sessionPath: string, manifest: Manifest, items: Record<string, ItemLoad>, state: ReviewState): VerdictsFile {
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
