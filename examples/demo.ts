#!/usr/bin/env bun
// Creates ./demo-repo: a small TypeScript project with three branches to review, and a manifest for them.
// Run `bun examples/demo.ts`, then `docket demo-repo/docket.json`.
import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const dir = resolve(Bun.argv[2] ?? "demo-repo")
await rm(dir, { recursive: true, force: true })

const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", "-c", "user.name=docket", "-c", "user.email=docket@example.com", ...args], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
}
const write = (path: string, text: string) => Bun.write(join(dir, path), text)

await Bun.write(join(dir, ".keep"), "")
await git("init", "-q", "-b", "main")
await write(
  "src/cart.ts",
  `import { formatPrice } from "./format"

export type Item = { name: string; price: number; quantity: number }

export function subtotal(items: Item[]) {
  let total = 0
  for (const item of items) {
    total += item.price * item.quantity
  }
  return total
}

export function applyDiscount(total: number, percent: number) {
  return total - total * (percent / 100)
}

export function describe(items: Item[]) {
  return items.map((item) => \`\${item.quantity} × \${item.name}\`).join(", ")
}

export function receipt(items: Item[], discount = 0) {
  const total = applyDiscount(subtotal(items), discount)
  return \`\${describe(items)}: \${formatPrice(total)}\`
}
`,
)
await write(
  "src/format.ts",
  `export function formatPrice(cents: number) {
  return "$" + (cents / 100).toFixed(2)
}

export function formatPercent(value: number) {
  return value + "%"
}
`,
)
await write(
  "src/legacy.ts",
  `// Old pricing helpers, superseded by cart.ts.\nexport function oldTotal(prices: number[]) {\n  return prices.reduce((a, b) => a + b, 0)\n}\n`,
)
await git("add", ".")
await git("commit", "-qm", "chore: initial cart")

await git("checkout", "-qb", "reduce-subtotal")
await write(
  "src/cart.ts",
  (await Bun.file(join(dir, "src/cart.ts")).text()).replace(
    `  let total = 0
  for (const item of items) {
    total += item.price * item.quantity
  }
  return total`,
    `  return items.reduce((total, item) => total + item.price * item.quantity, 0)`,
  ),
)
await git("commit", "-qam", "refactor(cart): compute the subtotal with reduce\n\nSame result; one expression instead of a loop.")

await git("checkout", "-q", "main")
await git("checkout", "-qb", "clamp-discount")
await write(
  "src/cart.ts",
  (await Bun.file(join(dir, "src/cart.ts")).text()).replace(
    `  return total - total * (percent / 100)`,
    `  const clamped = Math.min(100, Math.max(0, percent))\n  return total - total * (clamped / 100)`,
  ),
)
await git("commit", "-qam", "fix(cart): clamp discounts to 0–100%")

await git("checkout", "-q", "main")
await git("checkout", "-qb", "drop-legacy")
await git("rm", "-q", "src/legacy.ts")
await git("commit", "-qm", "chore: remove legacy pricing helpers")
await git("checkout", "-q", "main")

await write(
  "docket.json",
  JSON.stringify(
    {
      title: "Cart cleanup",
      summary: "Three small changes to the cart module.",
      repo: { path: "." },
      groups: [
        {
          title: "Behavior",
          prs: [
            {
              ref: "main..clamp-discount",
              why: "A discount over 100% made totals negative; `applyDiscount` now clamps to 0–100.",
              confidence: "high",
            },
          ],
        },
        {
          title: "Cleanup",
          prs: [
            { ref: "main..reduce-subtotal", why: "Replaces the loop in `subtotal` with `reduce`; same result.", confidence: "high" },
            {
              ref: "main..drop-legacy",
              why: "`oldTotal` has no callers.",
              confidence: "medium",
              risk: "Assumes nothing outside this repo imports `src/legacy.ts`.",
            },
          ],
        },
      ],
    },
    null,
    2,
  ) + "\n",
)
console.log(`docket ${join(dir, "docket.json")}`)
