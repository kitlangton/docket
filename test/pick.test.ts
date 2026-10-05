import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answerSummary, applyAnswer, EMPTY_PICK_STATE, mediaPath, mediaResponse, resolvePick, toAnswer, validatePick } from "../src/pick"

let base: string
let dir: string
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "docket-pick-"))
  dir = join(base, "pick")
  await mkdir(join(dir, "proto"), { recursive: true })
  await mkdir(join(dir, "empty"))
  await Promise.all(
    ["a.png", "a-dark.png", "b.JPG", "c.mp4", "notes.md", "proto/index.html", "page.html", "data.csv"].map((file) =>
      Bun.write(join(dir, file), "x".repeat(100)),
    ),
  )
  await Bun.write(join(dir, "..", "outside.png"), "secret")
  await symlink(join(dir, "..", "outside.png"), join(dir, "link.png"))
  await Bun.write(join(dir, "round-1.json"), JSON.stringify({ picked: ["B"], none: false, note: "", notes: [] }))
})
afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe("pick manifests", () => {
  test("infers kinds, ids, and labels", async () => {
    const pick = await validatePick(
      {
        title: "Style",
        baseline: { light: "a.png", dark: "a-dark.png" },
        options: [
          { media: ["a.png", { light: "a.png", dark: "a-dark.png", label: "Pair" }] },
          { label: "Video", media: ["c.mp4", "b.JPG"] },
          { media: ["proto", "page.html", "https://example.com/x"] },
          { id: "text", media: ["notes.md"] },
          { body: "Just words." },
        ],
        previous: "round-1.json",
      },
      dir,
    )
    expect(pick.options.map((option) => option.id)).toEqual(["A", "B", "C", "text", "E"])
    expect(pick.options.map((option) => option.label)).toEqual(["a", "Video", "proto", "notes", "E"])
    expect(pick.options[0]!.media[1]).toEqual({ kind: "image", src: "a.png", dark: "a-dark.png", label: "Pair" })
    expect(pick.options[1]!.media.map((media) => media.kind)).toEqual(["video", "image"])
    expect(pick.options[2]!.media.map((media) => [media.kind, media.src])).toEqual([
      ["page", "proto/index.html"],
      ["page", "page.html"],
      ["url", "https://example.com/x"],
    ])
    expect(pick.options[3]!.media[0]!.kind).toBe("text")
    expect(pick.baseline?.dark).toBe("a-dark.png")
    expect(pick.previous?.picked).toEqual(["B"])
  })

  test("reports every problem with where it is", async () => {
    const error = await validatePick(
      {
        options: [
          { media: ["missing.png"] },
          { media: ["data.csv", "empty", "../outside.png", "ftp://x"] },
          { id: "A", media: [{ light: "a.png", dark: "c.mp4" }] },
          {},
        ],
        previous: "nope.json",
      },
      dir,
    ).catch((caught: Error) => caught.message)
    expect(error).toContain("title: required")
    expect(error).toContain("options[0].media[0]: file not found: missing.png")
    expect(error).toContain("options[1].media[0]: unknown media kind for data.csv")
    expect(error).toContain("options[1].media[1]: folder empty has no index.html")
    expect(error).toContain("options[1].media[2]: ../outside.png is outside the manifest's folder")
    expect(error).toContain("options[1].media[3]: unsupported URL ftp://x")
    expect(error).toContain("options[2].media[0]: light is image but dark is video")
    expect(error).toContain("options[3]: needs media or a body")
    expect(error).toContain("options: duplicate id A")
    expect(error).toContain("previous: not a readable answer.json")
    const mode = await validatePick({ title: "t", pick: "several", options: [{ body: "x" }] }, dir).catch((caught: Error) => caught.message)
    expect(mode).toContain(`pick: expected "one" or "many"`)
    expect((await validatePick({ title: "t", pick: "many", options: [{ body: "x" }] }, dir)).many).toBe(true)
    expect((await validatePick({ title: "t", options: [{ body: "x" }] }, dir)).many).toBe(false)
  })

  test("resolves a session next to its manifest", async () => {
    const path = join(dir, "pick.json")
    await Bun.write(path, JSON.stringify({ title: "Which?", options: [{ media: ["a.png"] }, { media: ["b.JPG"] }] }))
    const session = await resolvePick(path)
    expect(session.kind).toBe("pick")
    expect(session.id).toStartWith("pick-which-")
    expect(session.outPath).toBe(join(dir, "answer.json"))
    expect(session.statePath).toBe(join(dir, "pick.state.json"))
  })
})

describe("pick media", () => {
  test("rejects paths that leave the folder", async () => {
    expect(await mediaPath(dir, "a.png")).toEndWith("/a.png")
    expect(await mediaPath(dir, "proto/index.html")).toEndWith("/proto/index.html")
    expect(await mediaPath(dir, "../outside.png")).toBeUndefined()
    expect(await mediaPath(dir, "%2e%2e/outside.png")).toBeUndefined()
    expect(await mediaPath(dir, "proto%2F..%2F..%2Foutside.png")).toBeUndefined()
    expect(await mediaPath(dir, "proto/%2e%2e/%2e%2e/outside.png")).toBeUndefined()
    expect(await mediaPath(dir, "link.png")).toBeUndefined()
    expect(await mediaPath(dir, "%zz")).toBeUndefined()
    expect(await mediaPath(dir, "missing.png")).toBeUndefined()
  })

  test("serves byte ranges", async () => {
    const path = join(dir, "c.mp4")
    const ranged = await mediaResponse(path, new Request("http://x", { headers: { range: "bytes=10-19" } }))
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-range")).toBe("bytes 10-19/100")
    expect((await ranged.arrayBuffer()).byteLength).toBe(10)
    const tail = await mediaResponse(path, new Request("http://x", { headers: { range: "bytes=-5" } }))
    expect(tail.headers.get("content-range")).toBe("bytes 95-99/100")
    const beyond = await mediaResponse(path, new Request("http://x", { headers: { range: "bytes=200-" } }))
    expect(beyond.status).toBe(416)
    const whole = await mediaResponse(path, new Request("http://x"))
    expect(whole.status).toBe(200)
  })
})

describe("answers", () => {
  const session = {
    kind: "pick" as const,
    id: "s",
    manifestPath: "/m/pick.json",
    statePath: "/m/pick.state.json",
    outPath: "/m/answer.json",
    pick: {
      title: "t",
      many: true,
      options: ["A", "B", "C"].map((id) => ({ id, label: id, media: [] })),
    },
  }

  test("keeps rank order, drops unknown options and note ids", () => {
    const answer = toAnswer(session, {
      version: 1,
      current: 0,
      picked: ["C", "Z", "A"],
      none: false,
      note: "overall",
      notes: [
        { id: "1", option: "C", body: "pin", media: 0, at: { x: 0.5, y: 0.25 } },
        { id: "2", option: "Z", body: "gone", media: 0 },
        { id: "3", option: "A", body: "time", media: 1, at: { t: 3.2 } },
      ],
    })
    expect(answer.session).toBe("/m/pick.json")
    expect(answer.picked).toEqual(["C", "A"])
    expect(answer.notes).toEqual([
      { option: "C", body: "pin", media: 0, at: { x: 0.5, y: 0.25 } },
      { option: "A", body: "time", media: 1, at: { t: 3.2 } },
    ])
    expect(answerSummary(answer)).toBe("picked C, A")
  })

  test("none of these clears picks", () => {
    const answer = toAnswer(session, { version: 1, current: 0, picked: ["A"], none: true, note: "neither", notes: [] })
    expect(answer.picked).toEqual([])
    expect(answer.none).toBe(true)
    expect(answerSummary(answer)).toBe("none of these")
  })
})

describe("answers given in chat", () => {
  const session = (many: boolean) => ({
    kind: "pick" as const,
    id: "s",
    manifestPath: "/m/pick.json",
    statePath: "/m/pick.state.json",
    outPath: "/m/answer.json",
    pick: { title: "t", many, options: ["A", "B", "C"].map((id) => ({ id, label: id, media: [] })) },
  })
  const noted = { ...EMPTY_PICK_STATE, note: "kept", notes: [{ id: "n", option: "B", body: "pin", media: 0 }] }

  test("matches ids loosely, keeps notes, and takes one pick unless many", () => {
    const state = applyAnswer(session(false), noted, { picked: ["c"] })
    expect(state).toMatchObject({ picked: ["C"], none: false, note: "kept" })
    expect(state.notes).toHaveLength(1)
    expect(applyAnswer(session(true), noted, { picked: ["B", "a"] }).picked).toEqual(["B", "A"])
    expect(applyAnswer(session(false), noted, { none: true, note: "neither" })).toMatchObject({ picked: [], none: true, note: "neither" })
  })

  test("rejects unknown ids, extra picks, and empty answers", () => {
    expect(() => applyAnswer(session(false), noted, { picked: ["Z"] })).toThrow("unknown option Z; options are A, B, C")
    expect(() => applyAnswer(session(false), noted, { picked: ["A", "B"] })).toThrow("takes one option")
    expect(() => applyAnswer(session(false), noted, { picked: ["A"], none: true })).toThrow("--none")
    expect(() => applyAnswer(session(false), EMPTY_PICK_STATE, {})).toThrow("nothing to answer")
  })

  test("a single pick answers with the last one", () => {
    expect(toAnswer(session(false), { ...EMPTY_PICK_STATE, picked: ["A", "C"] }).picked).toEqual(["C"])
  })
})
