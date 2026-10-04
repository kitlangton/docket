import { manifestItems } from "./load"
import { itemId, sizeOf, type ItemLoad, type Manifest, type ReviewState, type VerdictsFile } from "./types"

/** Reads review state; a session without a state file starts empty. */
export async function readState(path: string): Promise<ReviewState> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { version: 2, current: null, reviews: {} }
  return file.json()
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
