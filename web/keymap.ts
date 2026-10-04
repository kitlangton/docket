/**
 * docket's keymap: one table that drives key handling, the `?` overlay, and the README key table
 * (`bun run keys` regenerates it), so the three cannot drift.
 */

export type Mode = "normal" | "visual" | "note" | "summary" | "home"
export type Group = "Navigate" | "Review" | "Folds" | "Commands" | "Inbox"

export type Action =
  | "changeNext"
  | "changePrev"
  | "lineNext"
  | "linePrev"
  | "fileNext"
  | "filePrev"
  | "prNext"
  | "prPrev"
  | "top"
  | "bottom"
  | "halfDown"
  | "halfUp"
  | "pageDown"
  | "pageUp"
  | "scrollDown"
  | "scrollUp"
  | "cursorCenter"
  | "cursorTop"
  | "cursorBottom"
  | "jumpBack"
  | "jumpForward"
  | "approve"
  | "reject"
  | "skip"
  | "undo"
  | "redo"
  | "comment"
  | "commentPr"
  | "visual"
  | "visualDown"
  | "visualUp"
  | "visualComment"
  | "visualExit"
  | "noteNext"
  | "notePrev"
  | "noteEdit"
  | "noteDelete"
  | "viewed"
  | "foldToggle"
  | "foldOpen"
  | "foldClose"
  | "foldOpenAll"
  | "foldCloseAll"
  | "expandContext"
  | "expandContextAll"
  | "palette"
  | "splitToggle"
  | "whitespaceToggle"
  | "openGithub"
  | "commandLine"
  | "summary"
  | "handBackClose"
  | "help"
  | "cancel"
  | "summaryNext"
  | "summaryPrev"
  | "summaryOpen"
  | "summaryBack"
  | "handBack"
  | "goHome"
  | "homeNext"
  | "homePrev"
  | "homeOpen"
  | "homeArchive"

export type Binding = {
  /** Alternative key sequences; keys within a sequence are space-separated, e.g. "g g", "C-d", "] c". */
  keys: string[]
  action: Action
  label: string
  group: Group
  modes?: Mode[]
  /** Accepts a count prefix (`3j`). */
  count?: boolean
  /** Left out of the help overlay and README (e.g. arrow-key aliases). */
  hidden?: boolean
}

export const KEYMAP: Binding[] = [
  { keys: ["j", "] c", "}"], action: "changeNext", label: "Next change", group: "Navigate", count: true },
  { keys: ["k", "[ c", "{"], action: "changePrev", label: "Previous change; from the first, the PR header", group: "Navigate", count: true },
  { keys: ["C-n"], action: "lineNext", label: "Next line", group: "Navigate", count: true },
  { keys: ["C-p"], action: "linePrev", label: "Previous line", group: "Navigate", count: true },
  { keys: ["]"], action: "fileNext", label: "Next file", group: "Navigate", count: true },
  { keys: ["["], action: "filePrev", label: "Previous file", group: "Navigate", count: true },
  { keys: ["J"], action: "prNext", label: "Next PR", group: "Navigate", count: true },
  { keys: ["K"], action: "prPrev", label: "Previous PR", group: "Navigate", count: true },
  { keys: ["g g"], action: "top", label: "Top of PR", group: "Navigate" },
  { keys: ["G"], action: "bottom", label: "Bottom of PR; with a count, that line of the current file", group: "Navigate", count: true },
  { keys: ["C-d"], action: "halfDown", label: "Half page down", group: "Navigate", count: true },
  { keys: ["C-u"], action: "halfUp", label: "Half page up", group: "Navigate", count: true },
  { keys: ["C-f"], action: "pageDown", label: "Page down", group: "Navigate", count: true },
  { keys: ["C-b"], action: "pageUp", label: "Page up", group: "Navigate", count: true },
  { keys: ["C-e"], action: "scrollDown", label: "Scroll one line down", group: "Navigate", count: true },
  { keys: ["C-y"], action: "scrollUp", label: "Scroll one line up", group: "Navigate", count: true },
  { keys: ["z z"], action: "cursorCenter", label: "Cursor line to center", group: "Navigate" },
  { keys: ["z t"], action: "cursorTop", label: "Cursor line to top", group: "Navigate" },
  { keys: ["z b"], action: "cursorBottom", label: "Cursor line to bottom", group: "Navigate" },
  { keys: ["C-o"], action: "jumpBack", label: "Jump back", group: "Navigate", count: true },
  { keys: ["C-i", "Tab"], action: "jumpForward", label: "Jump forward", group: "Navigate", count: true },

  { keys: ["a"], action: "approve", label: "Approve, then next", group: "Review" },
  { keys: ["r"], action: "reject", label: "Reject with a reason", group: "Review" },
  { keys: ["s"], action: "skip", label: "Skip, then next", group: "Review" },
  { keys: ["u"], action: "undo", label: "Undo verdict change", group: "Review" },
  { keys: ["C-r"], action: "redo", label: "Redo verdict change", group: "Review" },
  { keys: ["c"], action: "comment", label: "Comment on the PR", group: "Review" },
  { keys: ["C"], action: "commentPr", label: "Comment on the PR (also in visual mode)", group: "Review", modes: ["normal", "visual"] },
  { keys: ["V", "v"], action: "visual", label: "Select lines (visual mode)", group: "Review" },
  { keys: ["j", "C-n", "ArrowDown"], action: "visualDown", label: "Extend selection down", group: "Review", modes: ["visual"] },
  { keys: ["k", "C-p", "ArrowUp"], action: "visualUp", label: "Extend selection up", group: "Review", modes: ["visual"] },
  { keys: ["c", "Enter"], action: "visualComment", label: "Comment on the selected lines", group: "Review", modes: ["visual"] },
  { keys: ["Escape", "V", "v"], action: "visualExit", label: "Leave visual mode", group: "Review", modes: ["visual"], hidden: true },
  { keys: ["j"], action: "noteNext", label: "Next PR note", group: "Review", modes: ["note"], hidden: true },
  { keys: ["k"], action: "notePrev", label: "Previous PR note", group: "Review", modes: ["note"], hidden: true },
  { keys: ["e", "Enter"], action: "noteEdit", label: "Edit the focused PR note", group: "Review", modes: ["note"] },
  { keys: ["d"], action: "noteDelete", label: "Delete the focused PR note", group: "Review", modes: ["note"] },
  { keys: ["x"], action: "viewed", label: "Mark file viewed", group: "Review" },

  { keys: ["z a", "o"], action: "foldToggle", label: "Toggle fold", group: "Folds" },
  { keys: ["z o"], action: "foldOpen", label: "Open fold", group: "Folds" },
  { keys: ["z c"], action: "foldClose", label: "Close fold", group: "Folds" },
  { keys: ["z R"], action: "foldOpenAll", label: "Open all folds", group: "Folds" },
  { keys: ["z M"], action: "foldCloseAll", label: "Fold all files", group: "Folds" },
  { keys: ["e"], action: "expandContext", label: "Expand 20 lines of context around the change", group: "Folds" },
  { keys: ["E"], action: "expandContextAll", label: "Expand all context around the change", group: "Folds" },

  { keys: [":"], action: "commandLine", label: "Command line (:w :q :wq :s :<PR number>)", group: "Commands", modes: ["normal", "summary"] },
  { keys: ["Enter"], action: "summary", label: "Summary (unfolds a folded file first)", group: "Commands" },
  { keys: ["Z Z"], action: "handBackClose", label: "Hand back and close", group: "Commands", modes: ["normal", "summary"] },
  { keys: ["f"], action: "palette", label: "Jump to file", group: "Commands" },
  { keys: ["t"], action: "splitToggle", label: "Split / unified", group: "Commands" },
  { keys: ["z w"], action: "whitespaceToggle", label: "Ignore whitespace", group: "Commands" },
  { keys: ["O"], action: "openGithub", label: "Open on GitHub", group: "Commands" },
  { keys: ["?"], action: "help", label: "Toggle this help", group: "Commands", modes: ["normal", "visual", "note", "summary", "home"] },
  { keys: ["Escape"], action: "cancel", label: "Cancel pending key or selection", group: "Commands", modes: ["normal", "note"] },

  { keys: ["j", "ArrowDown"], action: "summaryNext", label: "Next PR", group: "Commands", modes: ["summary"], hidden: true },
  { keys: ["k", "ArrowUp"], action: "summaryPrev", label: "Previous PR", group: "Commands", modes: ["summary"], hidden: true },
  { keys: ["Enter"], action: "summaryOpen", label: "Open PR", group: "Commands", modes: ["summary"], hidden: true },
  { keys: ["Escape", "q"], action: "summaryBack", label: "Back to the PR", group: "Commands", modes: ["summary"], hidden: true },
  { keys: ["w"], action: "handBack", label: "Hand back", group: "Commands", modes: ["summary"] },

  { keys: ["g h"], action: "goHome", label: "Go to the inbox", group: "Inbox", modes: ["normal", "summary"] },
  { keys: ["j", "ArrowDown"], action: "homeNext", label: "Next session", group: "Inbox", modes: ["home"] },
  { keys: ["k", "ArrowUp"], action: "homePrev", label: "Previous session", group: "Inbox", modes: ["home"] },
  { keys: ["Enter", "o"], action: "homeOpen", label: "Open session", group: "Inbox", modes: ["home"] },
  { keys: ["d"], action: "homeArchive", label: "Archive a session that isn't waiting", group: "Inbox", modes: ["home"] },
]

export const GROUPS: Group[] = ["Navigate", "Review", "Folds", "Commands", "Inbox"]

// An ambiguous prefix (`]` before `] c`) waits this long before running the shorter binding.
export const SEQUENCE_TIMEOUT = 400
// A pure prefix (`g`, `z`, `Z`) waits this long for the rest of its sequence.
const PREFIX_TIMEOUT = 1000

export type Pending = { count: string; keys: string[] }

/**
 * Feeds one key into the pending state for the given modes (tried in order, e.g. visual then normal).
 * Returns what to do: run a binding now, wait (optionally running a binding on timeout), or nothing matched.
 */
export function feed(pending: Pending, key: string, modes: Mode[]) {
  if (/^[0-9]$/.test(key) && !pending.keys.length && (key !== "0" || pending.count)) {
    return { kind: "wait" as const, pending: { count: pending.count + key, keys: [] }, timeout: PREFIX_TIMEOUT }
  }
  const keys = [...pending.keys, key]
  const count = pending.count ? Number(pending.count) : undefined
  const candidates = modes.flatMap((mode) =>
    KEYMAP.filter((binding) => (binding.modes ?? ["normal"]).includes(mode)).flatMap((binding) =>
      binding.keys.map((sequence) => ({ binding, mode, sequence: sequence.split(" ") })),
    ),
  )
  const prefixed = candidates.filter((candidate) => keys.every((part, index) => candidate.sequence[index] === part))
  const exact = prefixed.find((candidate) => candidate.sequence.length === keys.length)
  const longer = prefixed.some((candidate) => candidate.sequence.length > keys.length)
  if (exact && !longer) return { kind: "run" as const, binding: exact.binding, mode: exact.mode, count }
  if (longer)
    return {
      kind: "wait" as const,
      pending: { count: pending.count, keys },
      timeout: exact ? SEQUENCE_TIMEOUT : PREFIX_TIMEOUT,
      fallback: exact ? { binding: exact.binding, mode: exact.mode, count } : undefined,
    }
  // A broken sequence retries its last key alone, as Vim does.
  if (pending.keys.length) return feed({ count: "", keys: [] }, key, modes)
  return { kind: "none" as const }
}

export function keyName(event: KeyboardEvent) {
  if (event.ctrlKey && event.key.length === 1) return `C-${event.key.toLowerCase()}`
  return event.key
}

const DISPLAY: Record<string, string> = { Escape: "esc", Enter: "↵", ArrowDown: "↓", ArrowUp: "↑", Tab: "tab" }

/** A sequence for display: "C-d" → "⌃d", "g g" → "g g". */
export function displayKeys(sequence: string) {
  return sequence
    .split(" ")
    .map((part) => DISPLAY[part] ?? part.replace(/^C-/, "⌃"))
    .join(" ")
}

/** Bindings for the help overlay and README, grouped, with duplicates of the same action merged. */
export function helpRows() {
  return GROUPS.map((group) => ({
    group,
    rows: KEYMAP.filter((binding) => binding.group === group && !binding.hidden),
  }))
}

export function readmeTable() {
  const lines = helpRows().flatMap(({ group, rows }) => [
    `| **${group}** | |`,
    ...rows.map((binding) => {
      const keys = binding.keys.map((sequence) => `\`${sequence.replace(/^C-/, "Ctrl-").replace(/ /g, "")}\``).join(" / ")
      const mode = binding.modes?.length === 1 && binding.modes[0] !== "normal" ? ` _(${binding.modes[0]})_` : ""
      return `| ${keys} | ${binding.label}${mode}${binding.count ? " (count)" : ""} |`
    }),
  ])
  return ["| Keys | Action |", "| --- | --- |", ...lines].join("\n")
}
