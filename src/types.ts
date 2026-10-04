export type ManifestItem = {
  /** GitHub pull request number. */
  number?: number
  /** Local git ref or `base..head` range, for work that is not on GitHub. */
  ref?: string
  why?: string
  after?: number[]
  focus?: string[]
  /** How sure the author is that the change is right. */
  confidence?: Confidence
  /** One line on what could go wrong. */
  risk?: string
}

export type Confidence = "high" | "medium" | "low"

export type Size = "S" | "M" | "L"

/** S: at most 50 changed lines and 3 files. L: more than 400 lines or 15 files. M: everything between. */
export function sizeOf(meta: { additions: number; deletions: number; changedFiles: number }): Size {
  const lines = meta.additions + meta.deletions
  if (lines <= 50 && meta.changedFiles <= 3) return "S"
  if (lines > 400 || meta.changedFiles > 15) return "L"
  return "M"
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
  /** True when `title` is a git ref, which must be shown verbatim. */
  titleIsRef?: boolean
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
  id: string
  manifest: Manifest
  label: string
  statePath: string
  outPath: string
  progress: Progress
  version: number
  items: Record<string, ItemLoad>
}

export type VerdictNote = { body: string } | { path: string; side: "LEFT" | "RIGHT"; startLine?: number; line: number; body: string }

export type VerdictsFile = {
  session: string
  reviewedAt: string
  prs: {
    number?: number
    ref?: string
    title?: string
    confidence?: Confidence
    size?: Size
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

export type SessionStatus = "waiting" | "progress" | "done"

/** One row of the home inbox. */
export type InboxEntry = {
  id: string
  title: string
  repo: string
  cwd?: string
  agent?: string
  status: SessionStatus
  total: number
  reviewed: number
  notes: number
  counts: { approve: number; reject: number; skip: number; unreviewed: number }
  registeredAt: string
  updatedAt: string
  handedBackAt?: string
}

/** Server events on /api/events, shared by tabs. */
export type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "inbox" }
  | { type: "session"; id: string; version: number }
  | { type: "navigate"; id: string }
  | { type: "restart" }
