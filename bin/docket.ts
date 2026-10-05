#!/usr/bin/env bun
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { DEFAULT_PORT, ensureServer, health, logPath, parentName, register, stopServer, waitOnce } from "../src/client"
import { answerSummary, resolvePick } from "../src/pick"
import { resolveSession } from "../src/session"
import type { PickAnswer, PickSession, Registration, Session, VerdictsFile } from "../src/types"
import { buildVersion } from "../src/version"

const USAGE = `docket: review a queue of PRs in the browser, then hand back verdicts.

Usage:
  docket <manifest.json>             curated session
  docket 123 456 …                   PR numbers
  docket --author @me [--label x] [--state open]
  docket <ref> | docket <base>..<head>   local branch or range
  docket pick <manifest.json>        choose between options; writes answer.json
  docket open                        open the inbox
  docket server status|stop|restart  manage the background server

Options:
  --repo <path>   Git checkout to use (default: the current directory)
  --out <path>    Where to write verdicts.json
  --port <n>      Server port (default: $DOCKET_PORT or ${DEFAULT_PORT})
  --no-open       Don't open the browser
  --refresh       Ignore the PR cache
  --timeout <d>   pick: stop waiting after this long (90s, 10m, 1h); the pick stays in the inbox

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
    timeout: { type: "string" },
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
else if (command === "pick") await pick()
else await review()

async function review() {
  const noTarget = !args.positionals.length && !args.values.author && !args.values.label && !args.values.state
  if (noTarget) {
    console.log(USAGE)
    process.exit(1)
  }
  await runSession(resolveSession({ ...args.values, positionals: args.positionals }))
}

async function pick() {
  const path = args.positionals[1]
  if (!path || args.positionals.length > 2) {
    console.log(USAGE)
    process.exit(1)
  }
  const timeout = args.values.timeout === undefined ? undefined : parseDuration(args.values.timeout)
  if (timeout === undefined && args.values.timeout !== undefined) fail(`--timeout: expected a duration like 90s, 10m, or 1h`)
  await runSession(resolvePick(resolve(path), args.values.out), timeout)
}

/** Registers the session, prints its links, and blocks until it is handed back, closed, or times out. */
async function runSession(resolving: Promise<Session>, timeout?: number) {
  const [session, version, agent] = await Promise.all([resolving.catch(fail), buildVersion(), parentName()])
  await ensureServer(port, { version }).catch(fail)
  const registration = { session, cwd: process.cwd(), agent, refresh: args.values.refresh }
  const registered = await register(port, registration).catch(fail)
  console.log(`docket ${registered.url}`)
  if (registered.tailnetUrl) console.log(`  tailnet ${registered.tailnetUrl}`)
  console.log(`  state ${session.statePath}`)
  if (args.values.open && !registered.focused) Bun.spawn(["open", registered.url], { stdout: "ignore", stderr: "ignore" })

  const close = () => {
    console.log(closedMessage(session, session.statePath))
    process.exit(0)
  }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
  if (timeout !== undefined)
    setTimeout(() => {
      console.log(`docket: timed out; the session stays open in the inbox: ${registered.tailnetUrl ?? registered.url}`)
      process.exit(0)
    }, timeout)
  await waitForHandback(session, registration)
}

function closedMessage(session: Session, statePath: string) {
  return `docket: closed without ${session.kind === "pick" ? "answer" : "hand-back"}; progress saved in ${statePath}`
}

/** "90s", "10m", "1h", "500ms", or bare seconds. */
function parseDuration(text: string) {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  if (!match) return undefined
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "ms" | "s" | "m" | "h"]
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
    if (event?.type === "answer" && session.kind === "pick") {
      console.log(summarizeAnswer(event.answer, session))
      console.log(`answer: ${event.outPath}`)
      process.exit(0)
    }
    if (event?.type === "closed") {
      console.log(closedMessage(session, event.statePath))
      process.exit(0)
    }
    await Bun.sleep(500)
    // Something other than docket on the port won't go away by retrying.
    const running = await health(port).catch(fail)
    if (event?.type === "missing" && running) await register(port, { ...registration, refresh: false }).catch(() => undefined)
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
    const started = await serve({ port, version: await buildVersion() }).catch((error: { code?: string }) => {
      // Another server won the port, maybe started by a client racing this one; it serves everyone.
      if (error.code !== "EADDRINUSE") throw error
      console.log(`docket server: port ${port} already has a server`)
      process.exit(0)
    })
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

function summarizeAnswer(answer: PickAnswer, session: PickSession) {
  const label = (id: string) => session.pick.options.find((option) => option.id === id)?.label ?? id
  const picked = answer.picked.map((id, rank) => `  ${rank + 1}. ${id} ${label(id)}`)
  const notes = answer.notes.map((note) => {
    const at = !note.at
      ? ""
      : "t" in note.at
        ? ` @${note.at.t.toFixed(1)}s`
        : ` @${Math.round(note.at.x * 100)}%,${Math.round(note.at.y * 100)}%`
    return `  note ${note.option}${at}: ${note.body.split("\n")[0]}`
  })
  const overall = answer.note ? [`  note: ${answer.note.split("\n")[0]}`] : []
  return [`docket: ${answerSummary(answer)}`, ...picked, ...overall, ...notes].join("\n")
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
