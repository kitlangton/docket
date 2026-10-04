import { Marked, type Tokens } from "marked"
import { useLayoutEffect, useMemo, useRef, useState } from "react"

// PR bodies are untrusted: raw HTML is shown as text, and only http(s)/mailto links survive.
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text }) => escape(text),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens)
      if (!/^(https?:|mailto:)/i.test(href)) return label
      const attrs = title ? ` title="${escape(title)}"` : ""
      return `<a href="${escape(href)}"${attrs} target="_blank" rel="noreferrer noopener">${label}</a>`
    },
  },
})

export function renderMarkdown(source: string) {
  return marked.parse(source, { async: false })
}

/** The first paragraph or line as plain text, for one-line previews. */
export function markdownSummary(source: string) {
  const first = marked.lexer(source).find((token) => token.type !== "space")
  if (!first) return ""
  const text = first.type === "list" ? ((first as Tokens.List).items[0]?.text ?? "") : "text" in first ? String(first.text) : first.raw
  const html = marked.parseInline(text.split("\n")[0] ?? "", { async: false })
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? ""
}

export function Markdown(props: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(props.source), [props.source])
  return <div className={`md${props.className ? ` ${props.className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
}

/** Markdown clipped to about 12 lines, with a quiet toggle when there is more. */
export function ClampedMarkdown(props: { source: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setOverflows(element.scrollHeight > element.clientHeight + 4)
  }, [props.source])
  return (
    <div className={`md-clamp${open ? " is-open" : ""}${overflows ? " is-overflowing" : ""}`}>
      <div ref={ref} className="md-clamp-body">
        <Markdown source={props.source} className={props.className} />
      </div>
      {overflows || open ? (
        <button className="md-more" onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}>
          {open ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  )
}

function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
