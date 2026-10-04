import type { FileDiffMetadata } from "@pierre/diffs"
import { useEffect, useRef } from "react"
import { StatusIcon } from "./diff"

export type TreeRow =
  | { kind: "dir"; path: string; name: string; depth: number; open: boolean }
  | { kind: "file"; path: string; name: string; depth: number; index: number; type: FileDiffMetadata["type"] }

type Dir = { dirs: Map<string, Dir>; files: { name: string; index: number; type: FileDiffMetadata["type"] }[] }

/** The visible rows of a PR's file tree. Folders with a single subfolder and no files merge (`src/ui`). */
export function treeRows(files: Pick<FileDiffMetadata, "name" | "type">[], collapsed: ReadonlySet<string>): TreeRow[] {
  const root: Dir = { dirs: new Map(), files: [] }
  files.forEach((file, index) => {
    const parts = file.name.split("/")
    const dir = parts.slice(0, -1).reduce<Dir>((node, part) => {
      const next: Dir = node.dirs.get(part) ?? { dirs: new Map(), files: [] }
      node.dirs.set(part, next)
      return next
    }, root)
    dir.files.push({ name: parts.at(-1)!, index, type: file.type })
  })
  const walk = (dir: Dir, prefix: string, depth: number): TreeRow[] => [
    ...[...dir.dirs]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, child]) => {
        const merged = mergeChain(name, child)
        const path = prefix + merged.name
        const open = !collapsed.has(path)
        const row: TreeRow = { kind: "dir", path, name: merged.name, depth, open }
        return [row, ...(open ? walk(merged.dir, `${path}/`, depth + 1) : [])]
      }),
    ...dir.files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file): TreeRow => ({ kind: "file", path: prefix + file.name, name: file.name, depth, index: file.index, type: file.type })),
  ]
  return walk(root, "", 0)
}

function mergeChain(name: string, dir: Dir): { name: string; dir: Dir } {
  const [only] = dir.dirs
  if (dir.files.length || dir.dirs.size !== 1 || !only) return { name, dir }
  return mergeChain(`${name}/${only[0]}`, only[1])
}

export function FileTree(props: {
  rows: TreeRow[]
  selected: string | null
  current: number | null
  focused: boolean
  viewed: ReadonlySet<string>
  onPick: (row: TreeRow) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector(".tree-row.is-selected, .tree-row.is-current")?.scrollIntoView({ block: "nearest" })
  }, [props.selected, props.current])
  return (
    <div className={`tree${props.focused ? " is-focused" : ""}`} ref={ref}>
      {props.rows.map((row) => (
        <button
          key={row.path}
          className={[
            "tree-row",
            `is-${row.kind}`,
            row.path === props.selected && props.focused ? "is-selected" : "",
            row.kind === "file" && row.index === props.current ? "is-current" : "",
            row.kind === "file" && props.viewed.has(row.path) ? "is-viewed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ paddingLeft: 10 + row.depth * 14 }}
          title={row.path}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onPick(row)}
        >
          {row.kind === "dir" ? (
            <svg className="tree-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d={row.open ? "M2 3.5l3 3 3-3" : "M3.5 2l3 3-3 3"} />
            </svg>
          ) : (
            <StatusIcon type={row.type} />
          )}
          <span className="tree-name">{row.name}</span>
        </button>
      ))}
    </div>
  )
}
