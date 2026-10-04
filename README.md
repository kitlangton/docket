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

| Key                 | Action                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `j` / `k`           | Next / previous change; `k` from the first change returns to the header |
| `Ctrl-n` / `Ctrl-p` | Next / previous line                                                  |
| `]` / `[`           | Next / previous file                                                  |
| `J` / `K`           | Next / previous item                                                  |
| `gg` / `G`          | Top / bottom of the item                                              |
| `Ctrl-d` / `Ctrl-u` | Half page down / up                                                   |
| `a`                 | Approve and advance                                                   |
| `r`                 | Reject with an optional reason, and advance                           |
| `s`                 | Skip and advance                                                      |
| `u`                 | Clear the verdict                                                     |
| `n` / `N`           | Note on the whole PR                                                  |
| `V` / `v`           | Select lines (visual mode): `j`/`k` extend, `n` or `Enter` comments, `Esc` exits |
| `f`                 | Jump to a file (fuzzy)                                                |
| `x`                 | Mark the file under the cursor viewed (folds it; progress in the header) |
| `o`                 | Fold / unfold the file under the cursor (deleted and viewed files start folded) |
| `t`                 | Toggle split / unified                                                |
| `z`                 | Toggle ignoring whitespace                                            |
| `O`                 | Open on GitHub                                                        |
| `Enter` or `:`      | Summary (`Enter` unfolds a folded file first)                         |
| `w`                 | Hand back: write `verdicts.json` and exit (on the summary screen)     |
| `?`                 | Help                                                                  |

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
        { "number": 101, "why": "One line on what this PR does and why." },
        { "number": 102, "why": "…", "after": [101], "focus": ["src/theme/v1.ts"] }
      ]
    }
  ]
}
```

- `after`: PRs this one stacks on. They're shown as hints next to the PR, along with their verdicts.
- `focus`: files to review first. They're listed first and highlighted.

## verdicts.json

```json
{
  "session": "/abs/path/sessions/tui-cleanup.json",
  "reviewedAt": "2026-10-03T20:15:00.000Z",
  "prs": [
    {
      "number": 102,
      "title": "refactor(theme): remove v1 syntax generation",
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

Every item in the session appears, in order. Pull requests have `number`; local refs have `ref` instead. `verdict` is `"approve"`, `"reject"`, `"skip"`, or `null` if the item was not reviewed. A note without `path` is about the whole PR. Line notes follow GitHub's review comment convention: `RIGHT` uses the head's line numbers (added and context lines), `LEFT` uses the base's (deleted lines), and `startLine` is present only for multi-line ranges.

State files written by older versions (with `prNote`) are migrated on load.
