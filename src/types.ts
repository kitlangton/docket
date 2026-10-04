export type ManifestItem = {
  /** GitHub pull request number. */
  number?: number
  /** Local git ref or `base..head` range, for work that is not on GitHub. */
  ref?: string
  why?: string
  after?: number[]
  focus?: string[]
}

export type ManifestGroup = {
  title: string
  why?: string
  prs: ManifestItem[]
}

export type Manifest = {
  title: string
  summary?: string
  repo: { path: string; github?: string; base?: string }
  groups: ManifestGroup[]
}

export type ItemState = "OPEN" | "MERGED" | "CLOSED" | "LOCAL"

export type ItemMeta = {
  id: string
  number?: number
  ref?: string
  title: string
  body: string
  headRefName: string
  headRefOid: string
  baseRefName: string
  url?: string
  state: ItemState
  additions: number
  deletions: number
  changedFiles: number
  commits?: number
}

export type ItemData = {
  meta: ItemMeta
  patch: string
  patchIgnoreWhitespace: string
  source: "git" | "gh"
}

export type ItemLoad = { ok: true; data: ItemData } | { ok: false; id: string; error: string }

export type Verdict = "approve" | "reject" | "skip"

export type Side = "additions" | "deletions"

/** A note on the whole PR has no `path`; a line note has `path`, `side`, and `line`; a range note adds `startLine`. */
export type Note = {
  id: string
  body: string
  path?: string
  side?: Side
  startLine?: number
  line?: number
}

export type PrReview = {
  verdict: Verdict | null
  reason?: string
  notes: Note[]
  viewed?: string[]
}

export type ReviewState = {
  version: 2
  current: string | null
  reviews: Record<string, PrReview>
}

export type Progress = { done: number; total: number; phase: string }

export type SessionPayload = {
  manifest: Manifest
  label: string
  statePath: string
  outPath: string
  progress: Progress
  version: number
  items: Record<string, ItemLoad>
}

export type VerdictNote =
  | { body: string }
  | { path: string; side: "LEFT" | "RIGHT"; startLine?: number; line: number; body: string }

export type VerdictsFile = {
  session: string
  reviewedAt: string
  prs: {
    number?: number
    ref?: string
    title?: string
    verdict: Verdict | null
    reason?: string
    notes: VerdictNote[]
  }[]
}

export function itemId(item: ManifestItem) {
  if (item.number !== undefined) return String(item.number)
  return `ref:${item.ref}`
}

export function itemLabel(item: ManifestItem) {
  if (item.number !== undefined) return `#${item.number}`
  return item.ref ?? ""
}
