import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs"
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Note, Side } from "../src/types"
import { separatorCSS, stampSeparators, type SeparatorStyle } from "./separators"

export type Draft = { path: string; side: Side; startLine?: number; line: number; body: string; noteId?: string }

type AnnotationMeta = { kind: "note"; note: Note } | { kind: "draft"; draft: Draft }

export type FileBlockProps = {
  index: number
  file: FileDiffMetadata
  focus: boolean
  collapsed: boolean
  viewed: boolean
  cursorHere: boolean
  notes: Note[]
  draft: Draft | null
  selection: SelectedLineRange | null
  /** Visual mode: show the selection as a range instead of the cursor. */
  visual: boolean
  diffStyle: "split" | "unified"
  separator: SeparatorStyle
  onLine: (file: number, side: Side, line: number) => void
  /** A range picked with the mouse; `compose` is true when it came from the gutter + button. */
  onRange: (file: number, range: SelectedLineRange, compose: boolean) => void
  onSaveDraft: (body: string) => void
  onCancelDraft: () => void
  onEditNote: (note: Note) => void
  onToggle: (path: string) => void
}

// Injected into the diff's shadow root. Keeps the diff chrome quiet and draws one cursor indicator.
const BASE_CSS = /* css */ `
:host { --diffs-bg: var(--bg); background-color: var(--bg); }
[data-diffs-header] { position: sticky; top: var(--sticky-offset, 0); z-index: 3; min-height: 0; padding: 0; background: var(--bg); }
[data-line], [data-no-newline] { --mix-dark: 88%; }
[data-gutter-buffer], [data-column-number] { --mix-dark: 91%; }
[data-content-buffer] { opacity: 0.5; }
[data-line-annotation], [data-gutter-buffer=annotation] { --diffs-annotation-bg: var(--bg); }
[data-line][data-selected-line], [data-column-number][data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
}
[data-line-annotation][data-selected-line], [data-gutter-buffer][data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
  box-shadow: none;
}
[data-gutter-utility-slot] { opacity: 0; transition: opacity 120ms; }
[data-column-number]:hover [data-gutter-utility-slot] { opacity: 1; }
[data-utility-button] { background-color: var(--accent); border-radius: 4px; }
[data-column-number] { color: var(--text-4); }
[data-column-number][data-line-type=change-addition] { color: var(--approve); }
[data-column-number][data-line-type=change-deletion] { color: var(--reject); }
[data-column-number][data-selected-line] { color: var(--text-4); }
[data-column-number][data-selected-line][data-line-type=change-addition] { color: var(--approve); }
[data-column-number][data-selected-line][data-line-type=change-deletion] { color: var(--reject); }
`

const CURSOR_CSS = /* css */ `
[data-column-number][data-selected-line] { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 40%, transparent); }
[data-column-number]:is([data-selected-line=first], [data-selected-line=single]) { box-shadow: inset 2px 0 0 var(--accent); color: var(--text); }
[data-line]:is([data-selected-line=first], [data-selected-line=single]) {
  --diffs-computed-selected-line-bg: color-mix(in lab, var(--diffs-computed-diff-line-bg) 90%, var(--accent));
}
`

// Visual mode tints every selected row so the range reads as one block.
const VISUAL_CSS = /* css */ `
[data-line][data-selected-line] {
  --diffs-computed-selected-line-bg: color-mix(in lab, var(--diffs-computed-diff-line-bg) 78%, var(--accent));
}
[data-column-number][data-selected-line] { box-shadow: inset 2px 0 0 var(--accent); color: var(--text); }
`

export const FileBlock = memo(function FileBlock(props: FileBlockProps) {
  const { onLine, onRange, onToggle, index } = props
  const options = useMemo<FileDiffOptions<AnnotationMeta, undefined>>(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "system",
      diffStyle: props.diffStyle,
      diffIndicators: "none",
      hunkSeparators: "line-info-basic",
      lineDiffType: "word-alt",
      overflow: "scroll",
      unsafeCSS: BASE_CSS + separatorCSS(props.separator) + (props.visual ? VISUAL_CSS : CURSOR_CSS),
      onPostRender: (node, _instance, phase) => {
        if (phase !== "unmount") stampSeparators(node, props.file)
      },
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: (range) => onRange(index, range, true),
      onLineSelectionEnd: (range) => {
        if (range) onRange(index, range, false)
      },
      onLineClick: (event) => onLine(index, event.annotationSide, event.lineNumber),
    }),
    [props.diffStyle, props.separator, props.visual, props.file, onLine, onRange, index],
  )

  const annotations = useMemo(() => {
    const notes: DiffLineAnnotation<AnnotationMeta>[] = props.notes.flatMap((note) =>
      note.id === props.draft?.noteId || !note.side || note.line === undefined
        ? []
        : [{ side: note.side, lineNumber: note.line, metadata: { kind: "note" as const, note } }],
    )
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
          {meta.note.startLine ? (
            <span className="note-range">
              Lines {meta.note.startLine}–{meta.note.line}
            </span>
          ) : null}
          <span className="note-body">{meta.note.body}</span>
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
        viewed={props.viewed}
        cursorHere={props.cursorHere}
        notes={props.notes.length}
        onToggle={onToggle}
      />
    ),
    [props.focus, props.collapsed, props.viewed, props.cursorHere, props.notes.length, onToggle],
  )

  const className = `file${props.viewed ? " is-viewed" : ""}`
  // A folded file is only its header: skipping the diff component keeps PRs with hundreds of files fast.
  if (props.collapsed) {
    return (
      <section className={className} data-file-index={props.index} data-collapsed="">
        {renderHeader(props.file)}
      </section>
    )
  }
  return (
    <section className={className} data-file-index={props.index}>
      <FileDiff<AnnotationMeta, undefined>
        fileDiff={props.file}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
        selectedLines={props.selection}
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
  viewed: boolean
  cursorHere: boolean
  notes: number
  onToggle: (path: string) => void
}) {
  const counts = props.file.hunks.reduce((sum, hunk) => ({ add: sum.add + hunk.additionLines, del: sum.del + hunk.deletionLines }), {
    add: 0,
    del: 0,
  })
  const slash = props.file.name.lastIndexOf("/")
  const kind = KIND_LABEL[props.file.type]
  return (
    <div
      className={`fh${props.collapsed ? " is-collapsed" : ""}${props.collapsed && props.cursorHere ? " is-cursor" : ""}`}
      onClick={() => props.onToggle(props.file.name)}
    >
      <svg className="fh-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path
          d={props.collapsed ? "M3.5 2l3 3-3 3" : "M2 3.5l3 3 3-3"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <StatusIcon type={props.file.type} />
      <span className="fh-path">
        {props.file.prevName ? <span className="fh-dir">{props.file.prevName} → </span> : null}
        <span className="fh-dir">{props.file.name.slice(0, slash + 1)}</span>
        <span className="fh-name">{props.file.name.slice(slash + 1)}</span>
      </span>
      {props.focus ? <span className="fh-tag is-focus">focus</span> : null}
      {props.viewed ? <span className="fh-tag is-viewed">Viewed</span> : null}
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

/** Circled change-type glyph, after diffshub's file headers. */
function StatusIcon(props: { type: FileDiffMetadata["type"] }) {
  const kind = props.type === "new" ? "added" : props.type === "deleted" ? "deleted" : props.type === "change" ? "modified" : "renamed"
  return (
    <svg className={`fh-status is-${kind}`} width="14" height="14" viewBox="0 0 14 14" aria-label={kind}>
      <rect x="1" y="1" width="12" height="12" rx="3.5" />
      {kind === "modified" ? <circle cx="7" cy="7" r="2" className="fill" /> : null}
      {kind === "added" ? <path d="M7 4.3v5.4M4.3 7h5.4" /> : null}
      {kind === "deleted" ? <path d="M4.3 7h5.4" /> : null}
      {kind === "renamed" ? <path d="M4.3 7h5M7.5 4.8L9.7 7 7.5 9.2" /> : null}
    </svg>
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
        placeholder={`Note on ${props.draft.side === "deletions" ? "old" : "new"} ${props.draft.startLine ? `lines ${props.draft.startLine}–${props.draft.line}` : `line ${props.draft.line}`}`}
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
