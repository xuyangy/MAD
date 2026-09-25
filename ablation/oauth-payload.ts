/**
 * Story 2-8c3b — the OAuth route's prepared payloads and its auth symlink.
 *
 * ## The prepared directory
 *
 * `bun run oauth-prepare --out <dir>` builds it from the inputs committed under
 * `ablation/oauth/`, and every managed-host start in OAuth mode verifies it here
 * before anything is spawned:
 *
 * - `anthropic-auth/`: `npm ci --ignore-scripts` of `@ex-machina/opencode-anthropic-auth`,
 *   loaded by the host through a `file://` plugin spec, so opencode's own plugin
 *   installer never runs;
 * - `config-seed/`: `npm ci --ignore-scripts` of `@opencode-ai/plugin`, copied into
 *   the host's config directory, so opencode's background dependency install finds
 *   nothing missing and fetches nothing;
 * - `models.json`: the recorded model catalogue, copied into the host's cache.
 *
 * ## The tree digest
 *
 * A lock hash says what should have been installed, not what is on disk, so each
 * tree is pinned by the sha256 of a canonical record of every entry under it, one
 * line per entry, sorted by the relative path's UTF-8 bytes:
 *
 *     <type>\t<relative path>\t<payload>\t<mode>\n
 *
 * `F` is a regular file (payload its sha256; mode `x` when any execute bit is set,
 * else `-`), `L` a symlink (payload its `readlink` target; mode `-`). Paths use `/`
 * and no leading `./`; directories are implied by paths and not listed. A path or
 * link target holding a tab or a newline, an absolute link target, a symlink that
 * resolves outside the tree or does not resolve at all, and any other file type
 * refuse the tree. Every link is relative and resolves inside the tree, so a
 * verified tree stays valid when it is copied.
 *
 * ## The auth symlink
 *
 * The OAuth host's data directory reaches the user's sign-ins only through
 * `<data-dir>/opencode/auth.json`, a symlink to `<HOME>/.local/share/opencode/auth.json`.
 * `authLinkProblem` checks it by `lstat` and `readlink` alone: nothing here opens,
 * reads, copies, hashes or logs either file.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

import { lstat, readdir, readlink, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"

/** One tree's pins: its lock's sha256 and its tree digest. */
export interface TreePin {
  /** The tree's directory under the prepared root. */
  dir: string
  lockSha256: string
  treeDigest: string
}

/** Every pin a prepared directory is verified against. */
export interface PayloadPins {
  anthropicAuth: TreePin
  configSeed: TreePin
  catalogue: { file: string; sha256: string }
}

/** The `file://` package directory of the Anthropic sign-in plugin inside a prepared directory. */
export function pluginPackageDir(prepared: string): string {
  return join(prepared, "anthropic-auth", "node_modules", "@ex-machina", "opencode-anthropic-auth")
}

export async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

function sha256Text(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

export type TreeDigest = { ok: true; digest: string; entries: number } | { ok: false; reason: string }

/** The canonical record of the tree at `root`, one line per entry, or why the tree is refused. */
export async function treeRecord(root: string): Promise<{ ok: true; lines: string[] } | { ok: false; reason: string }> {
  const top = await lstat(root).catch(() => undefined)
  if (top === undefined || top.isSymbolicLink() || !top.isDirectory()) {
    return { ok: false, reason: `\`${root}\` is ${top === undefined ? "missing" : top.isSymbolicLink() ? "a symlink" : "not a directory"}` }
  }
  const realRoot = await realpath(root)
  const entries: { key: Buffer; line: string }[] = []
  const problems: string[] = []
  const walk = async (relative: string): Promise<void> => {
    const names = await readdir(relative === "" ? root : join(root, relative))
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`
      if (/[\t\n]/.test(path)) {
        problems.push(`the path ${JSON.stringify(path)} holds a tab or a newline`)
        continue
      }
      const absolute = join(root, path)
      const info = await lstat(absolute)
      if (info.isDirectory()) await walk(path)
      else if (info.isFile()) {
        const line = `F\t${path}\t${await sha256Of(absolute)}\t${(info.mode & 0o111) !== 0 ? "x" : "-"}\n`
        entries.push({ key: Buffer.from(path, "utf8"), line })
      } else if (info.isSymbolicLink()) {
        const target = await readlink(absolute)
        if (/[\t\n]/.test(target)) {
          problems.push(`the symlink \`${path}\`'s target holds a tab or a newline`)
          continue
        }
        if (isAbsolute(target)) {
          problems.push(`the symlink \`${path}\` -> \`${target}\` has an absolute target; only a relative link inside the tree is allowed`)
          continue
        }
        let resolved: string
        try {
          resolved = await realpath(absolute)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          problems.push(`the symlink \`${path}\` -> \`${target}\` does not resolve (${code === "ELOOP" ? "a cycle" : code === "ENOENT" ? "dangling" : code ?? "unresolvable"})`)
          continue
        }
        if (!inside(resolved, realRoot)) {
          problems.push(`the symlink \`${path}\` -> \`${target}\` resolves outside the tree, to \`${resolved}\``)
          continue
        }
        entries.push({ key: Buffer.from(path, "utf8"), line: `L\t${path}\t${target}\t-\n` })
      } else {
        const type = info.isFIFO() ? "a FIFO" : info.isSocket() ? "a socket" : "a device"
        problems.push(`\`${path}\` is ${type}; only regular files, directories and symlinks inside the tree are allowed`)
      }
    }
  }
  await walk("")
  if (problems.length > 0) return { ok: false, reason: `the tree \`${root}\` is refused: ${problems.join("; ")}` }
  entries.sort((a, b) => Buffer.compare(a.key, b.key))
  return { ok: true, lines: entries.map((entry) => entry.line) }
}

/** The digest of a canonical record's lines. */
export function recordDigest(lines: readonly string[]): string {
  return sha256Text(lines.join(""))
}

/** The tree digest of `root`: the sha256 of its canonical record. Never rejects. */
export async function treeDigest(root: string): Promise<TreeDigest> {
  try {
    const record = await treeRecord(root)
    if (!record.ok) return record
    return { ok: true, digest: sha256Text(record.lines.join("")), entries: record.lines.length }
  } catch (error) {
    return { ok: false, reason: `the tree \`${root}\` could not be read: ${messageOf(error)}` }
  }
}

/** What a prepared directory measured as. */
export interface PreparedMeasure {
  anthropicAuth: { lockSha256: string | null; treeDigest: string | null; entries: number | null }
  configSeed: { lockSha256: string | null; treeDigest: string | null; entries: number | null }
  catalogueSha256: string | null
}

export type PreparedVerification =
  | { ok: true; measured: PreparedMeasure }
  | { ok: false; problems: string[]; measured: PreparedMeasure }

/**
 * Every way the prepared directory differs from the pins, each named. Both trees'
 * locks and digests and the catalogue's sha256 are measured from disk; a matching
 * lock over changed installed files fails on the digest. Never rejects.
 */
export async function verifyPrepared(prepared: string, pins: PayloadPins): Promise<PreparedVerification> {
  const problems: string[] = []
  const tree = async (name: string, pin: TreePin) => {
    const dir = join(prepared, pin.dir)
    const lock = await sha256Of(join(dir, "package-lock.json")).catch((error: unknown) => {
      problems.push(`${name}: \`${join(dir, "package-lock.json")}\` could not be hashed: ${messageOf(error)}`)
      return null
    })
    if (lock !== null && lock !== pin.lockSha256) problems.push(`${name}: the lock's sha256 is ${lock}; the pinned lock's is ${pin.lockSha256}`)
    const digest = await treeDigest(dir)
    if (!digest.ok) problems.push(`${name}: ${digest.reason}`)
    else if (digest.digest !== pin.treeDigest) {
      problems.push(`${name}: the tree digest of \`${dir}\` is ${digest.digest}; the pinned digest is ${pin.treeDigest}`)
    }
    return { lockSha256: lock, treeDigest: digest.ok ? digest.digest : null, entries: digest.ok ? digest.entries : null }
  }
  const anthropicAuth = await tree("the Anthropic sign-in plugin", pins.anthropicAuth)
  const configSeed = await tree("the config-directory seed", pins.configSeed)
  const catalogueFile = join(prepared, pins.catalogue.file)
  const catalogueSha256 = await catalogueSha(catalogueFile, problems)
  if (catalogueSha256 !== null && catalogueSha256 !== pins.catalogue.sha256) {
    problems.push(`the model catalogue \`${catalogueFile}\` has sha256 ${catalogueSha256}; the pinned catalogue's is ${pins.catalogue.sha256}`)
  }
  const measured = { anthropicAuth, configSeed, catalogueSha256 }
  return problems.length === 0 ? { ok: true, measured } : { ok: false, problems, measured }
}

async function catalogueSha(file: string, problems: string[]): Promise<string | null> {
  const info = await lstat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    problems.push(`the model catalogue \`${file}\` is ${info === undefined ? "missing" : "not a regular file"}`)
    return null
  }
  return sha256Of(file).catch((error: unknown) => {
    problems.push(`the model catalogue \`${file}\` could not be hashed: ${messageOf(error)}`)
    return null
  })
}

/** Where the OAuth host's data directory links to the user's sign-ins, and where that link must point. */
export function authLinkPaths(dataDir: string, home: string): { link: string; target: string } {
  return { link: join(dataDir, "opencode", "auth.json"), target: join(home, ".local", "share", "opencode", "auth.json") }
}

/**
 * Why `<data-dir>/opencode/auth.json` is not a symlink whose `readlink` is exactly
 * `<home>/.local/share/opencode/auth.json`, or `null`. By `lstat` and `readlink`
 * only: neither the link's target nor anything behind it is opened. The reason
 * names paths, never contents.
 */
export async function authLinkProblem(dataDir: string, home: string): Promise<string | null> {
  const { link, target } = authLinkPaths(dataDir, home)
  let info
  try {
    info = await lstat(link)
  } catch (error) {
    return `\`${link}\` could not be examined (${(error as NodeJS.ErrnoException).code ?? messageOf(error)}); it must be a symlink to \`${target}\``
  }
  if (!info.isSymbolicLink()) {
    return `\`${link}\` is ${info.isFile() ? "a regular file" : info.isDirectory() ? "a directory" : "not a symlink"}; it must be a symlink to \`${target}\``
  }
  const actual = await readlink(link).catch((error: unknown) => ({ failed: messageOf(error) }))
  if (typeof actual !== "string") return `\`${link}\`'s target could not be read (${actual.failed}); it must be \`${target}\``
  if (actual !== target) return `\`${link}\` points to \`${actual}\`; it must point to \`${target}\` exactly`
  return null
}

/**
 * Why `<data-dir>/opencode` is not the shape the OAuth route relies on, one reason
 * each: a real directory (by `lstat`, not a symlink) whose only symlink is
 * `auth.json`, and that link as `authLinkProblem` requires. Nothing is opened but
 * the directory listing. Never rejects.
 */
export async function dataDirProblems(dataDir: string, home: string): Promise<string[]> {
  const dir = join(dataDir, "opencode")
  const info = await lstat(dir).catch(() => undefined)
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    return [`\`${dir}\` is ${info === undefined ? "missing" : info.isSymbolicLink() ? "a symlink" : "not a directory"}; it must be a real directory holding the auth symlink`]
  }
  const problems: string[] = []
  try {
    for (const name of (await readdir(dir)).sort()) {
      if (name === "auth.json") continue
      if ((await lstat(join(dir, name))).isSymbolicLink()) problems.push(`\`${join(dir, name)}\` is a symlink; \`auth.json\` is the only symlink allowed in \`${dir}\``)
    }
  } catch (error) {
    problems.push(`\`${dir}\` could not be listed: ${messageOf(error)}`)
  }
  const link = await authLinkProblem(dataDir, home)
  if (link !== null) problems.push(link)
  return problems
}

/**
 * `path` with every symlink and `..` resolved. A path that does not exist yet
 * resolves through its nearest existing ancestor, so a directory the caller will
 * create is compared where it will be.
 */
export async function resolvedPath(path: string): Promise<string> {
  const absolute = resolve(path)
  const rest: string[] = []
  let at = absolute
  for (;;) {
    try {
      return join(await realpath(at), ...rest.reverse())
    } catch (error) {
      const parent = resolve(at, "..")
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === at) throw error
      rest.push(at.slice(parent.length).replace(/^\//, ""))
      at = parent
    }
  }
}

/**
 * Why `a` and `b` are not disjoint, or `null`: each is resolved to its real path
 * (every symlink and `..` followed; a path not created yet through its nearest
 * existing ancestor), and neither may equal or contain the other. A path that
 * cannot be resolved is not disjoint. Never rejects.
 */
export async function overlapProblem(a: { name: string; path: string }, b: { name: string; path: string }): Promise<string | null> {
  const real = async (path: string) => resolvedPath(path).catch((error: unknown) => ({ failed: messageOf(error) }))
  const [ra, rb] = await Promise.all([real(a.path), real(b.path)])
  if (typeof ra !== "string") return `the ${a.name} \`${a.path}\` could not be resolved (${ra.failed})`
  if (typeof rb !== "string") return `the ${b.name} \`${b.path}\` could not be resolved (${rb.failed})`
  if (ra === rb) return `the ${a.name} \`${a.path}\` is the ${b.name} (\`${ra}\`)`
  if (inside(ra, rb)) return `the ${a.name} \`${a.path}\` resolves to \`${ra}\`, inside the ${b.name} \`${rb}\``
  if (inside(rb, ra)) return `the ${a.name} \`${a.path}\` resolves to \`${ra}\`, which contains the ${b.name} \`${rb}\``
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
