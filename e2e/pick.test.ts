import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { devices } from "playwright"
import type { PickAnswer } from "../src/types"
import { World } from "./harness"
import { makePick } from "./media"

setDefaultTimeout(120_000)

let world: World
beforeEach(async () => {
  world = await World.create()
})
afterEach(async () => {
  await world.close()
})

/** Polls until `read` returns `expected`, so slow CI runners don't race the UI. */
async function settle<T>(read: () => Promise<T>, expected: T, timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (let value = await read(); ; value = await read()) {
    if (JSON.stringify(value) === JSON.stringify(expected) || Date.now() > deadline) return expect<unknown>(value).toEqual(expected)
    await Bun.sleep(100)
  }
}

const current = () => world.page.locator(".pick-tab.is-current").first().innerText()
const ranks = () =>
  world.page.locator(".pick-tab").evaluateAll((tabs) => tabs.map((tab) => tab.querySelector(".pick-rank")?.textContent ?? ""))
const answerOf = (dir: string): Promise<PickAnswer> => Bun.file(join(dir, "answer.json")).json()

describe("pick", () => {
  test("flip, grid, light/dark, ranking, a pinned note, a video note, submit", async () => {
    const dir = join(world.dir, "pick")
    const made = await makePick(dir)
    const { client, url } = await world.start("pick", made.manifest)
    await world.open(url)
    await settle(current, "A")

    await world.press("l")
    await settle(current, "B")
    await world.press("h")
    await settle(current, "A")
    await world.press("3")
    await settle(current, "C")
    expect(
      await world.page
        .frameLocator(".pick-page iframe")
        .locator("#proto")
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(200, 0, 0)")
    await world.press("2", "j")
    await settle(() => world.page.locator(".pick-dots span").evaluateAll((dots) => dots.map((dot) => dot.className)), ["", "is-current"])

    await world.press("g")
    await settle(() => world.page.locator(".pick-card").count(), made.video ? 4 : 3)
    await world.press("l", "Enter")
    await settle(() => world.page.locator(".pick-grid").count(), 0)
    await settle(current, "C")

    await world.press("1")
    const src = () => world.page.locator(".pick-frame img").getAttribute("src")
    const before = await src()
    await world.press("t")
    await settle(async () => (await src()) !== before && /a-(light|dark)\.png$/.test((await src()) ?? ""), true)

    // Holding b shows the baseline in place.
    await world.page.keyboard.down("b")
    await settle(() => world.page.locator(".pick-caption .pick-id").innerText(), "Before")
    await world.page.keyboard.up("b")
    await settle(() => world.page.locator(".pick-caption .pick-id").innerText(), "A")

    await world.press("2", "p", "1", "p")
    await settle(ranks, ["2", "1", "", ...(made.video ? [""] : [])])

    // A pin: c arms it, a click on the image places it.
    await world.press("c")
    const box = (await world.page.locator(".pick-frame img").boundingBox())!
    await world.page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75)
    await world.page.waitForSelector(".prompt textarea")
    await world.page.keyboard.type("Too much padding here")
    await world.press("Enter")
    await settle(() => world.page.locator(".pick-pin").count(), 1)

    if (made.video) {
      await world.press("4")
      await world.page.waitForFunction(() => (document.querySelector(".pick-video video") as HTMLVideoElement | null)?.currentTime! > 0.3)
      await world.press("c")
      await world.page.waitForSelector(".prompt textarea")
      await world.page.keyboard.type("Jumps here")
      await world.press("Enter")
      await settle(() => world.page.locator(".pick-note-at").count(), 1)
    }

    await world.press("Shift+C")
    await world.page.keyboard.type("Card, but quieter")
    await world.press("Enter")
    await world.press("Shift+Z", "Shift+Z")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("docket: picked B, A")
    expect(client.output).toContain(`answer: ${join(dir, "answer.json")}`)

    const answer = await answerOf(dir)
    expect(answer.picked).toEqual(["B", "A"])
    expect(answer.none).toBe(false)
    expect(answer.note).toBe("Card, but quieter")
    const pin = answer.notes.find((note) => note.option === "A")!
    expect(pin.body).toBe("Too much padding here")
    if (!pin.at || !("x" in pin.at)) throw new Error("expected a pin")
    expect(pin.at.x).toBeCloseTo(0.25, 1)
    expect(pin.at.y).toBeCloseTo(0.75, 1)
    if (made.video) {
      const stamped = answer.notes.find((note) => note.option === "D")!
      expect(stamped.at && "t" in stamped.at && stamped.at.t > 0).toBe(true)
    }

    await world.open(world.base + "/")
    await world.page.waitForSelector(".inbox-row .inbox-kind")
    expect(await world.page.locator(".inbox-answer").innerText()).toContain("B · A")
    expect(await world.page.locator(".inbox-thumb").count()).toBe(1)
  })

  test("none of these, then :w", async () => {
    const dir = join(world.dir, "pick")
    const { client, url } = await world.start("pick", (await makePick(dir)).manifest)
    await world.open(url)
    await world.press("p", "0")
    await world.page.waitForSelector(".prompt textarea")
    await world.page.keyboard.type("Neither reads well")
    await world.press("Enter")
    await settle(
      ranks,
      (await ranks()).map(() => ""),
    )
    await world.press(":")
    await world.page.keyboard.type("w")
    await world.press("Enter")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("docket: none of these")
    const answer = await answerOf(dir)
    expect(answer).toMatchObject({ picked: [], none: true, note: "Neither reads well" })
  })

  test("Ctrl-C closes without an answer", async () => {
    const { client } = await world.start("pick", (await makePick(join(world.dir, "pick"))).manifest)
    client.proc.kill("SIGINT")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("closed without answer")
  })

  test("--timeout exits and leaves the pick open", async () => {
    const { client, id } = await world.start("pick", (await makePick(join(world.dir, "pick"))).manifest, "--timeout", "1s")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("timed out")
    await settle(async () => (await world.sessions()).find((row) => row.id === id)?.status, "progress")
  })

  test("phone: label strip, swipe, pick, submit", async () => {
    const dir = join(world.dir, "pick")
    const { client, url } = await world.start("pick", (await makePick(dir)).manifest)
    const context = await world.browser.newContext({ ...devices["iPhone 13"] })
    const page = await context.newPage()
    page.on("pageerror", (error) => console.error("pageerror:", error.message))
    await page.goto(url)
    await page.waitForSelector(".pick-strip")
    expect(await page.locator(".pick-strip").isVisible()).toBe(true)
    expect(await page.locator(".pick-actions").isVisible()).toBe(true)
    const tab = () => page.locator(".pick-tab.is-current").first().innerText()
    expect(await tab()).toBe("A")

    const cdp = await context.newCDPSession(page)
    const swipe = async (from: number, to: number) => {
      const y = 400
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: (from + to) / 2, y }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to, y }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    }
    await swipe(320, 60)
    await settle(tab, "B")
    await swipe(60, 320)
    await settle(tab, "A")
    await swipe(320, 60)
    await settle(tab, "B")

    await page.locator(".pick-actions button", { hasText: "Pick" }).tap()
    await settle(() => page.locator(".pick-actions button").first().innerText(), "Picked 1")
    await page.locator(".pick-actions-submit").tap()
    expect(await client.exited).toBe(0)
    expect((await answerOf(dir)).picked).toEqual(["B"])
    await context.close()
  })
})
