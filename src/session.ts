import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { run } from "./load"
import type { Manifest, ManifestItem } from "./types"

export type SessionArgs = {
  positionals: string[]
  repo?: string
  out?: string
  author?: string
  label?: string
  state?: string
}

export type Session = {
  manifest: Manifest
  /** Path of the manifest on disk; ad-hoc sessions write a generated one. */
  manifestPath: string
  statePath: string
  outPath: string
}

export async function resolveSession(args: SessionArgs): Promise<Session> {
  const first = args.positionals[0]
  if (first?.endsWith(".json")) return fromManifest(resolve(first), args)
  const repoPath = await repoRoot(args.repo ?? process.cwd())
  const github = await originRepo(repoPath)
  const repo = { path: repoPath, github }
  const adhoc = await adhocManifest(args, repo)
  const dir = join(dataHome(), slug([basename(repoPath), ...adhocKey(args)]))
  await mkdir(dir, { recursive: true })
  const manifestPath = join(dir, "session.json")
  await Bun.write(manifestPath, JSON.stringify(adhoc, null, 2) + "\n")
  return {
    manifest: adhoc,
    manifestPath,
    statePath: join(dir, "session.state.json"),
    outPath: resolve(args.out ?? join(dir, "verdicts.json")),
  }
}

async function fromManifest(path: string, args: SessionArgs): Promise<Session> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`session file not found: ${path}`)
  const manifest: Manifest = await file.json()
  const repoPath = await repoRoot(args.repo ?? manifest.repo.path)
  const github = manifest.repo.github ?? (await originRepo(repoPath))
  return {
    manifest: { ...manifest, repo: { ...manifest.repo, path: repoPath, github } },
    manifestPath: path,
    statePath: join(dirname(path), `${basename(path, ".json")}.state.json`),
    outPath: resolve(args.out ?? join(dirname(path), "verdicts.json")),
  }
}

async function adhocManifest(args: SessionArgs, repo: Manifest["repo"]): Promise<Manifest> {
  const numbers = args.positionals.map((arg) => arg.replace(/^#/, ""))
  if (numbers.length && numbers.every((arg) => /^\d+$/.test(arg))) {
    return group(
      `${repo.github ?? basename(repo.path)} · ${numbers.map((n) => `#${n}`).join(" ")}`,
      repo,
      numbers.map((n) => ({ number: Number(n) })),
    )
  }
  if (!args.positionals.length && (args.author || args.label || args.state)) {
    const listed = await listPrs(args, repo)
    if (!listed.length) throw new Error("gh pr list matched no pull requests")
    return group(
      listTitle(args),
      repo,
      listed.map((number) => ({ number })),
    )
  }
  if (args.positionals.length === 1) {
    const ref = args.positionals[0]!
    await Promise.all(
      ref
        .split(/\.\.\.?/)
        .filter(Boolean)
        .map((part) => verifyRef(repo.path, part)),
    )
    return group(ref, repo, [{ ref }])
  }
  throw new Error("expected a manifest .json, PR numbers, a git ref or range, or --author/--label/--state")
}

function group(title: string, repo: Manifest["repo"], prs: ManifestItem[]): Manifest {
  return { title, repo, groups: [{ title, prs }] }
}

async function listPrs(args: SessionArgs, repo: Manifest["repo"]) {
  if (!repo.github) throw new Error("no GitHub origin remote for --author/--label/--state")
  const filters = [
    ...(args.author ? ["--author", args.author] : []),
    ...(args.label ? ["--label", args.label] : []),
    ...(args.state ? ["--state", args.state] : []),
  ]
  const out = await run(["gh", "pr", "list", "--repo", repo.github, "--limit", "100", "--json", "number", ...filters])
  const prs: { number: number }[] = JSON.parse(out)
  return prs.map((pr) => pr.number)
}

function listTitle(args: SessionArgs) {
  return ["PRs", args.author ? `by ${args.author}` : "", args.label ? `labeled ${args.label}` : "", args.state ? `(${args.state})` : ""]
    .filter(Boolean)
    .join(" ")
}

function adhocKey(args: SessionArgs) {
  if (args.positionals.length) return args.positionals
  return [args.author && `author-${args.author}`, args.label && `label-${args.label}`, args.state && `state-${args.state}`].filter(
    (part): part is string => Boolean(part),
  )
}

function slug(parts: string[]) {
  const text = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (text.length <= 64) return text
  return `${text.slice(0, 52)}-${Bun.hash(text).toString(36).slice(0, 8)}`
}

function dataHome() {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "docket")
}

async function repoRoot(path: string) {
  const out = await run(["git", "-C", resolve(path), "rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error(`not a git repository: ${path} (use --repo)`)
  })
  return out.trim()
}

async function originRepo(repoPath: string) {
  const url = (await run(["git", "-C", repoPath, "remote", "get-url", "origin"]).catch(() => "")).trim()
  return url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

async function verifyRef(repoPath: string, ref: string) {
  await run(["git", "-C", repoPath, "rev-parse", "--verify", `${ref}^{commit}`]).catch(() => {
    throw new Error(`unknown git ref: ${ref}`)
  })
}
