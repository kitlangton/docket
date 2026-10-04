import { describe, expect, test } from "bun:test"
import { slug } from "../src/session"
import { migrateState, toVerdicts } from "../src/state"
import { sizeOf, type ItemLoad, type Manifest, type ReviewState } from "../src/types"
import { feed, GROUPS, KEYMAP, readmeTable, type Mode } from "../web/keymap"
import { renderMarkdown } from "../web/markdown"
import { buildModel, displayTitle, fuzzyScore, middleTruncate, nextUnreviewed, rangeAnchor } from "../web/model"

const PATCH = `diff --git a/app.ts b/app.ts
index 1111111..2222222 100644
--- a/app.ts
+++ b/app.ts
@@ -1,5 +1,5 @@ function top()
 const a = 1
-const b = 2
+const b = 3
 const c = 4
 const d = 5
-const e = 6
+const e = 7
diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const x = 1
+export const y = 2
`

describe("buildModel", () => {
  const model = buildModel(PATCH, "t")

  test("parses files, rows with real line numbers, and change blocks", () => {
    expect(model.files.map((file) => file.name)).toEqual(["app.ts", "new.ts"])
    expect(model.blocks).toHaveLength(3)
    const first = model.rows[model.blocks[0]!.first]!
    expect(first).toMatchObject({ file: 0, side: "deletions", line: 2, kind: "del", text: expect.stringContaining("const b = 2") })
    const added = model.rows.filter((row) => row.file === 1)
    expect(added.map((row) => row.line)).toEqual([1, 2])
    expect(added.every((row) => row.kind === "add")).toBe(true)
  })

  test("puts focus files first", () => {
    expect(buildModel(PATCH, "t", ["new.ts"]).files[0]!.name).toBe("new.ts")
  })

  test("range notes anchor to the last row's side", () => {
    const start = model.blocks[0]!.first
    const anchor = rangeAnchor(model.rows, start, start + 1)
    expect(anchor).toMatchObject({ side: "additions", line: 2 })
    expect(anchor.startLine).toBeUndefined()
  })
})

describe("sizeOf", () => {
  test("S, M, and L thresholds", () => {
    expect(sizeOf({ additions: 30, deletions: 20, changedFiles: 3 })).toBe("S")
    expect(sizeOf({ additions: 30, deletions: 21, changedFiles: 3 })).toBe("M")
    expect(sizeOf({ additions: 10, deletions: 0, changedFiles: 4 })).toBe("M")
    expect(sizeOf({ additions: 401, deletions: 0, changedFiles: 1 })).toBe("L")
    expect(sizeOf({ additions: 1, deletions: 0, changedFiles: 16 })).toBe("L")
  })
})

describe("titles and labels", () => {
  test("strips conventional prefixes but leaves refs alone", () => {
    expect(displayTitle("refactor(tui): drop stale export")).toBe("Drop stale export")
    expect(displayTitle("feat!: big change")).toBe("Big change")
    expect(displayTitle("my-branch")).toBe("my-branch")
  })

  test("truncates in the middle", () => {
    expect(middleTruncate("short")).toBe("short")
    const long = middleTruncate("r50231-02-imports..r50231-03-renames")
    expect(long).toContain("…")
    expect(long.startsWith("r50231-02-")).toBe(true)
    expect(long.endsWith("03-renames")).toBe(true)
  })

  test("fuzzy file matching prefers the file name", () => {
    expect(fuzzyScore("src/app.ts", "zzz")).toBeUndefined()
    expect(fuzzyScore("src/app.ts", "app")!).toBeLessThan(fuzzyScore("app/src/other.ts", "app")!)
  })

  test("slugs are stable, filesystem-safe, and bounded", () => {
    expect(slug(["repo", "1", "2"])).toBe("repo-1-2")
    expect(slug(["Repo", "main..feat/x"])).toBe("repo-main..feat-x")
    const long = slug(["x".repeat(100)])
    expect(long.length).toBeLessThanOrEqual(64)
    expect(slug(["x".repeat(100)])).toBe(long)
  })
})

describe("state and verdicts", () => {
  test("migrates legacy prNote and numeric current", () => {
    const state = migrateState({ current: 12, reviews: { "12": { verdict: "approve", prNote: "old", notes: [] } } })
    expect(state.current).toBe("12")
    expect(state.reviews["12"]!.notes).toEqual([expect.objectContaining({ body: "old" })])
  })

  test("builds verdicts with GitHub sides and heads", () => {
    const manifest: Manifest = {
      title: "t",
      repo: { path: "." },
      groups: [{ title: "g", prs: [{ number: 1, confidence: "high" }, { ref: "a..b" }] }],
    }
    const items: Record<string, ItemLoad> = {
      "1": {
        ok: true,
        data: {
          meta: {
            id: "1",
            title: "One",
            body: "",
            headRefName: "h",
            headRefOid: "abc",
            baseRefName: "main",
            state: "OPEN",
            additions: 1,
            deletions: 1,
            changedFiles: 1,
          },
          patch: "",
          patchIgnoreWhitespace: "",
          source: "git",
        },
      },
    }
    const state: ReviewState = {
      version: 2,
      current: null,
      reviews: {
        "1": {
          verdict: "reject",
          reason: "no",
          reviewedHead: "old",
          notes: [
            { id: "a", body: "whole PR" },
            { id: "b", body: "here", path: "x.ts", side: "deletions", line: 4 },
            { id: "c", body: "range", path: "x.ts", side: "additions", startLine: 2, line: 5 },
          ],
        },
      },
    }
    const verdicts = toVerdicts("s.json", manifest, items, state)
    expect(verdicts.prs[0]).toMatchObject({ number: 1, title: "One", confidence: "high", size: "S", verdict: "reject", reason: "no" })
    expect(verdicts.prs[0]).toMatchObject({ reviewedHead: "old", currentHead: "abc" })
    expect(verdicts.prs[0]!.notes).toEqual([
      { body: "whole PR" },
      { path: "x.ts", side: "LEFT", line: 4, body: "here" },
      { path: "x.ts", side: "RIGHT", startLine: 2, line: 5, body: "range" },
    ])
    expect(verdicts.prs[1]).toEqual({ ref: "a..b", verdict: null, notes: [] })
  })

  test("next unreviewed wraps around", () => {
    const state: ReviewState = { version: 2, current: null, reviews: { b: { verdict: "approve", notes: [] } } }
    expect(nextUnreviewed(["a", "b", "c"], state, "a")).toBe("c")
    expect(nextUnreviewed(["a", "b", "c"], state, "c")).toBe("a")
  })
})

describe("keymap", () => {
  const modes: Mode[] = ["normal", "visual", "note", "summary", "home", "tree"]

  test("no two bindings in one mode share a key sequence", () => {
    modes.forEach((mode) => {
      const sequences = KEYMAP.filter((binding) => (binding.modes ?? ["normal"]).includes(mode)).flatMap((binding) => binding.keys)
      expect(sequences.filter((sequence, index) => sequences.indexOf(sequence) !== index)).toEqual([])
    })
  })

  test("every binding is in a known group with a label", () => {
    KEYMAP.forEach((binding) => {
      expect(GROUPS).toContain(binding.group)
      expect(binding.label.length).toBeGreaterThan(0)
    })
  })

  test("sequences, counts, and ambiguous prefixes", () => {
    const empty = { count: "", keys: [] }
    expect(feed(empty, "j", ["normal"])).toMatchObject({ kind: "run", binding: { action: "changeNext" } })
    const g = feed(empty, "g", ["normal"])
    expect(g.kind).toBe("wait")
    if (g.kind === "wait") expect(feed(g.pending, "g", ["normal"])).toMatchObject({ kind: "run", binding: { action: "top" } })
    const three = feed(empty, "3", ["normal"])
    if (three.kind !== "wait") throw new Error("count should wait")
    expect(feed(three.pending, "j", ["normal"])).toMatchObject({ kind: "run", count: 3 })
    const bracket = feed(empty, "]", ["normal"])
    expect(bracket).toMatchObject({ kind: "wait", fallback: { binding: { action: "fileNext" } } })
  })

  test("the README table matches the keymap", async () => {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text()
    expect(readme).toContain(readmeTable())
  })
})

describe("markdown", () => {
  test("renders lists and code", () => {
    const html = renderMarkdown("Intro:\n- one\n- `two`\n\n```ts\nconst x = 1\n```")
    expect(html).toContain("<li>one</li>")
    expect(html).toContain("<code>two</code>")
    expect(html).toContain("<pre>")
  })

  test("escapes raw HTML and drops unsafe links", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.com)",
    )
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="https://example.com"')
  })
})
