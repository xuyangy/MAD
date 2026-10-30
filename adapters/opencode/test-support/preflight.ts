/**
 * Scripted-spawn tests and the read policy's filter preflight
 * (`../git-read-policy.ts`).
 *
 * Under the default policy, every change read and every blame starts with one
 * `git config … --get-regexp` preflight. A test whose fake spawn scripts the
 * reads it is ABOUT would otherwise see that preflight as its first launch.
 * `answeringPreflight` answers it with "no filters configured" (status 1, no
 * output) and hands every other launch to the test's own spawn unchanged, so
 * the test's counts and argv assertions still describe only the reads it
 * scripts. Tests that are about the preflight itself use a spawn that sees it.
 */

import type { SpawnBlame, SpawnedBlame } from "../blame-exec.ts"
import { FILTER_PREFLIGHT, readOnlyGitArgv } from "../git-read-policy.ts"

const PREFLIGHT_ARGV = readOnlyGitArgv(FILTER_PREFLIGHT)

/** Whether an argv is exactly the read policy's filter preflight. */
export function isFilterPreflight(cmd: readonly string[]): boolean {
  return cmd.length === PREFLIGHT_ARGV.length && cmd.every((arg, i) => arg === PREFLIGHT_ARGV[i])
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() })
}

/** A child that has already exited with status 1 and printed nothing. */
function noFiltersConfigured(): SpawnedBlame {
  return {
    pid: 7001,
    stdout: closedStream(),
    stderr: closedStream(),
    exited: Promise.resolve(1),
    exitCode: 1,
    signalCode: null,
    kill: () => undefined,
  }
}

/** `spawn`, with the filter preflight answered "none configured". */
export function answeringPreflight(spawn: SpawnBlame): SpawnBlame {
  return (request) => {
    if (isFilterPreflight(request.cmd)) return noFiltersConfigured()
    return spawn(request)
  }
}
