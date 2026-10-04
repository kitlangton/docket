import type { ExpansionDirections, FileDiff, FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs"

/**
 * Context expansion on top of Pierre's own: diffs from a patch are partial, so the first expand loads
 * both sides of the file from the server (`loadDiffFiles`) and Pierre reveals the lines. Gap `i` sits
 * above hunk `i`; gap `hunks.length` is the trailing one. Every expansion is recorded per file and head commit,
 * so it is replayed after a reload or when the PR is opened again, but not onto a later push's different hunks.
 */

const STEP = 20
const ALL = 1_000_000

type Op = [gap: number, direction: ExpansionDirections, lines: number]
// Only expansion is needed from a diff instance, which keeps this independent of its annotation type.
type Instance = Pick<FileDiff<unknown, unknown>, "expandHunk">

// Live diff instances by file key, so keys can expand the file under the cursor.
const instances = new Map<string, Instance>()

export function fileKey(session: string, item: string, head: string, path: string, whitespace: boolean) {
  return `docket.expand:${session}:${item}:${head}:${whitespace ? "w:" : ""}${path}`
}

/** Loads both sides of a file by commit. Without the merge base (diffs from `gh pr diff`) there is nothing to load. */
export function loader(base: string, oldOid: string | undefined, newOid: string) {
  if (!oldOid) return undefined
  const cache = new Map<string, Promise<string | null>>()
  const fetchFile = (oid: string, path: string) => {
    const url = `${base}/file?oid=${oid}&path=${encodeURIComponent(path)}`
    const cached = cache.get(url) ?? fetch(url).then((res) => (res.ok ? res.text() : null))
    cache.set(url, cached)
    return cached
  }
  return async (diff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const oldName = diff.prevName ?? diff.name
    const [oldText, newText] = await Promise.all([fetchFile(oldOid, oldName), fetchFile(newOid, diff.name)])
    if (newText === null) throw new Error(`could not load ${diff.name}`)
    const newFile = { name: diff.name, contents: newText, cacheKey: `${newOid}:${diff.name}` }
    if (diff.type === "rename-pure") return { oldFile: null, newFile }
    if (oldText === null) throw new Error(`could not load ${oldName}`)
    return { oldFile: { name: oldName, contents: oldText, cacheKey: `${oldOid}:${oldName}` }, newFile }
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
function expandGap(key: string, gap: number, hunks: number, all: boolean) {
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
