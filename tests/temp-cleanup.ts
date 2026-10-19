import { realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export async function removeTestDirectory(directory: string): Promise<void> {
  const root = await realpath(tmpdir())
  const target = await realpath(directory)
  const relative = path.relative(root, target)
  if (path.isAbsolute(relative) || relative.startsWith('..') || !/^devdock-[^\\/]+(?:[\\/]|$)/.test(relative)) {
    throw new Error(`Refusing cleanup outside an isolated DevDock test directory: ${target}`)
  }
  await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
