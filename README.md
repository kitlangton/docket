# prdeck

A local, keyboard-first review deck for a batch of pull requests.

An agent writes a session manifest: ordered groups of PRs, each with a one-line `why`. You run `prdeck` on it, a browser tab opens, and you work through every PR with Vim-style keys. Leave line notes, then approve, reject, or skip each PR. Each verdict moves you to the next unreviewed PR. When you finish, prdeck writes `verdicts.json` for the agent to act on.

prdeck reads diffs from your local git checkout and metadata from `gh`. It never writes to GitHub.

## Usage

```sh
bun install
bun bin/prdeck.ts sessions/tui-cleanup.json
# or, after `bun link`:
prdeck sessions/tui-cleanup.json
```

| Option         | Description                                            |
| -------------- | ------------------------------------------------------ |
| `--port <n>`   | Port to listen on (default: any free port)             |
| `--out <path>` | Verdicts path (default: `verdicts.json` next to the session) |
| `--no-open`    | Print the URL without opening a browser                |
| `--refresh`    | Ignore the cache and reload every PR                   |

Requirements: Bun, an authenticated `gh`, and a local clone of the repository at `repo.path`.

For each PR, prdeck runs `gh pr view` for metadata. It fetches `pull/N/head` and the base branch in a single `git fetch`, then diffs the PR head against its merge base with the base branch. If git fails, it falls back to `gh pr diff`. Results are cached under `~/.cache/prdeck`, so reopening a session is instant; a background refresh picks up new pushes.

Review progress is saved continuously to `<session>.state.json` next to the session file. A reload or restart resumes where you left off.

## Keys

| Key                 | Action                                     |
| ------------------- | ------------------------------------------ |
| `j` / `k`           | Next / previous change                     |
| `Ctrl-n` / `Ctrl-p` | Next / previous line                       |
| `]` / `[`           | Next / previous file                       |
| `J` / `K`           | Next / previous PR                         |
| `gg` / `G`          | Top / bottom of the PR                     |
| `Ctrl-d` / `Ctrl-u` | Half page down / up                        |
| `a`                 | Approve and advance                        |
| `r`                 | Reject with an optional reason, and advance |
| `s`                 | Skip and advance                           |
| `u`                 | Clear the verdict                          |
| `n`                 | Note on the cursor line (edits an existing note there) |
| `N`                 | PR-level note                              |
| `o`                 | Fold / unfold the file under the cursor (deleted files start folded) |
| `v`                 | Toggle split / unified                     |
| `z`                 | Toggle ignoring whitespace                 |
| `O`                 | Open the PR on GitHub                      |
| `Enter` or `:`      | Summary (`Enter` unfolds a folded file first) |
| `w`                 | Write `verdicts.json` (on the summary screen) |
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
