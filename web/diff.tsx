import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs"
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Note, Side } from "../src/types"

export type Draft = { path: string; side: Side; line: number; body: string; noteId?: string }

type AnnotationMeta = { kind: "note"; note: Note } | { kind: "draft"; draft: Draft }

export type FileBlockProps = {
  index: number
  file: FileDiffMetadata
  focus: boolean
  collapsed: boolean
  cursorHere: boolean
  notes: Note[]
  draft: Draft | null
  selection: SelectedLineRange | null
  diffStyle: "split" | "unified"
  onLine: (file: number, side: Side, line: number) => void
  onAddNote: (path: string, side: Side, line: number) => void
  onSaveDraft: (body: string) => void
  onCancelDraft: () => void
  onEditNote: (note: Note) => void
  onToggle: (path: string) => void
}

// Injected into the diff's shadow root. Keeps the diff chrome quiet and draws one cursor indicator.
const UNSAFE_CSS = /* css */ `
[data-diffs-header] { position: sticky; top: 0; z-index: 3; min-height: 0; padding: 0; background: #0a0a0a; }
[data-separator=line-info-basic] { height: 26px; background-color: transparent; }
[data-separator-wrapper], [data-separator-content] { background-color: transparent; }
[data-separator-content] { color: #4b4f56; font-size: 11px; padding-left: 2ch; }
[data-gutter] [data-separator=line-info-basic] { border-block: 1px solid #16181b; }
[data-content] [data-separator=line-info-basic] { border-block: 1px solid #16181b; }
[data-line][data-selected-line], [data-column-number][data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
}
[data-column-number][data-selected-line] { color: var(--diffs-fg-number); }
[data-column-number][data-selected-line][data-line-type=change-addition] { color: var(--diffs-addition-base); }
[data-column-number][data-selected-line][data-line-type=change-deletion] { color: var(--diffs-deletion-base); }
[data-column-number][data-selected-line] { box-shadow: inset 2px 0 0 rgba(138, 160, 255, 0.35); }
[data-column-number]:is([data-selected-line=first], [data-selected-line=single]) { box-shadow: inset 2px 0 0 #8aa0ff; color: #f2f3f5; }
[data-line]:is([data-selected-line=first], [data-selected-line=single]) {
  --diffs-computed-selected-line-bg: color-mix(in lab, var(--diffs-computed-diff-line-bg) 90%, #8aa0ff);
}
[data-line], [data-no-newline] { --mix-dark: 87%; }
[data-gutter-buffer], [data-column-number] { --mix-dark: 90%; }
[data-line-annotation], [data-gutter-buffer=annotation] { --diffs-annotation-bg: #0a0a0a; }
[data-line-annotation][data-selected-line], [data-gutter-buffer][data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
  box-shadow: none;
}
[data-gutter-utility-slot] { opacity: 0; }
[data-column-number]:hover [data-gutter-utility-slot] { opacity: 1; }
[data-utility-button] { background-color: #8aa0ff; border-radius: 3px; }
`

export const FileBlock = memo(function FileBlock(props: FileBlockProps) {
  const { onLine, onAddNote, onToggle, index } = props
  const options = useMemo<FileDiffOptions<AnnotationMeta, undefined>>(
    () => ({
      theme: "pierre-dark",
      themeType: "dark",
      diffStyle: props.diffStyle,
      diffIndicators: "none",
      hunkSeparators: "line-info-basic",
      lineDiffType: "word-alt",
      overflow: "scroll",
      collapsed: props.collapsed,
      unsafeCSS: UNSAFE_CSS,
      enableGutterUtility: true,
      onGutterUtilityClick: (range) => onAddNote(props.file.name, range.side ?? "additions", range.start),
      onLineClick: (event) => onLine(index, event.annotationSide, event.lineNumber),
    }),
    [props.diffStyle, props.collapsed, props.file.name, onLine, onAddNote, index],
  )

  const annotations = useMemo(() => {
    const notes: DiffLineAnnotation<AnnotationMeta>[] = props.notes
      .filter((note) => note.id !== props.draft?.noteId)
      .map((note) => ({ side: note.side, lineNumber: note.line, metadata: { kind: "note", note } }))
    if (!props.draft) return notes
    const draft = props.draft
    return [...notes, { side: draft.side, lineNumber: draft.line, metadata: { kind: "draft" as const, draft } }]
  }, [props.notes, props.draft])

  const { onSaveDraft, onCancelDraft, onEditNote } = props
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = annotation.metadata
      if (meta.kind === "draft") return <DraftEditor draft={meta.draft} onSave={onSaveDraft} onCancel={onCancelDraft} />
      return (
        <div className="note" onClick={() => onEditNote(meta.note)}>
          {meta.note.body}
        </div>
      )
    },
    [onSaveDraft, onCancelDraft, onEditNote],
  )

  const renderHeader = useCallback(
    (file: FileDiffMetadata) => (
      <FileHeader
        file={file}
        focus={props.focus}
        collapsed={props.collapsed}
        cursorHere={props.cursorHere}
        notes={props.notes.length}
        onToggle={onToggle}
      />
    ),
    [props.focus, props.collapsed, props.cursorHere, props.notes.length, onToggle],
  )

  return (
    <section className="file" data-file-index={props.index} data-collapsed={props.collapsed ? "" : undefined}>
      <FileDiff<AnnotationMeta, undefined>
        fileDiff={props.file}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
        selectedLines={props.collapsed ? null : props.selection}
        renderCustomHeader={renderHeader}
        disableWorkerPool
      />
    </section>
  )
})

function FileHeader(props: {
  file: FileDiffMetadata
  focus: boolean
  collapsed: boolean
  cursorHere: boolean
  notes: number
  onToggle: (path: string) => void
}) {
  const counts = props.file.hunks.reduce(
    (sum, hunk) => ({ add: sum.add + hunk.additionLines, del: sum.del + hunk.deletionLines }),
    { add: 0, del: 0 },
  )
  const slash = props.file.name.lastIndexOf("/")
  const kind = KIND_LABEL[props.file.type]
  return (
    <div className={`fh${props.collapsed ? " is-collapsed" : ""}${props.collapsed && props.cursorHere ? " is-cursor" : ""}`} onClick={() => props.onToggle(props.file.name)}>
      <svg className="fh-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d={props.collapsed ? "M3.5 2l3 3-3 3" : "M2 3.5l3 3 3-3"} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="fh-path">
        {props.file.prevName ? <span className="fh-dir">{props.file.prevName} → </span> : null}
        <span className="fh-dir">{props.file.name.slice(0, slash + 1)}</span>
        <span className="fh-name">{props.file.name.slice(slash + 1)}</span>
      </span>
      {props.focus ? <span className="fh-tag is-focus">focus</span> : null}
      {props.notes ? <span className="fh-tag">{props.notes === 1 ? "1 note" : `${props.notes} notes`}</span> : null}
      <span className="fh-count">
        {kind ? <span>{kind}</span> : null}
        {props.collapsed && props.file.type === "deleted" ? (
          <span>· {counts.del} lines</span>
        ) : (
          <>
            {counts.add ? <span className="add">+{counts.add}</span> : null}
            {counts.del ? <span className="del">−{counts.del}</span> : null}
          </>
        )}
      </span>
    </div>
  )
}

const KIND_LABEL: Record<FileDiffMetadata["type"], string | null> = {
  change: null,
  "rename-pure": "renamed",
  "rename-changed": "renamed",
  new: "new",
  deleted: "deleted",
}

function DraftEditor(props: { draft: Draft; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(props.draft.body)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="draft">
      <textarea
        ref={ref}
        value={body}
        rows={Math.min(8, Math.max(2, body.split("\n").length))}
        placeholder={`Note on ${props.draft.side === "deletions" ? "old" : "new"} line ${props.draft.line}`}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Escape") return props.onCancel()
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            props.onSave(body)
          }
        }}
      />
      <div className="draft-hint">
        Enter to save · Shift-Enter for newline · Esc to cancel{props.draft.noteId ? " · empty deletes" : ""}
      </div>
    </div>
  )
}
