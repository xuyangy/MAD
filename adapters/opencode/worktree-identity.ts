/**
 * The identity both per-worktree quarantines are keyed by.
 *
 * `repo.ts` (change reads) and `plugin.ts` (`git blame`) each latch a worktree
 * whose read left a process unaccounted for. A latch keyed by the path as
 * written would miss another spelling of the same directory: a symlink, a
 * trailing separator, a relative path. So both key by this identity:
 *
 * - an existing directory: its `realpath`;
 * - a path that does not exist (`ENOENT`, `ENOTDIR`): `resolve(path)`, the
 *   lexical absolute form, so a missing worktree still has one key and the read
 *   it would start fails as it always did;
 * - any other failure (permissions, I/O): UNRESOLVED. A caller refuses rather
 *   than fall back, because a fallback would let a transient error move an
 *   existing quarantine's identity to an unlatched key.
 *
 * This is spelling normalisation only. It does not follow the directory if it
 * is replaced or retargeted later, and it claims no inode identity. The path
 * handed to git as its working directory, and `Repo.root()`, stay as given.
 */

import { realpathSync } from "node:fs"
import { resolve } from "node:path"

export type WorktreeIdentity = { readonly key: string } | { readonly unresolved: string }

/** The `realpath` this module calls. A test seam; the default is `node:fs`'s. */
export type RealpathOf = (path: string) => string

const MISSING = new Set(["ENOENT", "ENOTDIR"])

export function worktreeIdentity(worktree: string, realpath: RealpathOf = realpathSync): WorktreeIdentity {
  try {
    return { key: realpath(worktree) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== undefined && MISSING.has(code)) return { key: resolve(worktree) }
    const why = error instanceof Error ? error.message : String(error)
    return { unresolved: `MAD could not identify the worktree ${JSON.stringify(worktree)} (${code ?? "no error code"}): ${why}` }
  }
}

/** Thrown by the exported quarantine queries when the identity is unresolved: never read as "not quarantined". */
export class WorktreeIdentityUnresolved extends Error {
  constructor(readonly why: string) {
    super(why)
    this.name = "WorktreeIdentityUnresolved"
  }
}

/** The key, or a throw: for the exported query and test helpers, which must not answer under an unknown identity. */
export function worktreeKeyOrThrow(worktree: string, realpath?: RealpathOf): string {
  const identity = worktreeIdentity(worktree, realpath)
  if ("unresolved" in identity) throw new WorktreeIdentityUnresolved(identity.unresolved)
  return identity.key
}
