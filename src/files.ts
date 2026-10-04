import { mkdir, rename } from "node:fs/promises"
import { dirname } from "node:path"

/** Writes through a temporary file and a rename, so a crash or a concurrent reader never sees half a file. */
export async function writeAtomic(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, data)
  await rename(temporary, path)
}
