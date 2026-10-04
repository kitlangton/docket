# docket

A local, keyboard-first review docket for a batch of pull requests.

An agent (or you) puts PRs on the docket: a curated manifest of ordered groups, a list of PR numbers, a `gh pr list` query, or a local branch. A browser tab opens, and you work through every item with Vim-style keys. Leave notes, then approve, reject, or skip each one; each verdict moves you to the next undecided item. When you hand back, docket writes `verdicts.json`, prints a summary, and exits, so an agent running it in the background is notified.

docket reads diffs from your local git checkout and metadata from `gh`. It never writes to GitHub.

## Usage

```sh
docket sessions/tui-cleanup.json          # curated manifest
docket 52985 52988                        # PR numbers, in this order
docket --author @me --state open          # anything gh pr list can filter
docket my-branch                          # local branch against the base it most likely forked from
docket v2..my-branch                      # explicit range (merge-base diff)
```

The repository is the current directory's checkout unless `--repo <path>` is given (a manifest uses its `repo.path`); the GitHub repo comes from the `origin` remote.

| Option          | Description                                     |
| --------------- | ----------------------------------------------- |
| `--repo <path>` | Git checkout to use                             |
| `--out <path>`  | Where to write `verdicts.json`                  |
| `--port <n>`    | Port to listen on (default: any free port)      |
| `--no-open`     | Print the URL without opening a browser         |
| `--refresh`     | Ignore the PR cache                             |

Install with `bun install && bun link`. Requirements: Bun, an authenticated `gh`, and a local clone.

docket prints its URL immediately. It exits 0 when you hand back (`w` on the summary screen), printing one line per item and the verdicts path, or on Ctrl-C, printing `closed without hand-back` and the state path.

For each PR, docket runs `gh pr view`, fetches `pull/N/head` and the base branches in one `git fetch`, and diffs the head against its merge base. If git fails it falls back to `gh pr diff`. PR data is cached under `~/.cache/docket`, so reopening is instant; a background refresh picks up new pushes.

Progress is saved continuously, so a reload or restart resumes where you were. A manifest session keeps `<name>.state.json` and `verdicts.json` next to the manifest; ad-hoc sessions keep them, along with the generated `session.json`, in `~/.local/share/docket/<slug>/`.

## Keys

The keymap is Vim-flavored. This table is generated from `web/keymap.ts`, which also drives key handling and the `?` overlay; run `bun run keys` after changing it.

<!-- keys:start -->
| Keys | Action |
| --- | --- |
| **Navigate** | |
| `j` / `]c` / `}` | Next change (count) |
| `k` / `[c` / `{` | Previous change; from the first, the PR header (count) |
| `Ctrl-n` | Next line (count) |
| `Ctrl-p` | Previous line (count) |
| `]` | Next file (count) |
| `[` | Previous file (count) |
| `J` | Next PR (count) |
| `K` | Previous PR (count) |
| `gg` | Top of PR |
| `G` | Bottom of PR; with a count, that line of the current file (count) |
| `Ctrl-d` | Half page down (count) |
| `Ctrl-u` | Half page up (count) |
| `Ctrl-f` | Page down (count) |
| `Ctrl-b` | Page up (count) |
| `Ctrl-e` | Scroll one line down (count) |
| `Ctrl-y` | Scroll one line up (count) |
| `zz` | Cursor line to center |
| `zt` | Cursor line to top |
| `zb` | Cursor line to bottom |
| `Ctrl-o` | Jump back (count) |
| `Ctrl-i` / `Tab` | Jump forward (count) |
| **Review** | |
| `a` | Approve, then next |
| `r` | Reject with a reason |
| `s` | Skip, then next |
| `u` | Undo verdict change |
| `Ctrl-r` | Redo verdict change |
| `c` | Comment on the PR |
| `C` | Comment on the PR (also in visual mode) |
| `V` / `v` | Select lines (visual mode) |
| `j` / `Ctrl-n` / `ArrowDown` | Extend selection down _(visual)_ |
| `k` / `Ctrl-p` / `ArrowUp` | Extend selection up _(visual)_ |
| `c` / `Enter` | Comment on the selected lines _(visual)_ |
| `e` / `Enter` | Edit the focused PR note _(note)_ |
| `d` | Delete the focused PR note _(note)_ |
| `x` | Mark file viewed |
| **Folds** | |
| `za` / `o` | Toggle fold |
| `zo` | Open fold |
| `zc` | Close fold |
| `zR` | Open all folds |
| `zM` | Fold all files |
| **Commands** | |
| `:` | Command line (:w :q :wq :s :<PR number>) |
| `Enter` | Summary (unfolds a folded file first) |
| `ZZ` | Hand back and close |
| `f` | Jump to file |
| `t` | Split / unified |
| `zw` | Ignore whitespace |
| `O` | Open on GitHub |
| `?` | Toggle this help |
| `Escape` | Cancel pending key or selection |
| `w` | Hand back _(summary)_ |
<!-- keys:end -->

Sequences like `gg`, `]c`, and `zz` are typed one key after another; a bare `]` or `[` runs after a short pause (about 400 ms) if no `c` follows. Bindings marked "(count)" take a count prefix such as `3j`, `2]`, or `5J`; `10G` goes to line 10 of the current file. The status bar shows a pending count or key while you type.

`:` opens a command line: `:w` (or `:wq`, `ZZ`) hands back and exits, `:q` closes without handing back (asking first if you have verdicts; `:q!` skips the question), `:s` or `:summary` opens the summary, and `:52987` jumps to that PR (or `:3` to the third). `C-o` and `C-i`/`Tab` walk the jumplist of big jumps: `gg`, `G`, the file palette, PR switches, and `:N`. `u` and `C-r` undo and redo verdicts given in this session.

PR notes are listed under the header. From the header, `j`/`k` step through them; `e` (or `Enter`) edits the focused note, `d` deletes it, and `Esc` leaves. In a note editor, `Enter` saves, `Shift-Enter` inserts a newline, and `Esc` cancels; saving an empty note deletes it.

Changes with more than 30 files or 3,000 diff lines open with every file folded (except `focus` files), so even very large PRs render instantly; use `f`, `o`, and `x` to work through them.

With the mouse, drag across line numbers to select a range and click **Comment**, click a line to move the cursor there, click a file header to fold it, and click any note to edit it.

## Session manifest

```jsonc
{
  "title": "packages/tui dead-code cleanup",
  "repo": { "path": "/path/to/clone", "github": "owner/repo", "base": "main" },
  "summary": "Optional context for the whole session.",
  "groups": [
    {
      "title": "Theme",
      "why": "Optional group context, shown under each PR's why.",
      "prs": [
        { "number": 101, "why": "One line on what this PR does and why.", "confidence": "high" },
        {
          "number": 102,
          "why": "…",
          "after": [101],
          "focus": ["src/theme/v1.ts"],
          "confidence": "medium",
          "risk": "Safe only if nothing reaches generateSyntax dynamically."
        }
      ]
    }
  ]
}
```

- `after`: PRs this one stacks on. They're shown as hints next to the PR, along with their verdicts.
- `focus`: files to review first. They're listed first and highlighted.
- `confidence`: `"high"`, `"medium"`, or `"low"`: how sure the author is. Shown as a three-bar meter in the rail, the PR bar, and the summary.
- `risk`: one line on what could go wrong, shown under the PR's description and next to approvals in the summary.
- An item may use `"ref": "base..head"` instead of `number` for local work.

docket computes each item's size from its diff: **S** is at most 50 changed lines and 3 files, **L** is more than 400 lines or 15 files, and **M** is everything between.

## verdicts.json

```json
{
  "session": "/abs/path/sessions/tui-cleanup.json",
  "reviewedAt": "2026-10-03T20:15:00.000Z",
  "prs": [
    {
      "number": 102,
      "title": "refactor(theme): remove v1 syntax generation",
      "confidence": "medium",
      "size": "L",
      "verdict": "reject",
      "reason": "Depends on #101 landing first",
      "notes": [
        { "body": "Is generateSyntax covered by tests?" },
        { "path": "src/theme/v1.ts", "side": "LEFT", "line": 74, "body": "Still referenced?" },
        { "path": "src/theme/v1.ts", "side": "RIGHT", "startLine": 10, "line": 14, "body": "This block can go" }
      ]
    }
  ]
}
```

Every item in the session appears, in order. Pull requests have `number`; local refs have `ref` instead. `confidence` is copied from the manifest when present; `size` is docket's S/M/L. `verdict` is `"approve"`, `"reject"`, `"skip"`, or `null` if the item was not reviewed. A note without `path` is about the whole PR. Line notes follow GitHub's review comment convention: `RIGHT` uses the head's line numbers (added and context lines), `LEFT` uses the base's (deleted lines), and `startLine` is present only for multi-line ranges.

State files written by older versions (with `prNote`) are migrated on load.
