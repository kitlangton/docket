import { useEffect, type RefObject } from "react"
import { rowElement } from "./dom"
import type { Row } from "./model"

/** A literal search: smartcase (case-sensitive only when the pattern has a capital), optionally whole-word. */
export type Query = { pattern: string; word: boolean }
export type Match = { row: number; start: number; end: number }

const MAX_MATCHES = 5000

export function findMatches(rows: Row[], query: Query) {
  if (!query.pattern) return []
  const flags = /[A-Z]/.test(query.pattern) ? "g" : "gi"
  const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(query.word ? `(?<![\\w$])${escaped}(?![\\w$])` : escaped, flags)
  return rows
    .flatMap((row, index) => [...row.text.matchAll(regex)].map((found) => ({ row: index, start: found.index, end: found.index + found[0].length })))
    .slice(0, MAX_MATCHES)
}

/** The match the cursor is on (preferring `current` when it is on that row), or -1. */
export function matchIndexAt(matches: Match[], row: number, current: number) {
  if (matches[current]?.row === row) return current
  return matches.findIndex((match) => match.row === row)
}

const KEYWORDS = new Set(
  "const let var function return import export from type interface class extends implements new if else for while do switch case break continue await async yield of in as default public private protected readonly static true false null undefined this void typeof".split(
    " ",
  ),
)

/** The identifier `*` and `#` search for: the first non-keyword identifier on the cursor line. */
export function wordAt(text: string) {
  return text.match(/[A-Za-z_$][\w$]*/g)?.find((word) => word.length > 1 && !KEYWORDS.has(word))
}

/**
 * Paints matches with the CSS Custom Highlight API, which reaches into the diffs' shadow roots
 * (each root styles `::highlight(docket-search)`). Re-runs after renders that may replace lines.
 */
export function useSearchHighlights(
  mainRef: RefObject<HTMLElement | null>,
  matches: Match[],
  current: number,
  rows: Row[],
  deps: unknown[],
) {
  useEffect(() => {
    const registry = CSS.highlights
    if (!registry) return
    const paint = () => {
      const main = mainRef.current
      registry.delete("docket-search")
      registry.delete("docket-search-current")
      if (!main || !matches.length) return
      const all = new Highlight()
      const active = new Highlight()
      matches.forEach((match, index) => {
        const row = rows[match.row]
        const element = row && rowElement(main, row)
        if (!element || element.hasAttribute("data-file-index")) return
        const range = textRange(element, match.start, match.end)
        if (!range) return
        if (index === current) active.add(range)
        else all.add(range)
      })
      registry.set("docket-search", all)
      registry.set("docket-search-current", active)
    }
    paint()
    // Diffs highlight asynchronously and may replace their lines; paint again once they settle.
    const timers = [requestAnimationFrame(paint), setTimeout(paint, 150), setTimeout(paint, 600)]
    return () => {
      cancelAnimationFrame(timers[0] as number)
      timers.slice(1).forEach((timer) => clearTimeout(timer))
      registry.delete("docket-search")
      registry.delete("docket-search-current")
    }
  }, [matches, current, rows, ...deps])
}

function textRange(element: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  const state = { offset: 0, started: false }
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (!state.started && start <= state.offset + length) {
      range.setStart(node, start - state.offset)
      state.started = true
    }
    if (state.started && end <= state.offset + length) {
      range.setEnd(node, end - state.offset)
      return range
    }
    state.offset += length
  }
  return undefined
}
