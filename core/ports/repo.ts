/**
 * The `Repo` port — the change under review, and the root everything is
 * relative to. Interfaces only (AD-1).
 *
 * MAD never writes to the user's repo (AD-16), so this port is read-only by
 * construction.
 */

export interface ChangeSet {
  /** How the change was selected, e.g. a ref range or "working tree". */
  description: string
  /** Repo-relative POSIX paths touched by the change. */
  files: string[]
  /** Unified diff text, passed to models as the material under review. */
  diff: string
}

export interface Repo {
  /** Absolute path to the worktree root; loci are relative to it. */
  root(): string
  /** The change under review. `target` is host syntax, e.g. a git ref range. */
  change(target?: string): Promise<ChangeSet>
}
