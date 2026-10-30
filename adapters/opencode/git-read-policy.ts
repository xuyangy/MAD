/**
 * The one invocation policy for the ordinary review's own git reads: the change
 * read in `./repo.ts` and the `git blame` evidence read in `./tools.ts`
 * (spec-mad-v1-readiness CAP-2).
 *
 * A review is read-only, so nothing a git read starts may be a program the
 * user's environment, config or repository chose. Git has several such
 * programs, and each knob below names the one it closes. What it cannot close
 * with a flag, executable filters, it refuses.
 *
 * WHAT STAYS AUTHORITATIVE. The worktree MAD was given, and the ordinary
 * config files (system, global, repository, worktree, and their includes).
 * They still supply `safe.directory`, `core.excludesFile`, `core.quotePath` and
 * the rest, and the `-c` overrides below win over them. Environment-based
 * repository and config overrides (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL` and every other `GIT_*`
 * variable) are unsupported and are removed before git starts.
 *
 * SUBMODULES. A submodule is reviewed as its commit pointer only: a pointer
 * change shows as the old and new commit, and a submodule's own uncommitted
 * content is neither inspected nor reviewed. Inspecting it would run git
 * inside the submodule under that submodule's config, which the filter
 * preflight never read.
 *
 * WHAT THIS IS NOT. A sandbox. It closes the helpers named here on these two
 * paths. The preflight reads config once, before the reads it guards, so a
 * config edited between the two is not seen. Credential, askpass and SSH
 * helpers are reached on these paths only through a transport, and the empty
 * protocol allowlist below refuses every transport; nothing here disables them
 * elsewhere. The ablation harness and the launcher scripts keep their own git
 * environment.
 */

/**
 * Which git behaviour a factory uses. `"read-only"`, the default, is this
 * module's policy. `"inherit"` is the evaluation harness's compatibility
 * setting: the argv, the inherited environment and the absence of a filter
 * preflight stay exactly as they were before this policy existed, so the
 * harness keeps its historical git behaviour. The `-`-target refusal applies
 * under both. Set only at the harness construction sites
 * (`ablation/live.ts`, `ablation/adversarial.ts`, `scripts/paired.ts`), so
 * the harness does not measure this hardening.
 */
export type GitReadPolicy = "read-only" | "inherit"

/**
 * Whether a factory's reads use this policy. An omitted policy is
 * `"read-only"`; any value that is not one of the two is refused, so a typo
 * cannot fall back to inherited behaviour.
 */
export function usesReadOnlyPolicy(policy: GitReadPolicy | undefined): boolean {
  if (policy === undefined || policy === "read-only") return true
  if (policy === "inherit") return false
  throw new Error(`gitReadPolicy must be "read-only" or "inherit", not ${JSON.stringify(policy)}`)
}

/** Put before every subcommand. */
const GLOBAL_ARGS: readonly string[] = [
  // A pager is a configured program (`core.pager`, `GIT_PAGER`, `PAGER`). Git
  // starts one only when stdout is a terminal, and the launcher's stdout is a
  // pipe, so this is belt and braces rather than the only guard.
  "--no-pager",
  // `core.fsmonitor` names a hook git runs while it refreshes the index, which
  // `git diff HEAD` does over the worktree.
  "-c", "core.fsmonitor=false",
  // A forced `color.ui=always` would put escape codes into the diff MAD reads
  // and hands to models. `blame` has no `--no-color`, so it is set here.
  "-c", "color.ui=false",
]

/** Added to every `diff` subcommand. */
const DIFF_ARGS: readonly string[] = [
  // `diff.external`, `GIT_EXTERNAL_DIFF` and a `.gitattributes` `diff=<driver>`
  // with `diff.<driver>.command` each run a program instead of git's own diff.
  "--no-ext-diff",
  // `diff.<driver>.textconv` runs a program over each side before diffing.
  "--no-textconv",
  // `color.diff=always` wins over `color.ui=false`.
  "--no-color",
  // A dirty submodule is inspected by running git inside it.
  "--ignore-submodules=dirty",
  // `diff.submodule=diff` or `log` would run git inside the submodule to render
  // a pointer change; `short` renders it as the two commit ids.
  "--submodule=short",
]

/**
 * Added to every `blame` subcommand. `--porcelain` output carries no colour
 * whatever `color.*` and `blame.coloring` say, so blame needs no colour flag.
 */
const BLAME_ARGS: readonly string[] = [
  // Blame honours textconv by default.
  "--no-textconv",
]

/**
 * The full argv for one read: `git`, the global overrides, then the
 * subcommand with its own overrides directly after its name.
 */
export function readOnlyGitArgv(subcommand: readonly string[]): string[] {
  const [name, ...rest] = subcommand
  if (name === undefined) throw new Error("readOnlyGitArgv: no subcommand")
  const own = name === "diff" ? DIFF_ARGS : name === "blame" ? BLAME_ARGS : []
  return ["git", ...GLOBAL_ARGS, name, ...own, ...rest]
}

/** What the policy sets, after every inherited `GIT_*` variable is gone. */
const POLICY_ENV: Readonly<Record<string, string>> = {
  // A credential or passphrase prompt would wait for a terminal MAD lacks.
  GIT_TERMINAL_PROMPT: "0",
  // A read takes no optional lock, so it does not rewrite the index's stat cache.
  GIT_OPTIONAL_LOCKS: "0",
  // A partial clone fetches a missing object from its promisor remote on
  // demand, through a transport, a remote helper or a credential helper.
  // Honoured from git 2.44.
  GIT_NO_LAZY_FETCH: "1",
  // An empty allowlist permits no transport at all, so that fetch fails before
  // any helper runs, on git older than 2.44 too (honoured from git 2.12). Local
  // reads need no transport.
  GIT_ALLOW_PROTOCOL: "",
}

/**
 * The child's environment: the parent's, minus every `GIT_*` variable and
 * `PAGER`, plus the policy's own values. `PWD` is set by the launcher.
 */
export function readOnlyGitEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || key.startsWith("GIT_") || key === "PAGER") continue
    env[key] = value
  }
  return { ...env, ...POLICY_ENV }
}

/**
 * The filter preflight's subcommand. A `.gitattributes` `filter=<driver>` with
 * `filter.<driver>.clean`, `.smudge` or `.process` runs that program when git
 * reads worktree content, and no flag turns filters off. So a repository whose
 * effective config defines any of them is refused before any content read,
 * whether or not an attribute uses it. That includes a driver defined only in
 * the global config, such as the one `git lfs install` writes: telling whether
 * an attribute could reach a driver would need the attribute lookup git does
 * during content conversion, and this policy does not reimplement it. `--includes` follows `include.*` as git
 * itself does, and `--null` makes the output unambiguous.
 */
export const FILTER_PREFLIGHT: readonly string[] = [
  "config",
  "--null",
  "--includes",
  "--get-regexp",
  "^filter\\..*\\.(clean|smudge|process)$",
]

/**
 * The preflight's answer. `git config --get-regexp` exits 1 when no key
 * matches and 0 when one does; any other outcome is the caller's error, never
 * "none". With `--null` each match is `<key>\n<value>\0`.
 */
export function configuredFilters(exitCode: number, stdout: string): { kind: "none" } | { kind: "configured"; drivers: string[] } | { kind: "unknown" } {
  if (exitCode === 1) return { kind: "none" }
  if (exitCode !== 0) return { kind: "unknown" }
  const drivers = new Set<string>()
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue
    const key = record.split("\n", 1)[0]!
    const match = /^filter\.(.*)\.(clean|smudge|process)$/s.exec(key)
    if (match === null) return { kind: "unknown" }
    drivers.add(match[1]!)
  }
  if (drivers.size === 0) return { kind: "unknown" }
  return { kind: "configured", drivers: [...drivers].sort() }
}

/** Why the read refuses this repository. Shared by both paths. */
export function filterRefusalReason(drivers: readonly string[]): string {
  return (
    `the effective git config here (system, global or repository) defines executable filter driver(s) ` +
    `${drivers.map((d) => `\`${d}\``).join(", ")} (clean, smudge or process commands). Git could run ` +
    `them while reading worktree content, and a read-only review does not support configured filters, ` +
    `so nothing was read`
  )
}

/**
 * A target git would parse as an option. Refused untrimmed: `" -x"` is not
 * option-shaped to git, and trimming would review a different string than the
 * one given.
 */
export function unsupportedTargetReason(target: string | undefined): string | undefined {
  if (target === undefined || !target.startsWith("-")) return undefined
  return (
    `the target ${JSON.stringify(target)} starts with "-", so git would read it as an option rather than ` +
    `a revision. MAD reviews a ref, a commit or a range such as \`main...HEAD\`; omit the target to review ` +
    `the working tree`
  )
}
