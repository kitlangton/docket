import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { devices } from "playwright"
import type { PickAnswer } from "../src/types"
import { run, World } from "./harness"
import { makePick } from "./media"

setDefaultTimeout(120_000)

const BIN = join(import.meta.dir, "..", "bin", "docket.ts")

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

const cards = () => world.page.locator(".pick-card")
const picked = () => world.page.locator(".pick-card.is-picked h2").allInnerTexts()
const focused = async () => (await world.page.locator(".pick-card.is-focused h2").innerText()).split(" · ")[0]
const answerOf = (dir: string): Promise<PickAnswer> => Bun.file(join(dir, "answer.json")).json()
const docket = (...args: string[]) => run(["bun", BIN, ...args], world.repo, world.env)

describe("pick", () => {
  test("grid, flip, the Dark/Light switch, single pick, pinned and video notes, Notes + Send", async () => {
    const dir = join(world.dir, "pick")
    const made = await makePick(dir)
    const { client, url } = await world.start("pick", made.manifest)
    await world.open(url)
    await settle(() => cards().count(), made.video ? 4 : 3)
    expect(await world.page.locator(".pick.is-grid").count()).toBe(1)

    // Arrow keys move the focus ring; a number opens that option full size.
    await world.press("l")
    await settle(focused, "B")
    await world.press("ArrowRight")
    await settle(focused, "C")
    await world.press("3")
    await settle(() => world.page.locator(".pick-top h1").innerText(), "C · Prototype")
    expect(
      await world.page
        .frameLocator(".pick-page iframe")
        .locator("#proto")
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(200, 0, 0)")
    await world.press("2", "j")
    await settle(() => world.page.locator(".pick-dots button").evaluateAll((dots) => dots.map((dot) => dot.className)), ["", "is-current"])
    await world.press("g")
    await settle(() => world.page.locator(".pick.is-grid").count(), 1)

    // One switch swaps every paired still.
    const paired = () => world.page.locator(".pick-still img[src*='/a-']").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")))
    await world.page.locator(".seg button", { hasText: "Light" }).click()
    await settle(async () => (await paired()).every((src) => src?.endsWith("a-light.png")), true)
    await world.page.locator(".seg button", { hasText: "Dark" }).click()
    await settle(async () => (await paired()).every((src) => src?.endsWith("a-dark.png")), true)
    await world.press("t")
    await settle(async () => (await paired()).every((src) => src?.endsWith("a-light.png")), true)

    // A pick on another card replaces the pick.
    expect(await world.page.locator(".pick-send").isDisabled()).toBe(true)
    await cards().nth(0).locator(".pick-button").click()
    await settle(picked, ["A · Card"])
    await cards().nth(1).locator(".pick-button").click()
    await settle(picked, ["B · Inline"])
    expect(await world.page.locator(".pick-send").isDisabled()).toBe(false)

    // c arms a pin on the focused card; a click on a still places it.
    await world.press("1", "g")
    await world.press("c")
    const box = (await cards().nth(0).locator(".pick-still img").boundingBox())!
    await world.page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75)
    await world.page.waitForSelector(".prompt textarea")
    await world.page.keyboard.type("Too much padding here")
    await world.press("Enter")
    await settle(() => cards().nth(0).locator(".pick-pin").count(), 1)

    if (made.video) {
      await world.press("4")
      await world.page.waitForFunction(() => (document.querySelector(".pick-video video") as HTMLVideoElement | null)?.currentTime! > 0.3)
      await world.press("c")
      await world.page.waitForSelector(".prompt textarea")
      await world.page.keyboard.type("Jumps here")
      await world.press("Enter")
      await settle(() => world.page.locator(".pick-note-at").count(), 1)
      await world.press("Escape")
    }

    await world.page.locator(".pick-bar textarea").fill("Inline, but quieter")
    await world.page.locator(".pick-send").click()
    await settle(() => world.page.locator(".pick-done").innerText(), "Sent.")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("docket: picked B")
    expect(client.output).toContain(`answer: ${join(dir, "answer.json")}`)

    const answer = await answerOf(dir)
    expect(answer).toMatchObject({ picked: ["B"], none: false, note: "Inline, but quieter" })
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
    expect(await world.page.locator(".inbox-answer").innerText()).toContain("B")
  })

  test(`"pick": "many" ranks picks in order`, async () => {
    const dir = join(world.dir, "pick")
    const { client, url } = await world.start("pick", (await makePick(dir, { pick: "many" })).manifest)
    await world.open(url)
    await world.press("l", "p", "h", "p")
    await settle(
      () => world.page.locator(".pick-button").allInnerTexts(),
      ["Pick 2", "Pick 1", "Pick", ...((await cards().count()) > 3 ? ["Pick"] : [])],
    )
    await world.press("Shift+Z", "Shift+Z")
    expect(await client.exited).toBe(0)
    expect((await answerOf(dir)).picked).toEqual(["B", "A"])
  })

  test("none of these, then :w", async () => {
    const dir = join(world.dir, "pick")
    const { client, url } = await world.start("pick", (await makePick(dir)).manifest)
    await world.open(url)
    await world.press("p", "0")
    await settle(() => world.page.evaluate(() => document.activeElement?.tagName), "TEXTAREA")
    await world.page.keyboard.type("Neither reads well")
    await world.press("Escape")
    await settle(picked, [])
    await world.press(":")
    await world.page.keyboard.type("w")
    await world.press("Enter")
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("docket: none of these")
    expect(await answerOf(dir)).toMatchObject({ picked: [], none: true, note: "Neither reads well" })
  })

  test("docket answer from chat updates the open page and ends the waiting client", async () => {
    const dir = join(world.dir, "pick")
    const { client, url } = await world.start("pick", (await makePick(dir)).manifest)
    await world.open(url)
    const wrong = await docket("answer", url, "--pick", "Z").catch((error: Error) => error.message)
    expect(wrong).toContain("unknown option Z")
    const out = await docket("answer", url, "--pick", "c", "--note", "C, from chat")
    expect(out).toContain("docket: picked C")
    expect(out).toContain(`answer: ${join(dir, "answer.json")}`)
    await settle(() => world.page.locator(".pick-done").innerText(), "Answered · C")
    await settle(picked, ["C · Prototype"])
    expect(await client.exited).toBe(0)
    expect(client.output).toContain("docket: picked C")
    expect(await answerOf(dir)).toMatchObject({ picked: ["C"], note: "C, from chat" })
    expect((await world.sessions())[0]?.status).toBe("done")
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

  test("phone: stacked cards, the bar above the fold, Pick and Send by touch, swipe in flip view", async () => {
    const dir = join(world.dir, "pick")
    const { client, url } = await world.start("pick", (await makePick(dir)).manifest)
    const context = await world.browser.newContext({ ...devices["iPhone 13"] })
    const page = await context.newPage()
    page.on("pageerror", (error) => console.error("pageerror:", error.message))
    await page.goto(url)
    await page.waitForSelector(".pick-card")
    const viewport = page.viewportSize()!
    const [first, second] = [await page.locator(".pick-card").nth(0).boundingBox(), await page.locator(".pick-card").nth(1).boundingBox()]
    expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1)
    expect(second!.x).toBe(first!.x)
    const bar = (await page.locator(".pick-bar").boundingBox())!
    expect(bar.y + bar.height).toBeLessThanOrEqual(viewport.height + 1)
    expect((await page.locator(".pick-send").boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await page.locator(".pick-bar").evaluate((el) => getComputedStyle(el).backdropFilter)).toContain("blur")

    // Tapping a still opens the option; swipes move between options; back returns to the grid.
    await page.locator(".pick-card").nth(0).locator(".pick-still img").first().tap()
    await page.waitForSelector(".pick.is-flip")
    const title = () => page.locator(".pick-top h1").innerText()
    const cdp = await context.newCDPSession(page)
    const swipe = async (from: number, to: number) => {
      const y = 400
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: (from + to) / 2, y }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to, y }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    }
    await swipe(320, 60)
    await settle(title, "B · Inline")
    await page.locator(".pick-back").tap()
    await page.waitForSelector(".pick.is-grid")

    await page.locator(".pick-card").nth(1).locator(".pick-button").tap()
    await settle(() => page.locator(".pick-card.is-picked h2").allInnerTexts(), ["B · Inline"])
    await page.locator(".pick-send").tap()
    await settle(() => page.locator(".pick-done").innerText(), "Sent.")
    expect(await client.exited).toBe(0)
    expect((await answerOf(dir)).picked).toEqual(["B"])
    await context.close()
  })
})
