---
name: docket
description: Present pull requests or local branches to the user in docket, a local keyboard-first review queue, then act on the verdicts they hand back; or, with `docket pick`, show visual or text options and act on the one they choose. Use only when the user asks for docket ("open these in docket", "docket them") or asks to see options and decide ("show me options", "let me pick"). Don't launch it on your own after opening PRs or finishing work; offer it at most once.
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

## Picks: when the user wants to choose

Use `docket pick` only when the user asks for options or a decision ("show me a few directions", "let me pick"). Don't use it for a question you can settle yourself.

1. **Render real options.** Put everything in one folder with the manifest. Screenshot each option in light and dark and pair them; for anything that scrolls or moves, record a short video (mp4) of the scroll or interaction. A local prototype can be a folder with `index.html`; a deployed one, an `https` URL. Include a screenshot of today's version as `baseline` when you're changing something that exists.
2. **Write the manifest:**

   ```json
   {
     "title": "Code block style",
     "question": "Which code block style?",
     "pick": "one",
     "baseline": { "light": "current-light.png", "dark": "current-dark.png" },
     "options": [
       { "label": "Card", "why": "One line on the idea and its trade-off.", "media": [{ "light": "a-light.png", "dark": "a-dark.png" }, "a-scroll.mp4"] },
       { "label": "Inline", "media": [{ "light": "b-light.png", "dark": "b-dark.png" }] }
     ],
     "previous": "../round-1/answer.json"
   }
   ```

   Only `title` and `options` are required. Ids default to A, B, C…. Each card shows its videos full width and its stills two to a row, so give each option one video plus a pair of stills (for example at rest and mid-interaction), each as a light/dark pair. Set `"pick": "many"` only if a ranking helps; by default the user picks one. Paths are relative to the manifest and must stay in its folder. For a second round, start a new folder and set `previous` to the last `answer.json`.
3. **Run it in the background** and wait; don't poll: `docket pick path/to/pick.json`. It prints a local link and, on a tailnet, a `https://…ts.net:<port>/s/<id>` link. Post the ts.net one, which also works on a phone. Add `--timeout 30m` if you shouldn't wait forever.
4. **Act on `answer.json`** (the output ends with `answer: <path>`):

   ```ts
   { session, answeredAt, picked: string[] /* one id, or a ranking with "pick": "many" */, none: boolean, note: string,
     notes: [{ option, body, media /* index */, at?: { x, y } /* fractions of the image */ | { t } /* video seconds */ }] }
   ```

   If the user answers in chat instead ("C"), record it with `docket answer <id|url> --pick C [--note "…"]`; the waiting command then exits as if they had pressed Send. Build `picked[0]`, applying its notes and the overall `note`. A pin locates the complaint on that image. Use lower ranks only as fallbacks or to borrow details the user's notes point at. `none: true` means start over; the reason is in `note`. `closed without answer` means the user stopped; ask before relaunching. `timed out` leaves the pick open in their inbox.
