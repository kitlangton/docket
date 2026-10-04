import { spawn } from "node:child_process"
import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"
import { APP_ID, type Registration, type WaitEvent } from "./server"
import { dataHome } from "./session"
import { ROOT } from "./version"

export type Health = { app: string; version: string; pid: number; port: number; url: string }

export const DEFAULT_PORT = 4789

export function serverBase(port: number) {
  return `http://127.0.0.1:${port}`
}

export function logPath() {
  return join(dataHome(), ".server", "server.log")
}

/** The docket server on this port, `undefined` if nothing answers, or an error if something else does. */
export async function health(port: number): Promise<Health | undefined> {
  const res = await fetch(`${serverBase(port)}/api/health`, { signal: AbortSignal.timeout(1500) }).catch(() => undefined)
  if (!res) return undefined
  const body = (await res.json().catch(() => undefined)) as Partial<Health> | undefined
  if (body?.app !== APP_ID) throw new Error(`port ${port} is in use by something other than docket (set DOCKET_PORT or --port)`)
  return body as Health
}

/**
 * Returns a healthy server on `port`, spawning one if none runs. With `version`, a server running other
 * code is restarted first; without it, any docket server is accepted (used when reconnecting, so two
 * clients on different builds never take turns restarting each other).
 */
export async function ensureServer(port: number, options: { version?: string; idleMs?: number } = {}) {
  const running = await health(port)
  if (running && (!options.version || running.version === options.version)) return running
  if (running) await stopServer(port)
  await spawnServer(port, options.idleMs)
  const started = await waitFor(port, (found) => found !== undefined, 20_000, "the docket server did not start; see " + logPath())
  // Open tabs reload onto the new build; give them a moment to reconnect so they can be reused.
  if (running) await Bun.sleep(2500)
  return started
}

export async function stopServer(port: number) {
  const running = await health(port)
  if (!running) return false
  await fetch(`${serverBase(port)}/api/shutdown`, { method: "POST" }).catch(() => undefined)
  await waitFor(port, (found) => found === undefined, 15_000, "the docket server did not stop")
  return true
}

async function spawnServer(port: number, idleMs?: number) {
  await mkdir(join(dataHome(), ".server"), { recursive: true })
  const log = await open(logPath(), "a")
  const args = [join(ROOT, "bin", "docket.ts"), "server", "run", "--port", String(port), ...(idleMs ? ["--idle-ms", String(idleMs)] : [])]
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log.fd, log.fd], cwd: ROOT, env: process.env })
  child.unref()
  await log.close()
}

async function waitFor(port: number, done: (found: Health | undefined) => boolean, timeout: number, message: string) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = await health(port).catch(() => undefined)
    if (done(found)) return found as Health
    await Bun.sleep(150)
  }
  throw new Error(message)
}

export async function register(port: number, registration: Registration) {
  const res = await fetch(`${serverBase(port)}/api/sessions`, { method: "POST", body: JSON.stringify(registration) })
  if (!res.ok) throw new Error(`could not register the session: ${res.status} ${await res.text()}`)
  const body: { id: string; url: string; focused: boolean } = await res.json()
  return body
}

/** Waits on the session's event stream. Resolves with the final event, or `undefined` if the stream dropped. */
export async function waitOnce(port: number, id: string, signal: AbortSignal): Promise<WaitEvent | undefined> {
  const res = await fetch(`${serverBase(port)}/api/s/${encodeURIComponent(id)}/wait`, { signal }).catch(() => undefined)
  if (!res?.ok || !res.body) return undefined
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  const reader = res.body.getReader()
  for (let chunk = await reader.read().catch(() => undefined); chunk && !chunk.done; chunk = await reader.read().catch(() => undefined)) {
    buffer.text += decoder.decode(chunk.value, { stream: true })
    const events = buffer.text.split("\n\n")
    buffer.text = events.pop() ?? ""
    const final = events
      .flatMap((event) => event.split("\n").filter((line) => line.startsWith("data: ")))
      .map((line): WaitEvent => JSON.parse(line.slice(6)))
      .find((event) => event.type !== "hello")
    if (final) return final
  }
  return undefined
}

/** The command that launched docket (e.g. an agent's shell), for the inbox. */
export async function parentName() {
  const proc = Bun.spawn(["ps", "-o", "comm=", "-p", String(process.ppid)], { stdout: "pipe", stderr: "ignore" })
  const name = (await new Response(proc.stdout).text()).trim()
  return name.split("/").at(-1) || undefined
}
