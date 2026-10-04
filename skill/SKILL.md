---
name: docket
description: Present pull requests or local branches to the user in docket, a local keyboard-first review queue, then act on the verdicts they hand back. Use only when the user asks for docket ("open these in docket", "docket them"). Don't launch it on your own after opening PRs or finishing work; offer it at most once.
---

# docket

`docket` opens a browser tab with a queue of PRs or local ranges. The user reads each diff, leaves notes, and gives each item a verdict: approve, reject, or skip. When they hand back, docket writes `verdicts.json`, prints a summary with its path, and exits. You then act on the verdicts.

## 1. Build the session

For one PR or a few with no particular order, skip the manifest:

```sh
docket 101 102                   # PR numbers; the repo comes from the current checkout's origin
docket --author @me --state open
docket my-branch                 # unpushed work against the base it forked from
docket main..my-branch           # explicit range
docket --repo path/to/repo 101
```

For a batch you produced or curated, write a manifest. It is your pitch to the reviewer; make the order and the reasons do the work.

```json
{
  "title": "Remove dead code in the cart module",
  "repo": { "path": "/abs/path/to/repo", "github": "owner/repo" },
  "summary": "One or two sentences on the batch and how it was verified.",
  "groups": [
    {
      "title": "Pricing",
      "why": "What the group has in common.",
      "prs": [
        { "number": 101, "why": "Concrete evidence it is right.", "confidence": "high" },
        {
          "number": 102,
          "after": [101],
          "why": "…",
          "focus": ["src/pricing.ts"],
          "confidence": "medium",
          "risk": "What could go wrong, in one line."
        },
        { "ref": "main..local-branch", "why": "Work that isn't on GitHub." }
      ]
    }
  ]
}
```

- **Order** groups by dependency, then by how much attention they need. Stack bases come before the PRs on top of them; record stacks with `after`.
- **`why` is evidence, not a restated title:** where the last caller went, search results, what the typecheck or tests prove. Markdown works.
- **`focus`** lists the files that deserve the closest read; they render first.
- **`confidence`** (`high`, `medium`, `low`) is your honest estimate. Add `risk` whenever confidence isn't high.
- `repo.path` may be relative to the manifest. Save the manifest outside the repo's tracked files, or where it won't be committed; state and `verdicts.json` are written next to it.

## 2. Launch and wait

Run docket as a background command so its exit notifies you, then stop and wait. Don't poll.

```sh
docket path/to/manifest.json
```

It prints a URL (`http://docket.localhost:4789/s/<id>`) and blocks until the user hands back. Tell the user the URL. If they want reminders: `j`/`k` changes, `J`/`K` PRs, `c` note, `V` then `c` line note, `a`/`r`/`s` verdict, `?` keys, `w` on the summary to hand back.

If the command exits with `closed without hand-back`, the user stopped without finishing; the session stays open in docket. Ask before relaunching.

## 3. Act on verdicts.json

The last lines of output include `verdicts: <path>`.

```ts
{
  session, reviewedAt,
  prs: [{
    number?, ref?, title?, confidence?, size?: "S" | "M" | "L",
    verdict: "approve" | "reject" | "skip" | null,
    reason?,
    reviewedHead?, currentHead?,
    notes: [{ body } | { path, side: "LEFT" | "RIGHT", startLine?, line, body }],
  }],
}
```

Handle notes before verdicts; a skip with a note usually means "answer this first".

- **Questions** (for example "is this safe?"): verify against the current code and answer each one with evidence: file and line, search results, test output. Never answer from memory.
- **Change requests:** make the change on the branch, push, and offer another docket pass for just those items.
- **approve:** the user approved merging it. Merge in stack order; after a base merges, rebase the PRs stacked on it and wait for CI before merging them.
- **reject:** close the PR with the reason as a short comment. Leave the branch.
- **skip / null:** undecided. List them and ask.
- If `reviewedHead` differs from `currentHead`, commits landed after the verdict. Confirm before acting on it.

Finish with a short table: item, verdict, what you did. If anything is unanswered or changed, offer `docket <those items>` for another pass.
