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
  notes: Note[]
  draft: Draft | null
  selection: SelectedLineRange | null
  diffStyle: "split" | "unified"
  onLine: (file: number, side: Side, line: number) => void
  onAddNote: (path: string, side: Side, line: number) => void
  onSaveDraft: (body: string) => void
  onCancelDraft: () => void
  onEditNote: (note: Note) => void
}

const UNSAFE_CSS = /* css */ `
[data-diffs-header] { position: sticky; top: 0; z-index: 3; }
[data-line][data-selected-line] { box-shadow: inset 0 0 0 9999px rgba(122, 162, 255, 0.07); }
[data-column-number][data-selected-line] { box-shadow: inset 2px 0 0 rgba(122, 162, 255, 0.4); }
[data-line]:is([data-selected-line="first"], [data-selected-line="single"]) { box-shadow: inset 0 0 0 9999px rgba(122, 162, 255, 0.16); }
[data-column-number]:is([data-selected-line="first"], [data-selected-line="single"]) { box-shadow: inset 3px 0 0 #7aa2ff, inset 0 0 0 9999px rgba(122, 162, 255, 0.22); color: #ffffff; }
`

export const FileBlock = memo(function FileBlock(props: FileBlockProps) {
  const { onLine, onAddNote, index } = props
  const options = useMemo<FileDiffOptions<AnnotationMeta, undefined>>(
    () => ({
      theme: "pierre-dark",
      themeType: "dark",
      diffStyle: props.diffStyle,
      diffIndicators: "bars",
      hunkSeparators: "line-info-basic",
      lineDiffType: "word-alt",
      overflow: "scroll",
      unsafeCSS: UNSAFE_CSS,
      enableGutterUtility: true,
      lineHoverHighlight: "number",
      onGutterUtilityClick: (range) => onAddNote(props.file.name, range.side ?? "additions", range.start),
      onLineClick: (event) => onLine(index, event.annotationSide, event.lineNumber),
    }),
    [props.diffStyle, props.file.name, onLine, onAddNote, index],
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
          <span className="note-mark">note</span>
          <span className="note-body">{meta.note.body}</span>
        </div>
      )
    },
    [onSaveDraft, onCancelDraft, onEditNote],
  )

  const renderSuffix = useCallback(
    () => (
      <span className="file-badges">
        {props.focus ? <span className="badge focus">focus</span> : null}
        {props.notes.length ? <span className="badge notes">{props.notes.length} note{props.notes.length === 1 ? "" : "s"}</span> : null}
      </span>
    ),
    [props.focus, props.notes.length],
  )

  return (
    <section className={`file${props.focus ? " is-focus" : ""}`} data-file-index={props.index}>
      <FileDiff<AnnotationMeta, undefined>
        fileDiff={props.file}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
        selectedLines={props.selection}
        renderHeaderFilenameSuffix={renderSuffix}
        disableWorkerPool
      />
    </section>
  )
})

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
        placeholder={`Note on ${props.draft.side === "deletions" ? "old" : "new"} line ${props.draft.line}…`}
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
        <kbd>Enter</kbd> save · <kbd>Shift Enter</kbd> newline · <kbd>Esc</kbd> cancel
        {props.draft.noteId ? " · empty deletes" : ""}
      </div>
    </div>
  )
}
