/**
 * Makes the server reachable from Kit's other tailnet devices (a phone, say) with a tailnet-only
 * `tailscale serve` entry for docket's port. Never Funnel: nothing is exposed to the internet. Only
 * docket's own entry is added; other serve entries are left exactly as they are. The entry stays
 * after the server exits, so the next start finds it and reuses it. `DOCKET_TAILNET=0` turns this off.
 */
export async function tailnetUrl(port: number): Promise<string | undefined> {
  if (process.env.DOCKET_TAILNET === "0" || !Bun.which("tailscale")) return undefined
  const status = await tailscaleJson<{ BackendState?: string; Self?: { DNSName?: string } }>(["status", "--json"])
  const host = status?.Self?.DNSName?.replace(/\.$/, "")
  if (status?.BackendState !== "Running" || !host) return undefined
  const target = `http://127.0.0.1:${port}`
  const serve = await tailscaleJson<{ Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }>([
    "serve",
    "status",
    "--json",
  ])
  const existing = serve?.Web?.[`${host}:${port}`]?.Handlers?.["/"]?.Proxy
  if (existing && existing !== target) {
    console.error(`docket: tailnet port ${port} already serves ${existing}; not reachable over the tailnet`)
    return undefined
  }
  if (!existing) {
    const proc = Bun.spawn(["tailscale", "serve", "--bg", `--https=${port}`, target], { stdout: "ignore", stderr: "pipe" })
    const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => -1)])
    if (code !== 0) {
      console.error(`docket: tailscale serve failed (${code}): ${(await new Response(proc.stderr).text()).trim()}`)
      return undefined
    }
  }
  return `https://${host}:${port}`
}

async function tailscaleJson<T>(args: string[]): Promise<T | undefined> {
  const proc = Bun.spawn(["tailscale", ...args], { stdout: "pipe", stderr: "ignore" })
  const out = await Promise.race([new Response(proc.stdout).text(), Bun.sleep(5000).then(() => "")])
  if (!out) proc.kill()
  try {
    return JSON.parse(out) as T
  } catch {
    return undefined
  }
}
