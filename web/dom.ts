import { DIFFS_TAG_NAME } from "@pierre/diffs"
import type { Row } from "./model"

/** The rendered line for a row inside its diff's shadow root, or the folded file's header. */
export function rowElement(main: HTMLElement, row: Row) {
  const section = main.querySelector<HTMLElement>(`[data-file-index="${row.file}"]`)
  if (section?.hasAttribute("data-collapsed")) return section
  const host = section?.querySelector(DIFFS_TAG_NAME)
  const root = host?.shadowRoot
  if (!root) return null
  const column = root.querySelector(row.side === "deletions" ? "[data-deletions]" : "[data-additions]") ?? root
  const type = row.kind === "context" ? "context" : row.kind === "add" ? "change-addition" : "change-deletion"
  const candidates = [...column.querySelectorAll<HTMLElement>(`[data-line="${row.line}"]`)]
  return candidates.find((element) => element.dataset.lineType?.startsWith(type)) ?? candidates[0] ?? null
}
