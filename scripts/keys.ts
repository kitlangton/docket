// Regenerates the README key table from web/keymap.ts. With --check, fails if the README is stale.
import { readmeTable } from "../web/keymap"

const path = new URL("../README.md", import.meta.url).pathname
const readme = await Bun.file(path).text()
const next = readme.replace(/<!-- keys:start -->[\s\S]*<!-- keys:end -->/, `<!-- keys:start -->\n${readmeTable()}\n<!-- keys:end -->`)
if (Bun.argv.includes("--check")) {
  if (next !== readme) {
    console.error("README key table is out of date; run `bun run keys`")
    process.exit(1)
  }
  process.exit(0)
}
await Bun.write(path, next)
