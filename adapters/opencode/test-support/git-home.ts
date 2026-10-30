/**
 * A controlled global git config for tests whose reads go through the read
 * policy (`../git-read-policy.ts`).
 *
 * The policy keeps the caller's ordinary config files and removes every
 * `GIT_*` variable, so a test's own `GIT_CONFIG_GLOBAL` cannot reach MAD's
 * reads. They read `$HOME/.gitconfig` and `$XDG_CONFIG_HOME/git/config`
 * instead. A developer whose global config defines a filter (as
 * `git lfs install` does) would see every ordinary read refused. Called at the
 * top level of a test file, `isolateGitHome` points `HOME` and
 * `XDG_CONFIG_HOME` at an empty directory for that file's tests and restores
 * them afterwards. A test about inherited global config sets its own `HOME`
 * inside that span.
 *
 * The system config file is not covered: the policy also removes
 * `GIT_CONFIG_NOSYSTEM`, and git's system path is fixed when git is built.
 */

import { afterAll, beforeAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function isolateGitHome(): void {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  let home: string | undefined
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "mad-test-home-"))
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")
  })
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (home !== undefined) await rm(home, { recursive: true, force: true })
  })
}
