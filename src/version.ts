import { Glob } from "bun"
import { join } from "node:path"

export const ROOT = join(import.meta.dir, "..")

/**
 * The running code's identity: package version plus a hash of every source file. A client whose
 * build differs from the server's restarts the server, so the browser never runs stale UI.
 */
export async function buildVersion() {
  const pkg: { version: string } = await Bun.file(join(ROOT, "package.json")).json()
  const files = [...new Glob("{bin,src,web}/**/*.{ts,tsx,css,html}").scanSync({ cwd: ROOT })].sort()
  const contents = await Promise.all(files.map(async (file) => `${file}\0${await Bun.file(join(ROOT, file)).text()}`))
  return `${pkg.version}+${Bun.hash(contents.join("\0")).toString(36)}`
}
