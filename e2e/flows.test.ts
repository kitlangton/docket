import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { basename, dirname, join } from "node:path"
import type { VerdictsFile } from "../src/types"
import { edit, run, World } from "./harness"

setDefaultTimeout(120_000)

let world: World
beforeEach(async () => {
  world = await World.create()
})
afterEach(async () => {
  await world.close()
})

/** A manifest over two local ranges, so a session has more than one item. */
async function manifest() {
  const path = join(world.repo, "session.json")
  await Bun.write(
    path,
    JSON.stringify({
      title: "Local review",
      repo: { path: "." },
      groups: [
        { title: "Tuning", why: "Two small changes.", prs: [{ ref: "main..feature", why: "Sets two lines.", confidence: "high" }] },
        { title: "Additions", prs: [{ ref: "main..second", why: "Adds new.ts.", risk: "New file.", confidence: "medium" }] },
      ],
    }),
  )
  return path
}

const api = () => `http://127.0.0.1:${world.port}/api`
const docket = (...args: string[]) =>
  run(["bun", join(import.meta.dir, "..", "bin", "docket.ts"), ...args, "--no-open"], world.repo, world.env)
/** Running `docket server run` processes for this world's port. */
const serverProcesses = async () => {
  const out = await run(["pgrep", "-f", `server run --port ${world.port}`], world.dir).catch(() => "")
  return out.split("\n").filter(Boolean).length
}

const position = async () => {
  const muted = world.page.locator(".status-left .muted")
  return (await muted.count()) ? ((await muted.first().textContent()) ?? "") : ""
}
const title = async () => (await world.page.locator(".pr-num").first().textContent())?.trim()

/** Polls until `read` returns `expected`, so slow CI runners don't race the UI. */
async function settle<T>(read: () => Promise<T>, expected: T, timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (let value = await read(); ; value = await read()) {
    if (JSON.stringify(value) === JSON.stringify(expected) || Date.now() > deadline) return expect<unknown>(value).toEqual(expected)
    await Bun.sleep(100)
  }
}

describe("reviewing", () => {
  test("navigation, notes, verdicts with auto-advance, and hand-back", async () => {
    const { client, url } = await world.start(await manifest())
    await world.open(url)
    await settle(title, "main..feature")

    await world.press("j")
    await settle(position, "app.ts:L50")
    await world.press("j")
    await settle(position, "app.ts:L90")
    await world.press("k", "k")
    await settle(position, "")

    // A PR note, then a range note across the change at line 50.
    await world.press("c")
    await world.page.waitForSelector(".prompt textarea")
    await world.page.keyboard.type("Looks right")
    await world.press("Enter")
    await settle(() => world.page.locator(".pr-note").count(), 1)
    await world.press("j", "V", "j", "c")
    await world.page.waitForSelector(".draft textarea")
    await world.page.keyboard.type("Why 50?")
    await world.press("Enter")
    expect(await world.page.locator(".note-range").first().textContent()).toBe("Line 50")

    await world.press("J")
    await settle(title, "main..second")
    await world.press("K", "a")
    await settle(title, "main..second")
    await settle(() => world.page.locator(".rail-pr .glyph.is-approve").count(), 1)

    await world.press("r")
    await world.page.waitForSelector(".prompt textarea")
    await world.page.keyboard.type("Not yet")
    await world.press("Enter")
    await settle(() => world.page.locator(".summary").count(), 1)

    await world.press("w")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("handed back 2 items: 1 approved, 1 rejected")
    const path = (await client.waitFor(/verdicts: (\S+)/))[1]!
    const verdicts: VerdictsFile = await Bun.file(path).json()
    expect(verdicts.prs.map((pr) => [pr.ref, pr.verdict])).toEqual([
      ["main..feature", "approve"],
      ["main..second", "reject"],
    ])
    expect(verdicts.prs[0]!.notes).toEqual([{ body: "Looks right" }, { path: "app.ts", side: "RIGHT", line: 50, body: "Why 50?" }])
    expect(verdicts.prs[1]).toMatchObject({ reason: "Not yet", confidence: "medium", size: "S" })
  })

  test("folds, viewed files, and context expansion", async () => {
    const { url } = await world.start("main..feature")
    await world.open(url)
    const files = world.page.locator(".file")
    const folded = world.page.locator(".file[data-collapsed]")
    expect(await files.count()).toBe(2)

    await world.press("z", "M")
    await settle(() => folded.count(), 2)
    await world.press("z", "R")
    await settle(() => folded.count(), 0)
    await world.press("j", "z", "a")
    await settle(() => folded.count(), 1)
    await world.press("z", "a")

    const visibleLines = () =>
      world.page.evaluate(
        () => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-additions] [data-line]").length,
      )
    const before = await visibleLines()
    await world.press("e")
    await world.page.waitForFunction(
      (count) => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-additions] [data-line]").length > count,
      before,
    )

    // Clicking a separator's ↕ expands that gap.
    const expanded = await visibleLines()
    const box = await world.page.evaluate(() => {
      const rect = document
        .querySelector("diffs-container")!
        .shadowRoot!.querySelector("[data-deletions] [data-gutter] > [data-separator]")!
        .getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await world.page.keyboard.down("Shift")
    await world.page.mouse.click(box.x, box.y)
    await world.page.keyboard.up("Shift")
    await world.page.waitForFunction(
      (count) => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-additions] [data-line]").length > count,
      expanded,
    )

    await world.press("x")
    await settle(() => world.page.locator(".fh-tag.is-viewed").count(), 1)
    await settle(() => folded.count(), 1)
    expect(await world.page.locator(".pr-counts").textContent()).toContain("1/2 viewed")
  })

  test("re-review: updated marker, interdiff, stale verdict, outdated note", async () => {
    const { url } = await world.start("main..feature")
    await world.open(url)
    await world.press("j", "Control+n", "V", "c")
    await world.page.waitForSelector(".draft textarea")
    await world.page.keyboard.type("Why 50?")
    await world.press("Enter", "a", "Escape")

    await edit(world.repo, "app.ts", { 50: "export const line50 = 5000", 110: "export const line110 = 110" })
    await Bun.spawn(["git", "-c", "user.name=d", "-c", "user.email=d@example.com", "commit", "-qam", "fix: retune"], { cwd: world.repo })
      .exited
    await world.page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await world.page.waitForSelector(".pr-updated")

    await settle(() => world.page.locator(".updated-dot").count(), 1)
    await settle(() => world.page.locator(".verdict-chip.is-stale").count(), 1)
    await settle(() => world.page.locator(".note.is-outdated").count(), 1)

    await world.press("i")
    await world.page.waitForFunction(() => document.querySelectorAll(".fh-name").length === 1)
    expect(await world.page.locator(".fh-name").allTextContents()).toEqual(["app.ts"])
    await world.press("i")
    await world.page.waitForFunction(() => document.querySelectorAll(".fh-name").length === 2)

    await world.press("a", "Escape")
    await settle(() => world.page.locator(".verdict-chip.is-stale").count(), 0)
  })

  test(": commands", async () => {
    const { client, url } = await world.start(await manifest())
    await world.open(url)
    const command = async (text: string) => {
      await world.press(":")
      await world.page.waitForSelector(".command-input")
      await world.page.keyboard.type(text)
      await world.press("Enter")
    }
    await command("2")
    await settle(title, "main..second")
    await command("set wrap")
    await world.page.waitForSelector("diffs-container")
    expect(
      await world.page.evaluate(() =>
        document.querySelector("diffs-container")!.shadowRoot!.querySelector("[data-overflow]")?.getAttribute("data-overflow"),
      ),
    ).toBe("wrap")
    await command("set nowrap")
    await command("s")
    await settle(() => world.page.locator(".summary").count(), 1)
    await world.press("Escape")
    await command("bogus")
    expect(await world.page.locator(".status").textContent()).toContain("Not a command")
    await command("q!")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("closed without hand-back")
  })
})

describe("risk fixes", () => {
  test("]u lands on a rename-only file", async () => {
    await run(["git", "checkout", "-qb", "moves", "main"], world.repo)
    await edit(world.repo, "app.ts", { 30: "export const line30 = 30" })
    await run(["git", "mv", "other.ts", "renamed.ts"], world.repo)
    await run(["git", "-c", "user.name=docket", "-c", "user.email=docket@example.com", "commit", "-qam", "move other.ts"], world.repo)
    const { url } = await world.start("main..moves")
    await world.open(url)
    await world.press("]", "u")
    await settle(position, "app.ts:L30")
    await world.press("]", "u")
    await settle(position, "renamed.ts")
    await world.press("x")
    await settle(() => world.page.locator(".fh-tag.is-viewed").count(), 1)
  })

  test("undo restores the reviewed head", async () => {
    const { id, url } = await world.start(await manifest())
    await world.open(url)
    const reviewedHead = async () => {
      const state = await (await fetch(`http://127.0.0.1:${world.port}/api/s/${encodeURIComponent(id)}/state`)).json()
      return state.reviews["ref:main..feature"]?.reviewedHead ?? null
    }
    await world.press("a")
    await settle(title, "main..second")
    await settle(async () => typeof (await reviewedHead()), "string")
    await world.press("u")
    await settle(title, "main..feature")
    await settle(reviewedHead, null)
  })
})

describe("one server", () => {
  test("server stop ends a waiting client", async () => {
    const { client } = await world.start("main..feature")
    await run(["bun", join(import.meta.dir, "..", "bin", "docket.ts"), "server", "stop"], world.repo, world.env)
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("closed without hand-back")
  })

  test("a restart keeps clients waiting without registering them again", async () => {
    const { client, id } = await world.start("main..feature")
    const index = join(world.env.XDG_DATA_HOME!, "docket", ".server", "sessions.json")
    const registeredAt = async () => (await Bun.file(index).json())[id].registeredAt
    const before = await registeredAt()
    await run(["bun", join(import.meta.dir, "..", "bin", "docket.ts"), "server", "restart"], world.repo, world.env)
    await settle(async () => (await world.sessions().catch(() => [])).find((row) => row.id === id)?.status, "waiting")
    expect(await registeredAt()).toBe(before)
    expect(client.proc.exitCode).toBeNull()
  })

  test("an unreadable state file is moved aside and the session opens empty", async () => {
    const broken = await world.start("main..feature")
    const fine = await world.start("main..second")
    const statePath = (await broken.client.waitFor(/state (\S+)/))[1]!
    await Bun.write(statePath, "{ not json")
    const res = await fetch(`${api()}/sessions`)
    expect(res.status).toBe(200)
    const rows: { id: string }[] = await res.json()
    expect(rows.map((row) => row.id).sort()).toEqual([broken.id, fine.id].sort())
    const state = await (await fetch(`${api()}/s/${encodeURIComponent(broken.id)}/state`)).json()
    expect(state.reviews).toEqual({})
    const aside = await Array.fromAsync(new Bun.Glob(`${basename(statePath)}.unreadable-*`).scan(dirname(statePath)))
    expect(aside.length).toBe(1)
  })

  test("one server per port: a second fails to bind, and clients converge after the server dies", async () => {
    const clients = await Promise.all(["main..feature", "main..second", "feature"].map((ref) => world.start(ref)))
    expect(await docket("server", "run")).toContain("already has a server")
    const { pid } = await (await fetch(`${api()}/health`)).json()
    process.kill(pid, "SIGKILL")
    await settle(async () => (await world.sessions().catch(() => [])).filter((row) => row.status === "waiting").length, 3, 30_000)
    await settle(serverProcesses, 1, 10_000)
    clients.forEach(({ client }) => expect(client.proc.exitCode).toBeNull())
  })

  test("an idle shutdown doesn't close a client that arrives during it", async () => {
    world.env.DOCKET_IDLE_MS = "1500"
    for (const delay of [1300, 1550, 1800, 2050]) {
      await docket("open")
      await Bun.sleep(delay)
      const { client } = await world.start("main..feature")
      await Bun.sleep(2500)
      expect(client.output).not.toContain("closed without hand-back")
      expect(client.proc.exitCode).toBeNull()
      await docket("server", "stop")
      expect(await client.exited).toBe(0)
    }
  })

  test("a hand-back while the client is away during a restart is still delivered", async () => {
    const { client, id } = await world.start("main..feature")
    client.proc.kill("SIGSTOP")
    await docket("server", "restart")
    const res = await fetch(`${api()}/s/${encodeURIComponent(id)}/handback`, {
      method: "POST",
      body: JSON.stringify({ version: 2, current: null, reviews: {} }),
    })
    expect(res.ok).toBe(true)
    client.proc.kill("SIGCONT")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("handed back 1 item")
  })

  test("a foreign process on the port ends the waiting client instead of spinning", async () => {
    const { client } = await world.start("main..feature")
    client.proc.kill("SIGSTOP")
    const { pid } = await (await fetch(`${api()}/health`)).json()
    process.kill(pid, "SIGKILL")
    await settle(serverProcesses, 0, 10_000)
    const foreign = Bun.serve({ port: world.port, hostname: "127.0.0.1", reusePort: false, fetch: () => new Response("not docket") })
    try {
      client.proc.kill("SIGCONT")
      expect(await client.exited).toBe(1)
      expect(client.output).toContain("something other than docket")
    } finally {
      foreign.stop(true)
    }
  })

  test("inbox with two sessions; Ctrl-C leaves a session in progress; re-registering attaches", async () => {
    const first = await world.start("main..feature")
    const second = await world.start("main..second")
    const again = await world.start("main..feature")
    expect(again.id).toBe(first.id)
    await world.page.waitForTimeout(500)

    const statuses = async () => Object.fromEntries((await world.sessions()).map((row) => [row.id, row.status]))
    expect(await statuses()).toEqual({ [first.id]: "waiting", [second.id]: "waiting" })

    await world.open(world.base + "/")
    await settle(() => world.page.locator(".inbox-row").count(), 2)

    second.client.proc.kill("SIGINT")
    expect(await second.client.exited).toBe(0)
    expect(second.client.output).toContain("closed without hand-back")
    await world.page.waitForTimeout(500)
    expect((await statuses())[second.id]).toBe("progress")
    await world.page.waitForSelector(".inbox-row.is-progress")

    // Both clients waiting on the first session receive its hand-back.
    await world.page.locator(".inbox-row.is-waiting").click()
    await world.page.waitForSelector(".file")
    await world.press("a")
    await world.press("w")
    expect(await first.client.exited).toBe(0)
    expect(await again.client.exited).toBe(0)
    expect(again.client.output).toContain("handed back 1 item: 1 approved")
    expect((await statuses())[first.id]).toBe("done")
  })
})
