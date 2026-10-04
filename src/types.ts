export type ManifestPr = {
  number: number
  why: string
  after?: number[]
  focus?: string[]
}

export type ManifestGroup = {
  title: string
  why?: string
  prs: ManifestPr[]
}

export type Manifest = {
  title: string
  summary?: string
  repo: { path: string; github: string; base: string }
  groups: ManifestGroup[]
}

export type PrMeta = {
  number: number
  title: string
  body: string
  headRefName: string
  headRefOid: string
  baseRefName: string
  url: string
  state: "OPEN" | "MERGED" | "CLOSED"
  additions: number
  deletions: number
  changedFiles: number
}

export type PrData = {
  meta: PrMeta
  patch: string
  patchIgnoreWhitespace: string
  source: "git" | "gh"
}

export type PrLoad = { ok: true; data: PrData } | { ok: false; number: number; error: string }

export type Verdict = "approve" | "reject" | "skip"

export type Side = "additions" | "deletions"

export type Note = {
  id: string
  path: string
  side: Side
  line: number
  body: string
}

export type PrReview = {
  verdict: Verdict | null
  reason?: string
  notes: Note[]
  prNote?: string
}

export type ReviewState = {
  current: number | null
  reviews: Record<string, PrReview>
}

export type Progress = { done: number; total: number; phase: string }

export type SessionPayload = {
  manifest: Manifest
  sessionPath: string
  outPath: string
  progress: Progress
  version: number
  prs: Record<string, PrLoad>
}

export type VerdictsFile = {
  session: string
  reviewedAt: string
  prs: {
    number: number
    verdict: Verdict | null
    reason?: string
    notes: { path: string; side: "LEFT" | "RIGHT"; line: number; body: string }[]
    prNote?: string
  }[]
}
