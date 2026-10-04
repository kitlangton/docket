import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"

const ROOT = join(import.meta.dir, "..")
const BIN = join(ROOT, "bin", "docket.ts")

/** A throwaway git repo with a `main` base and two feature branches; no network, no remotes. */
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

export async function run(cmd: string[], cwd: string, env?: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${err || out}`)
  return out
}

/** One isolated docket world: its own port, data and cache dirs, repo, and browser. */
export class World {
  readonly port = 20000 + Math.floor(Math.random() * 20000)
  readonly env: Record<string, string>
  readonly clients: Client[] = []
  browser!: Browser
  page!: Page

  private constructor(
    readonly dir: string,
    readonly repo: string,
  ) {
    this.env = {
      DOCKET_PORT: String(this.port),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      DOCKET_REFRESH_MS: "1000",
      NO_COLOR: "1",
    }
  }

  static async create() {
    const dir = await mkdtemp(join(tmpdir(), "docket-e2e-"))
    const repo = join(dir, "repo")
    await run(["mkdir", "-p", repo], dir)
    await makeRepo(repo)
    const world = new World(dir, repo)
    world.browser = await chromium.launch()
    world.page = await world.browser.newPage({ viewport: { width: 1600, height: 1000 } })
    world.page.on("pageerror", (error) => console.error("pageerror:", error.message))
    return world
  }

  get base() {
    return `http://docket.localhost:${this.port}`
  }

  /** Starts `docket <args>` and resolves once it has printed its URL. */
  async start(...args: string[]) {
    const proc = Bun.spawn(["bun", BIN, ...args, "--no-open"], {
      cwd: this.repo,
      env: { ...process.env, ...this.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const client = new Client(proc)
    this.clients.push(client)
    const url = await client.waitFor(/docket (http\S+)/)
    return { client, url: url[1]!, id: decodeURIComponent(url[1]!.split("/s/")[1] ?? "") }
  }

  async open(url: string) {
    // Chromium resolves *.localhost itself; Playwright's bundled one does too.
    await this.page.goto(url)
    await this.page.waitForSelector(".file, .home-head")
  }

  async sessions(): Promise<{ id: string; status: string }[]> {
    return (await fetch(`http://127.0.0.1:${this.port}/api/sessions`)).json()
  }

  async press(...keys: string[]) {
    for (const key of keys) {
      await this.page.keyboard.press(key)
      await this.page.waitForTimeout(60)
    }
    await this.page.waitForTimeout(150)
  }

  async close() {
    this.clients.forEach((client) => client.proc.kill("SIGKILL"))
    await this.browser.close()
    await run(["bun", BIN, "server", "stop"], this.dir, this.env).catch(() => undefined)
    await rm(this.dir, { recursive: true, force: true })
  }
}

export class Client {
  output = ""
  readonly exited: Promise<number>

  constructor(readonly proc: ReturnType<typeof Bun.spawn>) {
    const decoder = new TextDecoder()
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) this.output += decoder.decode(chunk.value)
    }
    read(proc.stdout as ReadableStream<Uint8Array>)
    read(proc.stderr as ReadableStream<Uint8Array>)
    this.exited = proc.exited
  }

  async waitFor(pattern: RegExp, timeout = 30_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const match = this.output.match(pattern)
      if (match) return match
      await Bun.sleep(50)
    }
    throw new Error(`timed out waiting for ${pattern}; output:\n${this.output}`)
  }
}
