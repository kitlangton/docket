import type { Side } from "../src/types"

export type NoteRange = { side: Side; start: number; end: number }

/**
 * Marks every row a line note covers, GitHub-style, so a multi-line note reads as one block: `data-noted` is
 * "first", "last", "single", or "" (middle) on both the line-number cell and the code cell of each row.
 */
export function stampNoteRanges(node: HTMLElement, ranges: readonly NoteRange[]) {
  const root = node.shadowRoot
  if (!root) return
  root.querySelectorAll("[data-noted]").forEach((element) => element.removeAttribute("data-noted"))
  if (ranges.length === 0) return

  root.querySelectorAll<HTMLElement>("[data-content]").forEach((content) => {
    const gutter = content.parentElement?.querySelector<HTMLElement>(":scope > [data-gutter]")
    if (!gutter) return
    const column = content.closest("[data-deletions], [data-additions], [data-unified]")
    const fixedSide: Side | null = column?.hasAttribute("data-deletions")
      ? "deletions"
      : column?.hasAttribute("data-additions")
        ? "additions"
        : null

    const rows = [...content.children]
    rows.forEach((row, index) => {
      if (!(row instanceof HTMLElement) || !row.hasAttribute("data-line")) return
      const line = Number(row.dataset.line)
      const side = fixedSide ?? (row.dataset.lineType === "change-deletion" ? "deletions" : "additions")
      const range = ranges.find((r) => r.side === side && line >= r.start && line <= r.end)
      if (!range) return
      const value = range.start === range.end ? "single" : line === range.start ? "first" : line === range.end ? "last" : ""
      row.setAttribute("data-noted", value)
      gutter.children[index]?.setAttribute("data-noted", value)
    })
  })
}

/** Injected into each diff's shadow root: a faint tint on noted rows and one continuous accent bar in the gutter. */
export const NOTE_RANGE_CSS = /* css */ `
[data-line][data-noted] {
  background-image: linear-gradient(color-mix(in srgb, var(--accent) 8%, transparent), color-mix(in srgb, var(--accent) 8%, transparent));
}
[data-column-number][data-noted] {
  background-image: linear-gradient(color-mix(in srgb, var(--accent) 8%, transparent), color-mix(in srgb, var(--accent) 8%, transparent));
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 75%, transparent);
  color: var(--text-2);
}
`
