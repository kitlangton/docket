import { join } from "node:path"

/** A throwaway git repo with a `main` base and two feature branches (`feature`, `second`); leaves `feature` checked out. */
export async function makeRepo(dir: string) {
  const git = (...args: string[]) => run(["git", "-c", "user.name=docket", "-c", "user.email=docket@example.com", ...args], dir)
  await git("init", "-q", "-b", "main")
  await Bun.write(
    join(dir, "app.ts"),
    lines(120, (n) => `export const line${n} = 0`),
  )
  await Bun.write(
    join(dir, "other.ts"),
    lines(40, (n) => `export const other${n} = 1`),
  )
  await git("add", ".")
  await git("commit", "-qm", "base")
  await git("checkout", "-qb", "feature")
  await edit(dir, "app.ts", { 50: "export const line50 = 50", 90: "export const line90 = 90" })
  await edit(dir, "other.ts", { 10: "export const other10 = 10" })
  await git("commit", "-qam", "feat: tune lines\n\nWhy:\n- line 50 needed a value\n- so did line 90")
  await git("checkout", "-q", "main")
  await git("checkout", "-qb", "second")
  await edit(dir, "app.ts", { 20: "export const line20 = 20" })
  await Bun.write(join(dir, "new.ts"), "export const fresh = true\n")
  await git("add", ".")
  await git("commit", "-qm", "feat: add new.ts")
  await git("checkout", "-q", "feature")
  return { dir, git }
}

export async function edit(dir: string, file: string, changes: Record<number, string>) {
  const path = join(dir, file)
  const text = await Bun.file(path).text()
  const next = text
    .split("\n")
    .map((line, index) => changes[index + 1] ?? line)
    .join("\n")
  await Bun.write(path, next)
}

function lines(count: number, line: (n: number) => string) {
  return Array.from({ length: count }, (_, index) => line(index + 1)).join("\n") + "\n"
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${err}`)
}
