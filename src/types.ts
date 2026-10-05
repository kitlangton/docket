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

type Size = "S" | "M" | "L"

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

type ItemState = "OPEN" | "MERGED" | "CLOSED" | "LOCAL"

export type ItemMeta = {
  id: string
  number?: number
  title: string
  /** True when `title` is a git ref, which must be shown verbatim. */
  titleIsRef?: boolean
  body: string
  headRefOid: string
  /** The merge base the diff was taken from. Unknown for diffs from `gh pr diff`, which then can't expand context. */
  baseOid?: string
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
  /** Head commit the note was written against, and the text of its line then, to tell when it is outdated. */
  head?: string
  text?: string
}

export type PrReview = {
  verdict: Verdict | null
  reason?: string
  notes: Note[]
  viewed?: string[]
  /** Head commit at the verdict, or at the last note when there is no verdict. */
  reviewedHead?: string
}

export type ReviewState = {
  version: 2
  current: string | null
  reviews: Record<string, PrReview>
}

export type SessionPayload = {
  id: string
  manifest: Manifest
  outPath: string
  items: Record<string, ItemLoad>
}

type VerdictNote = { body: string } | { path: string; side: "LEFT" | "RIGHT"; startLine?: number; line: number; body: string }

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
    reviewedHead?: string
    currentHead?: string
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
  kind: SessionKind
  title: string
  repo: string
  cwd?: string
  agent?: string
  status: SessionStatus
  total: number
  reviewed: number
  notes: number
  counts: { approve: number; reject: number; skip: number; unreviewed: number }
  updatedAt: string
  /** Pick sessions: the answer so far, and a thumbnail of the first pick. */
  pick?: { picked: string[]; none: boolean; thumb?: string }
}

/** Server events on /api/events, shared by tabs. */
export type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "inbox" }
  | { type: "session"; id: string; version: number }
  | { type: "navigate"; id: string }
  | { type: "restart" }
  /** The server was stopped on purpose; it won't come back on its own. */
  | { type: "stopped" }

export type SessionKind = "review" | "pick"

/** A resolved session: what `docket <args>` or `docket pick` registers with the server. */
export type Session = ReviewSession | PickSession

export type ReviewSession = {
  /** Absent in sessions registered before picks existed. */
  kind?: "review"
  /** Stable id: registering the same session again attaches to it. */
  id: string
  manifest: Manifest
  /** Path of the manifest on disk; ad-hoc sessions write a generated one. */
  manifestPath: string
  statePath: string
  outPath: string
}

export type PickSession = {
  kind: "pick"
  id: string
  pick: PickManifest
  manifestPath: string
  statePath: string
  /** Where answer.json goes. */
  outPath: string
}

export type MediaKind = "image" | "video" | "url" | "page" | "text"

/** One thing to look at. `src` is a path relative to the manifest's folder, or a URL for `url`. */
export type PickMedia = { kind: MediaKind; src: string; dark?: string; label: string }

export type PickOption = { id: string; label: string; why?: string; body?: string; media: PickMedia[] }

/** A pick manifest after validation: ids, labels, and media kinds filled in. */
export type PickManifest = {
  title: string
  question?: string
  baseline?: PickMedia
  options: PickOption[]
  previous?: PickAnswer
}

export type PickPosition = { x: number; y: number } | { t: number }

export type PickNote = { id: string; option: string; body: string; media: number; at?: PickPosition }

export type PickState = { version: 1; current: number; picked: string[]; none: boolean; note: string; notes: PickNote[] }

/** answer.json: what the agent reads back. `picked` is in rank order. */
export type PickAnswer = {
  session: string
  answeredAt: string
  picked: string[]
  none: boolean
  note: string
  notes: Omit<PickNote, "id">[]
}

/** Where the server serves a pick session's file (`src` relative to the manifest's folder). */
export function mediaUrl(session: string, src: string) {
  return `/api/s/${encodeURIComponent(session)}/media/${src.split("/").map(encodeURIComponent).join("/")}`
}

export type PickPayload = { id: string; kind: "pick"; pick: PickManifest; outPath: string }

/** Identifies a docket server at /api/health, so an unrelated process on the port isn't mistaken for one. */
export const APP_ID = "docket"

/** What `docket <args>` sends to register a session. */
export type Registration = { session: Session; cwd?: string; agent?: string; refresh?: boolean }

/** Events a waiting client receives on /api/s/:id/wait. */
export type WaitEvent =
  | { type: "hello"; version: string }
  | { type: "handback"; verdicts: VerdictsFile; outPath: string }
  | { type: "answer"; answer: PickAnswer; outPath: string }
  | { type: "closed"; statePath: string }
