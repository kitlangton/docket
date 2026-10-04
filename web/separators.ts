import type { FileDiffMetadata } from "@pierre/diffs"

export const SEPARATOR_STYLES = ["squiggle", "squiggle-label", "inset", "github", "vertical-ellipsis", "torn", "ellipsis"] as const
export type SeparatorStyle = (typeof SEPARATOR_STYLES)[number]

/**
 * CSS for the unmodified-lines rows, injected into each diff's shadow root. The library's own label is hidden;
 * every variant draws with pseudo-elements and reads `data-count` / `data-hunk`, stamped by `stampSeparators`.
 */
export function separatorCSS(style: SeparatorStyle) {
  return BASE + VARIANTS[style]
}

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
const CONTENT = `[data-content] ${ROW}`
// The left content column: deletions in split view, the only column in unified view.
const FIRST_CONTENT = `:is([data-deletions], [data-unified]) ${CONTENT}`

const BASE = /* css */ `
${ROW} { height: 20px; background-color: transparent; }
${ROW} [data-separator-wrapper] { display: none; }
${ROW}::before, ${ROW}::after { position: absolute; pointer-events: none; }
`

// The count sits in the gutter on the line numbers' column: same font, size, color, and right edge
// (the number cell's 1ch padding plus its 2px gap border).
const GUTTER_COUNT = /* css */ `
${GUTTER}::after {
  content: attr(data-count);
  top: 0; right: calc(1ch + 2px);
  font: var(--diffs-font-size, 12.5px) / var(--row, 20px) var(--diffs-font-family, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--text-4);
}
`

const mask = (svg: string, width: number, height: number) => {
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}")`
  return `-webkit-mask: ${url} repeat-x left center / ${width}px ${height}px; mask: ${url} repeat-x left center / ${width}px ${height}px;`
}

const SQUIGGLE = `${CONTENT}::before {
  content: ""; inset: 0;
  background-color: var(--sep-strong);
  ${mask("<svg xmlns='http://www.w3.org/2000/svg' width='12' height='6' viewBox='0 0 12 6'><path d='M0 3 Q3 0.5 6 3 T12 3' fill='none' stroke='black' stroke-width='1'/></svg>", 12, 6)}
}`

const HATCH = /* css */ `
${CONTENT}::before {
  content: ""; inset: 0;
  opacity: 0.6;
  background-image: repeating-linear-gradient(-45deg, transparent, transparent calc(3px * 1.414), var(--diffs-bg-buffer) calc(3px * 1.414), var(--diffs-bg-buffer) calc(4px * 1.414));
  background-size: 8px 8px;
  background-position: 5px 0;
}
`

const VARIANTS: Record<SeparatorStyle, string> = {
  squiggle: GUTTER_COUNT + SQUIGGLE,
  "squiggle-label":
    GUTTER_COUNT +
    SQUIGGLE +
    /* css */ `
${CONTENT}::after {
  content: "unmodified lines";
  top: 2px; left: 1ch; padding: 0 6px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-3);
  font: 11px/16px var(--sans);
}`,
  inset:
    `${ROW} { height: 26px; --row: 26px; }` +
    GUTTER_COUNT +
    /* css */ `
${CONTENT}::before {
  content: ""; inset: 3px 10px 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--band);
}
${CONTENT}::after {
  content: attr(data-count) " unmodified lines";
  top: 0; left: 18px;
  color: var(--text-3);
  font: 11.5px/26px var(--sans);
  font-variant-numeric: tabular-nums;
}`,
  github: /* css */ `
${ROW} { height: 24px; background-color: color-mix(in srgb, var(--accent) 7%, var(--bg)); }
${GUTTER}::after {
  content: "";
  top: 6px; right: calc(1ch + 4px); width: 10px; height: 12px;
  background-color: var(--text-3);
  ${mask("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='12' viewBox='0 0 10 12'><path d='M2 4.2L5 1.5l3 2.7M2 7.8L5 10.5l3-2.7' fill='none' stroke='black' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/></svg>", 10, 12)}
}
${FIRST_CONTENT}::after {
  content: attr(data-hunk);
  top: 0; left: 1ch; right: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--text-3);
  font: 11.5px/24px var(--diffs-font-family, monospace);
}`,
  "vertical-ellipsis":
    GUTTER_COUNT +
    HATCH +
    /* css */ `
${GUTTER}::before {
  content: "⋮";
  top: 0; left: 6px;
  color: var(--text-4);
  font: 13px/20px var(--sans);
}`,
  torn:
    GUTTER_COUNT +
    /* css */ `
${CONTENT}::before {
  content: ""; inset: 0;
  background-color: var(--sep-strong);
  ${mask("<svg xmlns='http://www.w3.org/2000/svg' width='6' height='4' viewBox='0 0 6 4'><path d='M0 3L1.5 1L3 3L4.5 1L6 3' fill='none' stroke='black' stroke-width='0.9' stroke-linejoin='miter'/></svg>", 6, 4)}
}`,
  ellipsis: /* css */ `
${FIRST_CONTENT}::after {
  content: "… " attr(data-count) " lines";
  top: 0; left: 1ch;
  color: var(--text-4);
  font: 11px/20px var(--sans);
  font-variant-numeric: tabular-nums;
}`,
}
