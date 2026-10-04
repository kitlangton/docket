import { parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs"
import { itemId, type Manifest, type ManifestGroup, type ManifestItem, type PrReview, type ReviewState, type Side, type Verdict } from "../src/types"

export type Row = { file: number; side: Side; line: number; kind: "context" | "add" | "del"; block: number | null }
export type Block = { file: number; first: number; last: number; range: SelectedLineRange }
export type PrModel = { files: FileDiffMetadata[]; focus: Set<string>; rows: Row[]; blocks: Block[] }
export type Entry = { id: string; pr: ManifestItem; group: ManifestGroup; index: number }

export const EMPTY_REVIEW: PrReview = { verdict: null, notes: [] }

export function entries(manifest: Manifest) {
  return manifest.groups
    .flatMap((group) => group.prs.map((pr) => ({ id: itemId(pr), pr, group })))
    .map((entry, index) => ({ ...entry, index }))
}

export function buildModel(patch: string, key: string, focusPaths: string[] = []): PrModel {
  const focus = new Set(focusPaths)
  const parsed = parsePatchFiles(patch, key).flatMap((p) => p.files)
  const files = [...parsed.filter((file) => focus.has(file.name)), ...parsed.filter((file) => !focus.has(file.name))]
  const rows: Row[] = []
  const blocks: Block[] = []
  files.forEach((file, fileIndex) =>
    file.hunks.forEach((hunk) => {
      const pos = { old: hunk.deletionStart, new: hunk.additionStart }
      hunk.hunkContent.forEach((content, contentIndex) => {
        if (content.type === "context") {
          range(content.lines).forEach(() => {
            rows.push({ file: fileIndex, side: "additions", line: pos.new, kind: "context", block: null })
            pos.old++
            pos.new++
          })
          return
        }
        // The parser may split one run of -/+ lines into adjacent change groups; treat them as one block.
        const continues = hunk.hunkContent[contentIndex - 1]?.type === "change"
        const block = continues ? blocks.length - 1 : blocks.length
        const first = continues ? blocks[block]!.first : rows.length
        range(content.deletions).forEach(() =>
          rows.push({ file: fileIndex, side: "deletions", line: pos.old++, kind: "del", block }),
        )
        range(content.additions).forEach(() =>
          rows.push({ file: fileIndex, side: "additions", line: pos.new++, kind: "add", block }),
        )
        const start = rows[first]!
        const end = rows[rows.length - 1]!
        blocks[block] = {
          file: fileIndex,
          first,
          last: rows.length - 1,
          range: { start: start.line, side: start.side, end: end.line, endSide: end.side },
        }
      })
    }),
  )
  return { files, focus, rows, blocks }
}

/**
 * Where a note on rows `a..b` attaches: the side of the last selected row, spanning that side's
 * lines in the selection. GitHub review comments use the same single-side ranges.
 */
export function rangeAnchor(rows: Row[], a: number, b: number) {
  const [from, to] = a <= b ? [a, b] : [b, a]
  const selected = rows.slice(from, to + 1)
  const last = selected.at(-1)!
  const first = selected[0]!
  const startLine = Math.min(...selected.filter((row) => row.side === last.side).map((row) => row.line))
  return {
    side: last.side,
    line: last.line,
    startLine: startLine < last.line ? startLine : undefined,
    selection: { start: first.line, side: first.side, end: last.line, endSide: last.side } satisfies SelectedLineRange,
  }
}

export function noteLocation(note: { path?: string; startLine?: number; line?: number }) {
  if (!note.path) return ""
  const lines = note.startLine ? `${note.startLine}–${note.line}` : `${note.line}`
  return `${note.path.split("/").at(-1)}:${lines}`
}

export function nextUnreviewed(order: string[], state: ReviewState, from: string) {
  const index = order.indexOf(from)
  const rotated = [...order.slice(index + 1), ...order.slice(0, index)]
  return rotated.find((id) => !state.reviews[id]?.verdict)
}

export function noteCount(review: PrReview | undefined) {
  if (!review) return 0
  return review.notes.length
}

export function countVerdicts(order: string[], state: ReviewState) {
  const verdicts = order.map((id) => state.reviews[id]?.verdict ?? null)
  const count = (verdict: Verdict | null) => verdicts.filter((value) => value === verdict).length
  return { approve: count("approve"), reject: count("reject"), skip: count("skip"), unreviewed: count(null) }
}

/** Strips a conventional-commit prefix like `refactor(tui): ` and capitalizes the rest. */
export function displayTitle(title: string) {
  const stripped = title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

function range(length: number) {
  return Array.from({ length }, (_, index) => index)
}
