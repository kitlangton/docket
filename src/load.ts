import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Manifest, PrData, PrLoad, PrMeta } from "./types"

const META_FIELDS = "number,title,body,headRefName,headRefOid,baseRefName,url,state,additions,deletions,changedFiles"
const CONCURRENCY = 6

export type LoadEvents = {
  phase: (phase: string) => void
  loaded: (load: PrLoad) => void
}

export function prNumbers(manifest: Manifest) {
  return manifest.groups.flatMap((group) => group.prs.map((pr) => pr.number))
}

/** Returns cached PR data for every PR that has a cache entry. */
export async function readCache(manifest: Manifest) {
  const entries = await Promise.all(
    prNumbers(manifest).map(async (number) => {
      const file = Bun.file(cachePath(manifest, number))
      if (!(await file.exists())) return undefined
      const data: PrData = await file.json()
      return data
    }),
  )
  return entries.filter((entry) => entry !== undefined)
}

/** Loads metadata and diffs for every PR from gh and local git, writing the cache as it goes. */
export async function loadAll(manifest: Manifest, events: LoadEvents) {
  const numbers = prNumbers(manifest)
  events.phase("Reading PR metadata")
  const metas = await mapBounded(numbers, CONCURRENCY, (number) =>
    viewPr(manifest, number).catch((error: unknown) => ({ number, error: String(error) })),
  )
  const failed = metas.filter((meta) => "error" in meta)
  failed.forEach((meta) => events.loaded({ ok: false, number: meta.number, error: meta.error }))
  const ok = metas.filter((meta): meta is PrMeta => !("error" in meta))

  events.phase("Fetching refs")
  const fetched = await fetchRefs(manifest, ok)

  events.phase("Computing diffs")
  await mapBounded(ok, CONCURRENCY, async (meta) => {
    const load = await diffPr(manifest, meta, fetched).catch(
      (error: unknown): PrLoad => ({ ok: false, number: meta.number, error: String(error) }),
    )
    if (load.ok) await writeCache(manifest, load.data)
    events.loaded(load)
  })
  events.phase("Ready")
}

async function viewPr(manifest: Manifest, number: number) {
  const out = await run(["gh", "pr", "view", String(number), "--repo", manifest.repo.github, "--json", META_FIELDS])
  const meta: PrMeta = JSON.parse(out)
  return meta
}

async function fetchRefs(manifest: Manifest, metas: PrMeta[]) {
  const git = gitIn(manifest)
  const missing = await Promise.all(
    metas.map(async (meta) => ((await hasCommit(manifest, meta.headRefOid)) ? undefined : meta.number)),
  )
  const refspecs = missing.filter((number) => number !== undefined).map((number) => `pull/${number}/head`)
  const base = manifest.repo.base
  return run([...git, "fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, ...refspecs])
    .then(() => true)
    .catch(() => false)
}

async function diffPr(manifest: Manifest, meta: PrMeta, fetched: boolean): Promise<PrLoad> {
  const git = gitIn(manifest)
  const local = fetched || (await hasCommit(manifest, meta.headRefOid))
  if (!local) return diffFromGh(manifest, meta)
  const base = await run([...git, "merge-base", `origin/${manifest.repo.base}`, meta.headRefOid]).catch(() => "")
  if (!base.trim()) return diffFromGh(manifest, meta)
  const args = ["diff", "--no-color", "--no-ext-diff", "-M", base.trim(), meta.headRefOid]
  const [patch, patchIgnoreWhitespace] = await Promise.all([run([...git, ...args]), run([...git, ...args, "-w"])])
  return { ok: true, data: { meta, patch, patchIgnoreWhitespace, source: "git" } }
}

async function diffFromGh(manifest: Manifest, meta: PrMeta): Promise<PrLoad> {
  const patch = await run(["gh", "pr", "diff", String(meta.number), "--repo", manifest.repo.github])
  return { ok: true, data: { meta, patch, patchIgnoreWhitespace: patch, source: "gh" } }
}

async function hasCommit(manifest: Manifest, oid: string) {
  const proc = Bun.spawn([...gitIn(manifest), "cat-file", "-e", `${oid}^{commit}`], { stdout: "ignore", stderr: "ignore" })
  return (await proc.exited) === 0
}

function gitIn(manifest: Manifest) {
  return ["git", "-C", manifest.repo.path]
}

async function run(cmd: string[]) {
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

function cacheDir(manifest: Manifest) {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "prdeck", manifest.repo.github.replace("/", "__"))
}

function cachePath(manifest: Manifest, number: number) {
  return join(cacheDir(manifest), `${number}.json`)
}

async function writeCache(manifest: Manifest, data: PrData) {
  await mkdir(cacheDir(manifest), { recursive: true })
  await Bun.write(cachePath(manifest, data.meta.number), JSON.stringify(data))
}
