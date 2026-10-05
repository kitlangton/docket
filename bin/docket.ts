#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { DEFAULT_PORT, ensureServer, health, logPath, parentName, register, stopServer, waitOnce } from "../src/client"
import { resolveSession } from "../src/session"
import type { Registration, Session, VerdictsFile } from "../src/types"
import { buildVersion } from "../src/version"

const USAGE = `docket: review a queue of PRs in the browser, then hand back verdicts.

Usage:
  docket <manifest.json>             curated session
  docket 123 456 …                   PR numbers
  docket --author @me [--label x] [--state open]
  docket <ref> | docket <base>..<head>   local branch or range
  docket open                        open the inbox
  docket server status|stop|restart  manage the background server

Options:
  --repo <path>   Git checkout to use (default: the current directory)
  --out <path>    Where to write verdicts.json
  --port <n>      Server port (default: $DOCKET_PORT or ${DEFAULT_PORT})
  --no-open       Don't open the browser
  --refresh       Ignore the PR cache

Every session lives in one background server at http://docket.localhost:<port>, which starts on
demand and stops after 30 idle minutes. docket waits until the session is handed back (w on the
summary screen), prints the verdicts, and exits 0. Ctrl-C also exits 0 and leaves the session open.`

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
    // Accepted and ignored: servers spawned by older clients still pass it.
    "idle-ms": { type: "string" },
  },
})

const port = Number(args.values.port ?? process.env.DOCKET_PORT ?? DEFAULT_PORT)
const [command, subcommand] = args.positionals

if (args.values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (command === "server") await serverCommand(subcommand)
else if (command === "open" && args.positionals.length === 1) await openInbox()
else await review()

async function review() {
  const noTarget = !args.positionals.length && !args.values.author && !args.values.label && !args.values.state
  if (noTarget) {
    console.log(USAGE)
    process.exit(1)
  }
  const [session, version, agent] = await Promise.all([
    resolveSession({ ...args.values, positionals: args.positionals }).catch(fail),
    buildVersion(),
    parentName(),
  ])
  await ensureServer(port, { version }).catch(fail)
  const registration = { session, cwd: process.cwd(), agent, refresh: args.values.refresh }
  const registered = await register(port, registration).catch(fail)
  console.log(`docket ${registered.url}`)
  console.log(`  state ${session.statePath}`)
  if (args.values.open && !registered.focused) Bun.spawn(["open", registered.url], { stdout: "ignore", stderr: "ignore" })

  const close = () => {
    console.log(`docket: closed without hand-back; progress saved in ${session.statePath}`)
    process.exit(0)
  }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
  await waitForHandback(session, registration)
}

/**
 * Blocks until the session is handed back or closed. If the server goes away (a restart onto new code), it
 * reconnects, starting a server if none comes back; it registers again only if that server doesn't know the session.
 */
async function waitForHandback(session: Session, registration: Registration) {
  for (;;) {
    const event = await waitOnce(port, session.id)
    if (event?.type === "handback") {
      console.log(summarize(event.verdicts))
      console.log(`verdicts: ${event.outPath}`)
      process.exit(0)
    }
    if (event?.type === "closed") {
      console.log(`docket: closed without hand-back; progress saved in ${event.statePath}`)
      process.exit(0)
    }
    await Bun.sleep(500)
    if (event?.type === "missing") await register(port, { ...registration, refresh: false }).catch(() => undefined)
    else await ensureServer(port).catch(() => undefined)
  }
}

async function openInbox() {
  const running = await ensureServer(port, { version: await buildVersion() }).catch(fail)
  console.log(`docket ${running.url}`)
  if (args.values.open) Bun.spawn(["open", running.url], { stdout: "ignore", stderr: "ignore" })
}

async function serverCommand(action: string | undefined) {
  if (action === "run") {
    const { serve } = await import("../src/server")
    const started = await serve({ port, version: await buildVersion() })
    console.log(`docket server ${started.url} (pid ${process.pid})`)
    return
  }
  if (action === "status") {
    const running = await health(port).catch(fail)
    if (!running) {
      console.log(`docket server: not running on port ${port}`)
      process.exit(1)
    }
    const current = await buildVersion()
    console.log(
      `docket server ${running.url} (pid ${running.pid}, version ${running.version}${running.version === current ? "" : `, this checkout is ${current}`})`,
    )
    console.log(`  log ${logPath()}`)
    return
  }
  if (action === "stop") {
    console.log((await stopServer(port, "stop").catch(fail)) ? "docket server: stopped" : `docket server: not running on port ${port}`)
    return
  }
  if (action === "restart") {
    await stopServer(port, "restart").catch(fail)
    const running = await ensureServer(port, { version: await buildVersion() }).catch(fail)
    console.log(`docket server ${running.url} (pid ${running.pid})`)
    return
  }
  console.error("usage: docket server status|stop|restart")
  process.exit(1)
}

function fail(error: unknown): never {
  console.error(`docket: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

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
