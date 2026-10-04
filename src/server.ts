import { basename, dirname, join, resolve } from "node:path"
import index from "../web/index.html"
import { loadAll, prNumbers, readCache } from "./load"
import type { Manifest, PrLoad, Progress, ReviewState, SessionPayload, VerdictsFile } from "./types"

export type ServeOptions = {
  sessionPath: string
  outPath?: string
  port: number
  refresh: boolean
}

export async function serve(options: ServeOptions) {
  const sessionPath = resolve(options.sessionPath)
  const manifest: Manifest = await Bun.file(sessionPath).json()
  const outPath = resolve(options.outPath ?? join(dirname(sessionPath), "verdicts.json"))
  const statePath = join(dirname(sessionPath), `${basename(sessionPath, ".json")}.state.json`)
  const numbers = prNumbers(manifest)

  const prs: Record<string, PrLoad> = {}
  const progress: Progress = { done: 0, total: numbers.length, phase: "Starting" }
  const counter = { version: 0 }

  const cached = options.refresh ? [] : await readCache(manifest)
  cached.forEach((data) => {
    prs[data.meta.number] = { ok: true, data }
  })
  const complete = cached.length === numbers.length
  progress.done = cached.length

  const loading = loadAll(manifest, {
    phase: (phase) => {
      progress.phase = phase
    },
    loaded: (load) => {
      const number = load.ok ? load.data.meta.number : load.number
      const previous = prs[number]
      // Keep a good cached copy rather than replacing it with a refresh failure.
      if (!load.ok && previous?.ok) return
      if (load.ok && previous?.ok && JSON.stringify(load.data) === JSON.stringify(previous.data)) return
      prs[number] = load
      if (!complete) progress.done = Object.keys(prs).length
      counter.version++
    },
  })
  if (complete) {
    progress.phase = "Ready"
    loading.catch((error) => console.error(`prdeck: background refresh failed: ${error}`))
  }
  if (!complete) loading.catch((error) => {
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
          const payload: SessionPayload = { manifest, sessionPath, outPath, progress, version: counter.version, prs }
          return Response.json(payload)
        },
      },
      "/api/version": {
        GET: () => Response.json({ version: counter.version, progress }),
      },
      "/api/state": {
        GET: async () => {
          const file = Bun.file(statePath)
          if (!(await file.exists())) return Response.json({ current: null, reviews: {} } satisfies ReviewState)
          return new Response(file, { headers: { "content-type": "application/json" } })
        },
        PUT: async (req) => {
          const state: ReviewState = await req.json()
          await Bun.write(statePath, JSON.stringify(state, null, 2))
          return Response.json({ ok: true })
        },
      },
      "/api/verdicts": {
        POST: async (req) => {
          const state: ReviewState = await req.json()
          await Bun.write(statePath, JSON.stringify(state, null, 2))
          const verdicts = toVerdicts(sessionPath, numbers, state)
          await Bun.write(outPath, JSON.stringify(verdicts, null, 2) + "\n")
          return Response.json({ ok: true, path: outPath })
        },
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  })
  return { url: `http://127.0.0.1:${server.port}/`, server, statePath, outPath }
}

function toVerdicts(sessionPath: string, numbers: number[], state: ReviewState): VerdictsFile {
  return {
    session: sessionPath,
    reviewedAt: new Date().toISOString(),
    prs: numbers.map((number) => {
      const review = state.reviews[number]
      return {
        number,
        verdict: review?.verdict ?? null,
        ...(review?.reason ? { reason: review.reason } : {}),
        notes: (review?.notes ?? []).map((note) => ({
          path: note.path,
          side: note.side === "deletions" ? ("LEFT" as const) : ("RIGHT" as const),
          line: note.line,
          body: note.body,
        })),
        ...(review?.prNote ? { prNote: review.prNote } : {}),
      }
    }),
  }
}
