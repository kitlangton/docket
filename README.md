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

| Key                 | Action                                     |
| ------------------- | ------------------------------------------ |
| `j` / `k`           | Next / previous change; `k` from the first change returns to the PR header |
| `Ctrl-n` / `Ctrl-p` | Next / previous line                       |
| `]` / `[`           | Next / previous file                       |
| `J` / `K`           | Next / previous PR                         |
| `gg` / `G`          | Top / bottom of the PR                     |
| `Ctrl-d` / `Ctrl-u` | Half page down / up                        |
| `a`                 | Approve and advance                        |
| `r`                 | Reject with an optional reason, and advance |
| `s`                 | Skip and advance                           |
| `u`                 | Clear the verdict                          |
| `n`                 | Note on the cursor line (edits an existing note there); a PR-level note when on the header |
| `N`                 | PR-level note                              |
| `o`                 | Fold / unfold the file under the cursor (deleted files start folded) |
| `v`                 | Toggle split / unified                     |
| `z`                 | Toggle ignoring whitespace                 |
| `O`                 | Open the PR on GitHub                      |
| `Enter` or `:`      | Summary (`Enter` unfolds a folded file first) |
| `w`                 | Hand back: write `verdicts.json` and exit (on the summary screen) |
| `?`                 | Help                                       |

In a note editor, `Enter` saves, `Shift-Enter` inserts a newline, and `Esc` cancels. Saving an empty note deletes it. The mouse works too: click a line to move the cursor there, hover the cursor line's number and click `+` to add a note, click a file header to fold it, and click a note to edit it.

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
      "verdict": "reject",
      "reason": "Depends on #101 landing first",
      "notes": [{ "path": "src/theme/v1.ts", "side": "LEFT", "line": 74, "body": "Still referenced?" }],
      "prNote": "Optional PR-level note"
    }
  ]
}
```

`verdict` is `"approve"`, `"reject"`, `"skip"`, or `null` if the PR was not reviewed. Every PR in the manifest appears, in manifest order. A note's `side` and `line` use GitHub's review comment convention: `RIGHT` uses the PR head's line numbers (added and context lines), and `LEFT` uses the base's (deleted lines).
