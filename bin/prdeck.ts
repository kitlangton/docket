#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { serve } from "../src/server"

const USAGE = `Usage: prdeck <session.json> [options]

Options:
  --port <n>     Port to listen on (default: a free port)
  --out <path>   Where to write verdicts (default: verdicts.json next to the session)
  --no-open      Do not open the browser
  --refresh      Ignore the cache and reload every PR
  -h, --help     Show this help`

const args = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  allowNegative: true,
  options: {
    port: { type: "string" },
    out: { type: "string" },
    open: { type: "boolean", default: true },
    refresh: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

const sessionPath = args.positionals[0]
if (args.values.help || !sessionPath) {
  console.log(USAGE)
  process.exit(args.values.help ? 0 : 1)
}
if (!(await Bun.file(sessionPath).exists())) {
  console.error(`prdeck: session file not found: ${sessionPath}`)
  process.exit(1)
}

const started = await serve({
  sessionPath,
  outPath: args.values.out,
  port: args.values.port ? Number(args.values.port) : 0,
  refresh: args.values.refresh,
})

console.log(`prdeck  ${started.url}`)
console.log(`  state     ${started.statePath}`)
console.log(`  verdicts  ${started.outPath}`)
if (args.values.open) Bun.spawn(["open", started.url], { stdout: "ignore", stderr: "ignore" })
