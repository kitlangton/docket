import type { ExpansionDirections, FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs"
import type { FileDiff } from "@pierre/diffs"

/**
 * Context expansion on top of Pierre's own: diffs from a patch are partial, so the first expand loads
 * both sides of the file from the server (`loadDiffFiles`) and Pierre reveals the lines. Gap `i` sits
 * above hunk `i`; gap `hunks.length` is the trailing one. Every expansion is recorded per file so it can
 * be replayed after a reload or when the PR is opened again.
 */

export const STEP = 20
const ALL = 1_000_000

type Op = [gap: number, direction: ExpansionDirections, lines: number]
// Only expansion is needed from a diff instance, which keeps this independent of its annotation type.
type Instance = Pick<FileDiff<unknown, unknown>, "expandHunk">

// Live diff instances by file key, so keys can expand the file under the cursor.
const instances = new Map<string, Instance>()

export function fileKey(session: string, item: string, path: string, whitespace: boolean) {
  return `docket.expand:${session}:${item}:${whitespace ? "w:" : ""}${path}`
}

export function loader(base: string, item: string) {
  const cache = new Map<string, Promise<string | null>>()
  const fetchSide = (side: "old" | "new", path: string) => {
    const url = `${base}/file?item=${encodeURIComponent(item)}&side=${side}&path=${encodeURIComponent(path)}`
    const cached = cache.get(url) ?? fetch(url).then((res) => (res.ok ? res.text() : null))
    cache.set(url, cached)
    return cached
  }
  return async (diff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const [oldText, newText] = await Promise.all([fetchSide("old", diff.prevName ?? diff.name), fetchSide("new", diff.name)])
    if (newText === null) throw new Error(`could not load ${diff.name}`)
    const newFile = { name: diff.name, contents: newText, cacheKey: `${item}:new:${diff.name}` }
    if (diff.type === "rename-pure") return { oldFile: null, newFile }
    if (oldText === null) throw new Error(`could not load ${diff.prevName ?? diff.name}`)
    return {
      oldFile: { name: diff.prevName ?? diff.name, contents: oldText, cacheKey: `${item}:old:${diff.prevName ?? diff.name}` },
      newFile,
    }
  }
}

/** Registers a mounted diff and replays the expansions saved for it. */
export function attach(key: string, instance: Instance) {
  if (instances.get(key) === instance) return
  instances.set(key, instance)
  saved(key).forEach(([gap, direction, lines]) => instance.expandHunk(gap, direction, lines))
}

export function detach(key: string, instance: Instance) {
  if (instances.get(key) === instance) instances.delete(key)
}

/** Expands one gap: `lines` next to the changes on both of its sides, or all of it. */
export function expandGap(key: string, gap: number, hunks: number, all: boolean) {
  // Leading gaps grow up from the first hunk, trailing gaps down from the last, middle gaps both ways.
  const direction: ExpansionDirections = gap === 0 ? "down" : gap >= hunks ? "up" : "both"
  const lines = all ? ALL : direction === "both" ? STEP / 2 : STEP
  run(key, [gap, direction, lines])
}

/** Expands the context around one hunk: the gap above it and the gap below it. */
export function expandAround(key: string, hunk: number, all: boolean) {
  run(key, [hunk, "down", all ? ALL : STEP])
  run(key, [hunk + 1, "up", all ? ALL : STEP])
}

function run(key: string, op: Op) {
  instances.get(key)?.expandHunk(...op)
  localStorage.setItem(key, JSON.stringify([...saved(key), op]))
}

function saved(key: string): Op[] {
  const raw = localStorage.getItem(key)
  return raw ? JSON.parse(raw) : []
}

/** Clicks on a separator row (gutter or band) expand that gap; Shift expands it fully. */
export function onSeparatorClick(key: string, hunks: () => number) {
  return (event: Event) => {
    if (!(event instanceof MouseEvent)) return
    const separator = event
      .composedPath()
      .find((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-separator"))
    const gap = separator?.dataset.expandIndex
    if (gap === undefined) return
    event.stopPropagation()
    expandGap(key, Number(gap), hunks(), event.shiftKey)
  }
}
