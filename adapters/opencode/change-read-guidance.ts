/**
 * What a user can do about a change read that stopped (`ChangeReadStopped`).
 *
 * The error's own message already says which read stopped, how, after how many
 * reads, and the cleanup state; this adds only what to do about it. Everything
 * is decided from the error itself, never from the process-local quarantine map,
 * so the text describes the read the user just ran.
 */

import type { ChangeReadStopped } from "./repo.ts"

const LIKELY_CAUSES =
  `Likely causes: a hook or an fsmonitor that does not return, or a very large untracked tree (each ` +
  `untracked file is one more read under the same budget). A credential prompt is possible but less ` +
  `likely: \`git diff\` and \`git ls-files\` do not normally prompt, but a fetch they trigger can, e.g. ` +
  `in a partial clone. Check the repository with plain git in a terminal.`

const restart = (pid: number | undefined): string =>
  `${pid === undefined ? "Check for a leftover git process in this worktree" : `Check that process ${pid} has ended`}, ` +
  `then restart opencode.`

export function changeReadStopGuidance(error: ChangeReadStopped): string {
  switch (error.stop) {
    case "quarantined":
      return (
        `This worktree is QUARANTINED: MAD reads nothing in it until opencode restarts. ` +
        restart(error.quarantine?.pid)
      )
    case "launch-failed":
      return `git could not be started. Check that git is installed and on the PATH opencode runs with.`
    case "refused":
      return `MAD refused its own read limits, which is a fault in MAD rather than in this repository. Please report it.`
    case "signalled":
      return `Something outside MAD killed the git read, so its output was incomplete and was not used. Try again.`
    case "stderr-unread":
      return `MAD could not read git's diagnostics for this read, so its output was not used. Try again.`
    case "terminated":
    case "cleanup-unresolved":
    case "observation-failed":
    case "budget-exhausted":
    case "budget-passed": {
      const lines = [LIKELY_CAUSES]
      // THIS CALL LATCHED THE WORKTREE: its cleanup could not be confirmed.
      if (error.cleanup === "unresolved") {
        lines.push(`This worktree is now QUARANTINED: MAD reads nothing in it until opencode restarts. ${restart(error.pid)}`)
      } else {
        lines.push(`Then try again.`)
      }
      return lines.join("\n")
    }
  }
}
