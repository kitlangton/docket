import { manifestItems } from "./load"
import { itemId, sizeOf, type ItemLoad, type Manifest, type Note, type PrReview, type ReviewState, type VerdictsFile } from "./types"

type LegacyReview = Partial<PrReview> & { prNote?: string }
export type LegacyState = { version?: number; current?: string | number | null; reviews?: Record<string, LegacyReview> }

/** Reads review state, upgrading files written before PR notes joined the notes list. */
export async function readState(path: string): Promise<ReviewState> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { version: 2, current: null, reviews: {} }
  return migrateState(await file.json())
}

/** Upgrades a raw state file: PR notes once lived in `prNote`, and `current` was once a number. */
export function migrateState(raw: LegacyState): ReviewState {
  const reviews = Object.fromEntries(
    Object.entries(raw.reviews ?? {}).map(([id, review]): [string, PrReview] => {
      const notes: Note[] = [...(review.prNote ? [{ id: crypto.randomUUID(), body: review.prNote }] : []), ...(review.notes ?? [])]
      return [
        id,
        { verdict: review.verdict ?? null, reason: review.reason, notes, viewed: review.viewed, reviewedHead: review.reviewedHead },
      ]
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
        ...(review?.reviewedHead ? { reviewedHead: review.reviewedHead } : {}),
        ...(load?.ok ? { currentHead: load.data.meta.headRefOid } : {}),
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
