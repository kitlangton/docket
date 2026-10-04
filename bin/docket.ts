#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { serve } from "../src/server"
import { resolveSession } from "../src/session"
import type { VerdictsFile } from "../src/types"

const USAGE = `docket: review a queue of PRs in the browser, then hand back verdicts.

Usage:
  docket <manifest.json>             curated session
  docket 123 456 …                   PR numbers
  docket --author @me [--label x] [--state open]
  docket <ref> | docket <base>..<head>   local branch or range

Options:
  --repo <path>   Git checkout to use (default: the current directory)
  --out <path>    Where to write verdicts.json
  --port <n>      Port (default: any free port)
  --no-open       Don't open the browser
  --refresh       Ignore the PR cache

Exits 0 after hand-back (w on the summary screen) or Ctrl-C.`

const args = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  allowNegative: true,
  options: {
    repo: { type: "string" },
    out: { type: "string" },
    port: { type: "string" },
    author: { type: "string" },
    label: { type: "string" },
    state: { type: "string" },
    open: { type: "boolean", default: true },
    refresh: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

const noTarget = !args.positionals.length && !args.values.author && !args.values.label && !args.values.state
if (args.values.help || noTarget) {
  console.log(USAGE)
  process.exit(args.values.help ? 0 : 1)
}

const session = await resolveSession({ ...args.values, positionals: args.positionals }).catch((error: unknown) => {
  console.error(`docket: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})

const started = await serve({
  session,
  port: args.values.port ? Number(args.values.port) : 0,
  refresh: args.values.refresh,
  onClose: () => close(),
  onHandback: (verdicts) => {
    console.log(summarize(verdicts))
    console.log(`verdicts: ${session.outPath}`)
    process.exit(0)
  },
})

console.log(`docket ${started.url}`)
console.log(`  state ${session.statePath}`)
if (args.values.open) Bun.spawn(["open", started.url], { stdout: "ignore", stderr: "ignore" })

function close() {
  console.log(`docket: closed without hand-back; progress saved in ${session.statePath}`)
  process.exit(0)
}
process.on("SIGINT", close)
process.on("SIGTERM", close)

function summarize(verdicts: VerdictsFile) {
  const count = (verdict: string | null) => verdicts.prs.filter((pr) => pr.verdict === verdict).length
  const totals = [
    `${count("approve")} approved`,
    `${count("reject")} rejected`,
    `${count("skip")} skipped`,
    `${count(null)} unreviewed`,
  ].join(", ")
  const lines = verdicts.prs.map((pr) => {
    const label = pr.number !== undefined ? `#${pr.number}` : (pr.ref ?? "")
    const notes = pr.notes.length ? ` (${pr.notes.length} note${pr.notes.length === 1 ? "" : "s"})` : ""
    const reason = pr.reason ? ` — ${pr.reason}` : ""
    const title = pr.title && pr.title !== label ? ` ${pr.title}` : ""
    return `  ${(pr.verdict ?? "-").padEnd(8)} ${label.padEnd(8)}${title}${notes}${reason}`
  })
  return [`docket: handed back ${verdicts.prs.length} item${verdicts.prs.length === 1 ? "" : "s"}: ${totals}`, ...lines].join("\n")
}
