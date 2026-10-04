import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { itemId, type ItemData, type ItemLoad, type ItemMeta, type Manifest, type ManifestItem } from "./types"

const META_FIELDS = "number,title,body,headRefName,headRefOid,baseRefName,url,state,additions,deletions,changedFiles"
const CONCURRENCY = 6
const MAX_PATCH_BYTES = 30_000_000

type GhPr = Omit<ItemMeta, "id" | "number" | "ref" | "commits"> & { number: number }

export type LoadEvents = {
  phase: (phase: string) => void
  loaded: (load: ItemLoad) => void
}

export function manifestItems(manifest: Manifest) {
  return manifest.groups.flatMap((group) => group.prs)
}

/** Returns cached data for every pull request that has a cache entry. Local refs are never cached. */
export async function readCache(manifest: Manifest) {
  const entries = await Promise.all(
    manifestItems(manifest).map(async (item) => {
      if (item.number === undefined || !manifest.repo.github) return undefined
      const file = Bun.file(cachePath(manifest.repo.github, item.number))
      if (!(await file.exists())) return undefined
      const data: ItemData = await file.json()
      return data
    }),
  )
  return entries.filter((entry) => entry !== undefined)
}

/** Loads metadata and diffs for every item, writing the cache for pull requests as it goes. */
export async function loadAll(manifest: Manifest, events: LoadEvents) {
  const items = manifestItems(manifest)
  const refs = items.filter((item) => item.number === undefined)
  const numbers = items.flatMap((item) => (item.number === undefined ? [] : [item.number]))

  await mapBounded(refs, CONCURRENCY, async (item) =>
    events.loaded(await loadRef(manifest, item).catch((error: unknown) => failed(item, error))),
  )
  if (!numbers.length) return events.phase("Ready")

  events.phase("Reading PR metadata")
  const metas = await mapBounded(numbers, CONCURRENCY, (number) =>
    viewPr(manifest, number).catch((error: unknown) => {
      events.loaded(failed({ number }, error))
      return undefined
    }),
  )
  const ok = metas.filter((meta) => meta !== undefined)

  events.phase("Fetching refs")
  const fetched = await fetchRefs(manifest, ok)

  events.phase("Computing diffs")
  await mapBounded(ok, CONCURRENCY, async (meta) => {
    const load = await diffPr(manifest, meta, fetched).catch((error: unknown) => failed({ number: meta.number }, error))
    if (load.ok && manifest.repo.github) await writeCache(manifest.repo.github, load.data)
    events.loaded(load)
  })
  events.phase("Ready")
}

function failed(item: ManifestItem, error: unknown): ItemLoad {
  return { ok: false, id: itemId(item), error: error instanceof Error ? error.message : String(error) }
}

async function viewPr(manifest: Manifest, number: number): Promise<ItemMeta> {
  const out = await run(["gh", "pr", "view", String(number), "--repo", requireGithub(manifest), "--json", META_FIELDS])
  const pr: GhPr = JSON.parse(out)
  return { ...pr, id: String(number) }
}

async function fetchRefs(manifest: Manifest, metas: ItemMeta[]) {
  const missing = await Promise.all(metas.map(async (meta) => ((await hasCommit(manifest, meta.headRefOid)) ? [] : [meta.number])))
  const heads = missing.flat().map((number) => `pull/${number}/head`)
  const bases = [...new Set(metas.map((meta) => meta.baseRefName))].map((base) => `+refs/heads/${base}:refs/remotes/origin/${base}`)
  return run([...git(manifest), "fetch", "--no-tags", "--quiet", "origin", ...bases, ...heads])
    .then(() => true)
    .catch(() => false)
}

async function diffPr(manifest: Manifest, meta: ItemMeta, fetched: boolean): Promise<ItemLoad> {
  const local = fetched || (await hasCommit(manifest, meta.headRefOid))
  if (!local) return diffFromGh(manifest, meta)
  const base = await mergeBase(manifest, `origin/${meta.baseRefName}`, meta.headRefOid).catch(() => "")
  if (!base) return diffFromGh(manifest, meta)
  const [patch, patchIgnoreWhitespace] = await diffPair(manifest, base, meta.headRefOid)
  return { ok: true, data: { meta, patch, patchIgnoreWhitespace, source: "git" } }
}

async function diffFromGh(manifest: Manifest, meta: ItemMeta): Promise<ItemLoad> {
  const patch = await run(["gh", "pr", "diff", String(meta.number), "--repo", requireGithub(manifest)])
  return { ok: true, data: { meta, patch, patchIgnoreWhitespace: patch, source: "gh" } }
}

/** Diffs a local ref against its merge base: `head` alone uses the repo's default base. */
async function loadRef(manifest: Manifest, item: ManifestItem): Promise<ItemLoad> {
  const spec = item.ref ?? "HEAD"
  const [baseSpec, headSpec] = spec.includes("..") ? spec.split(/\.\.\.?/) : [await defaultBase(manifest, spec), spec]
  const base = baseSpec || "HEAD"
  const head = headSpec || "HEAD"
  const [headOid, mb] = await Promise.all([revParse(manifest, head), mergeBase(manifest, base, head)])
  const [[patch, patchIgnoreWhitespace], branch, subject, commits, numstat] = await Promise.all([
    diffPair(manifest, mb, headOid),
    run([...git(manifest), "rev-parse", "--abbrev-ref", head])
      .then((out) => out.trim())
      .catch(() => ""),
    run([...git(manifest), "log", "-1", "--format=%s", headOid]).then((out) => out.trim()),
    run([...git(manifest), "rev-list", "--count", `${mb}..${headOid}`]).then((out) => Number(out.trim())),
    run([...git(manifest), "diff", "--numstat", "-M", mb, headOid]),
  ])
  if (patch.length > MAX_PATCH_BYTES)
    throw new Error(`diff is too large to review (${Math.round(patch.length / 1e6)} MB); pass a narrower <base>..<head>`)
  const stats = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").map(Number))
  const isBranch = branch && branch !== "HEAD" && !/^[0-9a-f]{7,40}$/.test(head)
  const meta: ItemMeta = {
    id: itemId(item),
    ref: spec,
    title: isBranch ? branch : subject,
    body: "",
    headRefName: isBranch ? branch : head,
    headRefOid: headOid,
    baseRefName: base,
    state: "LOCAL",
    additions: stats.reduce((sum, row) => sum + (row[0] || 0), 0),
    deletions: stats.reduce((sum, row) => sum + (row[1] || 0), 0),
    changedFiles: stats.length,
    commits,
  }
  return { ok: true, data: { meta, patch, patchIgnoreWhitespace, source: "git" } }
}

/**
 * Picks the base a local ref most likely branched from: among the remote's default branch and
 * conventionally named trunk branches, the one leaving the fewest commits on the ref.
 */
export async function defaultBase(manifest: Manifest, head = "HEAD") {
  if (manifest.repo.base) return `origin/${manifest.repo.base}`
  const [originHead, refs] = await Promise.all([
    run([...git(manifest), "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      .then((out) => out.trim())
      .catch(() => ""),
    run([...git(manifest), "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]).catch(() => ""),
  ])
  const trunks = refs
    .split("\n")
    .filter((ref) => /^origin\/(main|master|dev|develop|trunk|next|v\d+[\w.-]*)$/.test(ref))
    .slice(0, 20)
  const candidates = [...new Set([originHead, ...trunks].filter(Boolean))]
  const counts = await Promise.all(
    candidates.map(async (base) => {
      const out = await run([...git(manifest), "rev-list", "--count", `${base}..${head}`]).catch(() => "")
      return { base, count: out ? Number(out.trim()) : Infinity }
    }),
  )
  const best = counts.reduce((min, entry) => (entry.count < min.count ? entry : min), { base: "", count: Infinity })
  if (!best.base) throw new Error("could not find a base branch for this ref; pass <base>..<head>")
  return best.base
}

function diffPair(manifest: Manifest, base: string, head: string) {
  const args = [...git(manifest), "diff", "--no-color", "--no-ext-diff", "-M", base, head]
  return Promise.all([run(args), run([...args, "-w"])])
}

async function mergeBase(manifest: Manifest, base: string, head: string) {
  return (await run([...git(manifest), "merge-base", base, head])).trim()
}

async function revParse(manifest: Manifest, ref: string) {
  return (await run([...git(manifest), "rev-parse", "--verify", `${ref}^{commit}`])).trim()
}

async function hasCommit(manifest: Manifest, oid: string) {
  const proc = Bun.spawn([...git(manifest), "cat-file", "-e", `${oid}^{commit}`], { stdout: "ignore", stderr: "ignore" })
  return (await proc.exited) === 0
}

function git(manifest: Manifest) {
  return ["git", "-C", manifest.repo.path]
}

function requireGithub(manifest: Manifest) {
  if (!manifest.repo.github) throw new Error("No GitHub repository: set repo.github or add an origin remote")
  return manifest.repo.github
}

export async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${err.trim() || `exit ${code}`}`)
  return out
}

async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = []
  const pending = items.entries()
  const worker = async () => {
    for (const [index, item] of pending) results[index] = await fn(item)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function cacheDir(github: string) {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "docket", github.replace("/", "__"))
}

function cachePath(github: string, number: number) {
  return join(cacheDir(github), `${number}.json`)
}

async function writeCache(github: string, data: ItemData) {
  await mkdir(cacheDir(github), { recursive: true })
  await Bun.write(cachePath(github, Number(data.meta.id)), JSON.stringify(data))
}
