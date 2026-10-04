import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import type { VerdictsFile } from "../src/types"
import { edit, World } from "./harness"

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

const position = async () => {
  const muted = world.page.locator(".status-left .muted")
  return (await muted.count()) ? ((await muted.first().textContent()) ?? "") : ""
}
const title = async () => (await world.page.locator(".pr-num").first().textContent())?.trim()

describe("reviewing", () => {
  test("navigation, notes, verdicts with auto-advance, and hand-back", async () => {
    const { client, url } = await world.start(await manifest())
    await world.open(url)
    expect(await title()).toBe("main..feature")

    await world.press("j")
    expect(await position()).toBe("app.ts:L50")
    await world.press("j")
    expect(await position()).toBe("app.ts:L90")
    await world.press("k", "k")
    expect(await position()).toBe("")

    // A PR note, then a range note across the change at line 50.
    await world.press("c")
    await world.page.keyboard.type("Looks right")
    await world.press("Enter")
    expect(await world.page.locator(".pr-note").count()).toBe(1)
    await world.press("j", "V", "j", "c")
    await world.page.keyboard.type("Why 50?")
    await world.press("Enter")
    expect(await world.page.locator(".note-range").first().textContent()).toBe("Line 50")

    await world.press("J")
    expect(await title()).toBe("main..second")
    await world.press("K", "a")
    expect(await title()).toBe("main..second")
    expect(await world.page.locator(".rail-pr .glyph.is-approve").count()).toBe(1)

    await world.press("r")
    await world.page.keyboard.type("Not yet")
    await world.press("Enter")
    expect(await world.page.locator(".summary").count()).toBe(1)

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
    expect(await folded.count()).toBe(2)
    await world.press("z", "R")
    expect(await folded.count()).toBe(0)
    await world.press("j", "z", "a")
    expect(await folded.count()).toBe(1)
    await world.press("z", "a")

    const visibleLines = () =>
      world.page.evaluate(
        () => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-additions] [data-line]").length,
      )
    const before = await visibleLines()
    await world.press("e")
    await world.page.waitForTimeout(800)
    expect(await visibleLines()).toBeGreaterThan(before)

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
    await world.page.waitForTimeout(800)
    expect(await visibleLines()).toBeGreaterThan(expanded)

    await world.press("x")
    expect(await world.page.locator(".fh-tag.is-viewed").count()).toBe(1)
    expect(await folded.count()).toBe(1)
    expect(await world.page.locator(".pr-counts").textContent()).toContain("1/2 viewed")
  })

  test("re-review: updated marker, interdiff, stale verdict, outdated note", async () => {
    const { url } = await world.start("main..feature")
    await world.open(url)
    await world.press("j", "Control+n", "V", "c")
    await world.page.keyboard.type("Why 50?")
    await world.press("Enter", "a", "Escape")

    await edit(world.repo, "app.ts", { 50: "export const line50 = 5000", 110: "export const line110 = 110" })
    await Bun.spawn(["git", "-c", "user.name=d", "-c", "user.email=d@example.com", "commit", "-qam", "fix: retune"], { cwd: world.repo })
      .exited
    await world.page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await world.page.waitForSelector(".pr-updated")

    expect(await world.page.locator(".updated-dot").count()).toBe(1)
    expect(await world.page.locator(".verdict-chip.is-stale").count()).toBe(1)
    expect(await world.page.locator(".note.is-outdated").count()).toBe(1)

    await world.press("i")
    await world.page.waitForTimeout(500)
    expect(await world.page.locator(".fh-name").allTextContents()).toEqual(["app.ts"])
    await world.press("i")
    expect(await world.page.locator(".fh-name").count()).toBe(2)

    await world.press("a", "Escape")
    expect(await world.page.locator(".verdict-chip.is-stale").count()).toBe(0)
  })

  test(": commands", async () => {
    const { client, url } = await world.start(await manifest())
    await world.open(url)
    const command = async (text: string) => {
      await world.press(":")
      await world.page.keyboard.type(text)
      await world.press("Enter")
    }
    await command("2")
    expect(await title()).toBe("main..second")
    await command("set wrap")
    expect(
      await world.page.evaluate(() =>
        document.querySelector("diffs-container")!.shadowRoot!.querySelector("[data-overflow]")?.getAttribute("data-overflow"),
      ),
    ).toBe("wrap")
    await command("set nowrap")
    await command("s")
    expect(await world.page.locator(".summary").count()).toBe(1)
    await world.press("Escape")
    await command("bogus")
    expect(await world.page.locator(".status").textContent()).toContain("Not a command")
    await command("q!")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("closed without hand-back")
  })
})

describe("one server", () => {
  test("inbox with two sessions; Ctrl-C leaves a session in progress; re-registering attaches", async () => {
    const first = await world.start("main..feature")
    const second = await world.start("main..second")
    const again = await world.start("main..feature")
    expect(again.id).toBe(first.id)
    await world.page.waitForTimeout(500)

    const statuses = async () => Object.fromEntries((await world.sessions()).map((row) => [row.id, row.status]))
    expect(await statuses()).toEqual({ [first.id]: "waiting", [second.id]: "waiting" })

    await world.open(world.base + "/")
    expect(await world.page.locator(".inbox-row").count()).toBe(2)

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
