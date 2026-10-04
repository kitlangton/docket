import type { FileDiffMetadata } from "@pierre/diffs"

/** Stamps each unmodified-lines row with its count and the header of the hunk it precedes. */
export function stampSeparators(node: HTMLElement, file: FileDiffMetadata) {
  const hunks = file.hunks.filter((hunk) => hunk.collapsedBefore > 0)
  node.shadowRoot?.querySelectorAll<HTMLElement>("[data-gutter], [data-content]").forEach((column) =>
    [...column.querySelectorAll<HTMLElement>(":scope > [data-separator]")].forEach((element, index) => {
      const count = element.textContent?.match(/\d+/)?.[0] ?? element.dataset.count
      if (!count) return
      const hunk = hunks[index]
      element.dataset.count = count
      element.title = `${count} unmodified lines`
      if (!hunk) return
      const specs = `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`
      element.dataset.hunk = hunk.hunkContext ? `${specs} ${hunk.hunkContext.trim()}` : specs
    }),
  )
}

const ROW = "[data-separator=line-info-basic]"
const GUTTER = `[data-gutter] ${ROW}`
// The left content column: deletions in split view, the only column in unified view.
const FIRST_CONTENT = `:is([data-deletions], [data-unified]) [data-content] ${ROW}`
const EXPAND_ICON = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='12' viewBox='0 0 10 12'><path d='M2 4.2L5 1.5l3 2.7M2 7.8L5 10.5l3-2.7' fill='none' stroke='black' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/></svg>",
).replace(/'/g, "%27")}")`

/**
 * GitHub-style unmodified-lines rows, injected into each diff's shadow root: a faint accent band, an expand
 * glyph in the line-number column, and the hunk header (from `data-hunk`, stamped by `stampSeparators`).
 */
export const SEPARATOR_CSS = /* css */ `
${ROW} { height: 24px; background-color: color-mix(in srgb, var(--accent) 7%, var(--bg)); }
${ROW} [data-separator-wrapper] { display: none; }
${ROW}::after { position: absolute; pointer-events: none; }
${GUTTER}::after {
  content: "";
  top: 6px; right: calc(1ch + 4px); width: 10px; height: 12px;
  background-color: var(--text-3);
  -webkit-mask: ${EXPAND_ICON} center / 10px 12px no-repeat;
  mask: ${EXPAND_ICON} center / 10px 12px no-repeat;
}
${FIRST_CONTENT}::after {
  content: attr(data-hunk);
  top: 0; left: 1ch; right: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--text-3);
  font: 11.5px/24px var(--diffs-font-family, monospace);
}
`
