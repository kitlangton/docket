import { rename } from "node:fs/promises"
import { manifestItems } from "./load"
import { itemId, sizeOf, type ItemLoad, type Manifest, type ReviewState, type VerdictsFile } from "./types"

/** Reads review state. A session without a state file starts empty; an unreadable one is moved aside first. */
export async function readState(path: string): Promise<ReviewState> {
  const empty: ReviewState = { version: 2, current: null, reviews: {} }
  const file = Bun.file(path)
  if (!(await file.exists())) return empty
  return file.json().catch(async (error: unknown) => {
    const aside = `${path}.unreadable-${Date.now()}`
    // Two readers can race here; whichever renames first logs it.
    if (
      await rename(path, aside).then(
        () => true,
        () => false,
      )
    )
      console.error(`docket: ${path} is unreadable (${error}); moved it to ${aside}`)
    return empty
  })
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
