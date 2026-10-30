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

/**
 * RECOVERY NAMES THE DESCENDANTS, NOT ONLY THE PID. An unresolved cleanup means
 * the direct child, a descendant, or a pipe one of them held was not accounted
 * for, and the direct child is often already gone while a helper it started
 * still holds the output. So a dead pid is not the condition to restart on.
 */
const restart = (pid: number | undefined): string =>
  pid === undefined
    ? `Before restarting opencode, look for any git process or helper still running in this worktree ` +
      `(for example with \`ps -A -o pid,ppid,command | grep git\`); MAD has no process id for this read. ` +
      `Then restart opencode.`
    : `Before restarting opencode, check that process ${pid} has ended AND look for any git process or ` +
      `helper it started that is still running in this worktree (for example with ` +
      `\`ps -A -o pid,ppid,command | grep git\`). Process ${pid} having ended does not mean its helpers ` +
      `have. Then restart opencode.`

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
    case "cancelled":
      if (error.cleanup !== "unresolved") {
        return `The review was stopped, so nothing was reviewed. Run it again when you want a review.`
      }
      // An observed exit or signal says git's own process ended; its cleanup
      // stays unconfirmed, so something it started may still be running.
      return (
        (error.status !== undefined || error.signal !== undefined
          ? `The review was stopped while git was running. Git's own process was seen to end, but MAD could ` +
            `not confirm its cleanup, so something it started may still be running.`
          : `The review was stopped while git was running, and MAD could not confirm that git ended.`) +
        ` This worktree is now QUARANTINED: MAD reads nothing in it until opencode restarts. ${restart(error.pid)}`
      )
    case "check-unanswered":
      return (
        `The file system did not answer MAD's check of an untracked file within the change read budget, so ` +
        `MAD stopped waiting. An operation already started may still complete; MAD attempts to close any ` +
        `file it opened, which this answer cannot confirm. Check that ` +
        `the worktree's file system is responsive, then try again.`
      )
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
