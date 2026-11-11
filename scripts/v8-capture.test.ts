/**
 * `scripts/v8-capture.ts` against synthetic logs in a temporary folder: the
 * baseline and the capture keep only what the capture method allows, refuse a
 * log that was replaced, truncated or changed before B, and report an
 * unavailable capture instead of rows it cannot stand behind. Nothing here
 * reads a real opencode log, starts a host or calls a provider.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { REVIEW_SESSION_PERMISSION } from "../adapters/opencode/session-policy.ts"
import { parseRange, runV8Capture, splitLogfmt, type CaptureIo, type LogHandle } from "./v8-capture.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const EXPECTED = JSON.stringify(REVIEW_SESSION_PERMISSION)

/** One `created` line as the 1.19.5 formatter writes it: quoted values are JSON strings. */
function created(fields: { id: string; title: string; permission?: string; directory?: string; run?: string; extra?: string }): string {
  const q = (value: string) => JSON.stringify(value)
  const parts = [
    "timestamp=2026-11-11T16:30:00.000Z",
    "level=INFO",
    `run=${fields.run ?? "abc12345"}`,
    "message=created",
    `id=${fields.id}`,
    `directory=${fields.directory ?? "/repo"}`,
    `title=${q(fields.title)}`,
    `permission=${q(fields.permission ?? EXPECTED)}`,
  ]
  if (fields.extra) parts.push(fields.extra)
  return parts.join(" ") + "\n"
}

const OTHER = 'timestamp=2026-11-11T16:30:00.000Z level=INFO run=abc12345 message=created id=ses_other title="a private conversation" secret="do not copy"\n'

async function fixture(initial: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "mad-v8-capture-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const log = join(dir, "opencode.log")
  if (initial !== null) await writeFile(log, initial)
  const lines: string[] = []
  const errors: string[] = []
  let tick = 0
  const io: CaptureIo = { out: (l) => lines.push(l), err: (l) => errors.push(l), now: () => new Date(Date.UTC(2026, 10, 11, 16, 0, tick++)) }
  const run = (...argv: string[]) => runV8Capture(argv, io)
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"))
  return { dir, log, io, lines, errors, run, json }
}

/** A baseline, then `between`, then a capture: the exit code and the capture record. */
async function captureAround(initial: string | null, between: (log: string) => Promise<void>, io?: Partial<CaptureIo>) {
  const f = await fixture(initial)
  Object.assign(f.io, io)
  const baseline = join(f.dir, "baseline.json")
  const out = join(f.dir, "capture.json")
  expect(await f.run("baseline", "--log", f.log, "--out", baseline)).toBe(0)
  await between(f.log)
  const code = await f.run("after", "--log", f.log, "--baseline", baseline, "--out", out)
  return { code, record: await f.json(out), f, out }
}

describe("splitLogfmt", () => {
  test("decodes quoted values as JSON strings and closes them at a quote after an even number of backslashes", () => {
    expect(splitLogfmt('a=1 b="x y" c="q\\"r" d="e\\\\"')).toEqual([
      ["a", "1"],
      ["b", "x y"],
      ["c", 'q"r'],
      ["d", "e\\"],
    ])
  })

  test("refuses a field without '=', an unclosed quote, an invalid escape and junk after a quoted value", () => {
    for (const bad of ["a=1 b", 'a="x', 'a="\\q"', 'a="x"y', 'a=x"y', 'a="e\\\\\\"']) expect(splitLogfmt(bad)).toBeNull()
  })

  test("refuses raw tab, carriage return and control characters in an unquoted value or between fields", () => {
    for (const bad of ["a=x\tb", "a=x\rb", "a=x\u0001", "a=1\tb=2"]) expect(splitLogfmt(bad)).toBeNull()
  })

  test("keeps multibyte text, a literal U+FFFD and escaped whitespace inside a quoted value", () => {
    expect(splitLogfmt('a="caf\u00e9 \\t\\n" b=日本 c="\uFFFD"')).toEqual([
      ["a", "café \t\n"],
      ["b", "日本"],
      ["c", "\uFFFD"],
    ])
  })
})

describe("parseRange", () => {
  test("keeps the six fields of MAD created lines only, and compares the rules exactly", () => {
    const text =
      OTHER +
      created({ id: "ses_a", title: "MAD discovery-1" }) +
      created({ id: "ses_b", title: "MAD session policy probe", permission: JSON.stringify([...REVIEW_SESSION_PERMISSION].reverse()) }) +
      created({ id: "ses_c", title: "MAD discovery-2", permission: '{"not":"an array"}' })
    const parsed = parseRange(text)
    expect(parsed.completeLines).toBe(4)
    expect(parsed.rows.map((row) => [row.id, row.comparison])).toEqual([
      ["ses_a", "expected"],
      ["ses_b", "different"],
      ["ses_c", "different"],
    ])
    expect(Object.keys(parsed.rows[0]!).sort()).toEqual(["comparison", "directory", "id", "permission", "run", "timestamp", "title"])
    expect(JSON.stringify(parsed)).not.toContain("private conversation")
    expect(JSON.stringify(parsed)).not.toContain("do not copy")
  })

  test("an extra key in a rule is different", () => {
    const extra = JSON.stringify(REVIEW_SESSION_PERMISSION.map((rule) => ({ ...rule, note: "x" })))
    expect(parseRange(created({ id: "ses_a", title: "MAD x", permission: extra })).rows[0]!.comparison).toBe("different")
  })

  test("invalid permission JSON, a repeated title and a missing required field are unreadable, keeping only a single id", () => {
    const text =
      created({ id: "ses_a", title: "MAD a", permission: "[{" }) +
      created({ id: "ses_b", title: "MAD b", extra: 'title="MAD c"' }) +
      'timestamp=t level=INFO message=created id=ses_c title="MAD d" directory=/repo permission="[]"\n'
    const parsed = parseRange(text)
    expect(parsed.rows).toEqual([])
    expect(parsed.unreadable).toEqual([
      { id: "ses_a", comparison: "unreadable" },
      { id: "ses_b", comparison: "unreadable" },
      { id: "ses_c", comparison: "unreadable" },
    ])
  })

  test("a title that merely contains 'MAD ' inside another field does not qualify", () => {
    const text = 'timestamp=t run=r message=created id=x title="plain" directory=/repo permission="[]" note="title=MAD x"\n'
    expect(parseRange(text).rows).toEqual([])
    expect(parseRange(text).unreadable).toEqual([])
  })

  test("an unsplittable line is counted and dropped, and a trailing line without a newline is incomplete", () => {
    const parsed = parseRange('broken "line\n' + created({ id: "ses_a", title: "MAD a" }).trimEnd())
    expect(parsed.unparsed).toBe(1)
    expect(parsed.incomplete).toBe(1)
    expect(parsed.rows).toEqual([])
  })
})

describe("v8-capture baseline and after", () => {
  test("captures exactly the appended range and writes only the allowed fields", async () => {
    const before = created({ id: "ses_old", title: "MAD discovery-1" })
    const { code, record } = await captureAround(before, (log) => appendFile(log, OTHER + created({ id: "ses_new", title: "MAD discovery-1" })))
    expect(code).toBe(0)
    expect(record.status).toBe("available")
    expect(record.B).toBe(Buffer.byteLength(before))
    expect(record.rows.map((row: { id: string }) => row.id)).toEqual(["ses_new"])
    expect(record.counts).toEqual({ completeLines: 2, incomplete: 0, unparsed: 0, unreadable: 0, madCreatedRows: 1 })
    expect(record.coverageLimited).toBe(false)
    expect(record.checks.bytesRead).toBe(record.checks.expectedBytes)
    expect(record.observedRunTokens).toEqual(["abc12345"])
    const text = JSON.stringify(record)
    expect(text).not.toContain("private conversation")
    expect(text).not.toContain("ses_other")
  })

  test("an empty range is a usable capture with no rows", async () => {
    const { code, record } = await captureAround(created({ id: "ses_a", title: "MAD a" }), async () => {})
    expect(code).toBe(0)
    expect(record.E).toBe(record.B)
    expect(record.rows).toEqual([])
  })

  test("an absent log is a valid baseline with B = 0, and a log created afterwards is captured from its start", async () => {
    const { code, record } = await captureAround(null, (log) => writeFile(log, created({ id: "ses_a", title: "MAD a" })))
    expect(code).toBe(0)
    expect(record.B).toBe(0)
    expect(record.rows.length).toBe(1)
  })

  test("a log still absent afterwards is unavailable", async () => {
    const { code, record } = await captureAround(null, async () => {})
    expect(code).toBe(1)
    expect(record.status).toBe("unavailable")
    expect(record.rows).toBeUndefined()
  })

  test("a log replaced by another file is unavailable", async () => {
    const { code, record } = await captureAround(created({ id: "ses_a", title: "MAD a" }), async (log) => {
      const other = `${log}.new`
      await writeFile(other, created({ id: "ses_a", title: "MAD a" }) + created({ id: "ses_b", title: "MAD b" }))
      await rename(other, log)
    })
    expect(code).toBe(1)
    expect(record.reason).toBe("the log is not the file the baseline recorded")
  })

  test("a log truncated below B is unavailable", async () => {
    const { code, record } = await captureAround(created({ id: "ses_a", title: "MAD a" }), (log) => truncate(log, 5))
    expect(code).toBe(1)
    expect(record.reason).toBe("the log is shorter than the baseline's B")
  })

  test("a change before B without a new inode is unavailable", async () => {
    const { code, record } = await captureAround(created({ id: "ses_a", title: "MAD a" }), async (log) => {
      const handle = await open(log, "r+")
      await handle.write("X", 0)
      await handle.close()
      await appendFile(log, created({ id: "ses_b", title: "MAD b" }))
    })
    expect(code).toBe(1)
    expect(record.reason).toBe("the first B bytes no longer match the baseline")
  })

  test("a replacement during the capture is unavailable", async () => {
    let logPath = ""
    const { code, record } = await captureAround(
      created({ id: "ses_a", title: "MAD a" }),
      async (log) => {
        logPath = log
        await appendFile(log, created({ id: "ses_b", title: "MAD b" }))
      },
      {
        afterRangeRead: async () => {
          await writeFile(`${logPath}.new`, "x\n".repeat(200))
          await rename(`${logPath}.new`, logPath)
        },
      },
    )
    expect(code).toBe(1)
    expect(record.reason).toBe("the log was replaced during the capture")
  })

  test("a shrink during the capture is unavailable", async () => {
    let logPath = ""
    const { code, record } = await captureAround(
      created({ id: "ses_a", title: "MAD a" }),
      async (log) => {
        logPath = log
        await appendFile(log, created({ id: "ses_b", title: "MAD b" }))
      },
      { afterRangeRead: () => truncate(logPath, Buffer.byteLength(created({ id: "ses_a", title: "MAD a" })) + 3) },
    )
    expect(code).toBe(1)
    expect(record.reason).toBe("the log became shorter than E during the capture")
  })

  test("a range over the limit is unavailable", async () => {
    const { code, record } = await captureAround("", (log) => appendFile(log, created({ id: "ses_a", title: "MAD a" })), { rangeLimitBytes: 10 })
    expect(code).toBe(1)
    expect(record.reason).toBe("the range from B to E is larger than the 10-byte limit")
  })

  test("a baseline taken mid-line is unavailable and no capture can rest on it", async () => {
    const f = await fixture("no newline at the end")
    const baseline = join(f.dir, "baseline.json")
    expect(await f.run("baseline", "--log", f.log, "--out", baseline)).toBe(1)
    expect((await f.json(baseline)).status).toBe("unavailable")
    expect(await f.run("after", "--log", f.log, "--baseline", baseline, "--out", join(f.dir, "capture.json"))).toBe(2)
    expect(f.errors.join("\n")).toContain("the baseline's status is not available")
  })

  test("an unreadable log is unavailable at baseline, not absent", async () => {
    const f = await fixture(null)
    await writeFile(f.log, "x\n", { mode: 0o000 })
    const baseline = join(f.dir, "baseline.json")
    expect(await f.run("baseline", "--log", f.log, "--out", baseline)).toBe(1)
    const record = await f.json(baseline)
    expect(record.absent).toBe(false)
    expect(record.reason).toBe("the log could not be opened for reading")
  })

  test("invalid baselines are refused with exit 2", async () => {
    const f = await fixture("x\n")
    const baseline = join(f.dir, "baseline.json")
    expect(await f.run("baseline", "--log", f.log, "--out", baseline)).toBe(0)
    const good = await f.json(baseline)
    const bad = [
      { ...good, B: -1 },
      { ...good, B: 2 ** 60 },
      { ...good, kind: "something-else" },
      { ...good, log: "/elsewhere/opencode.log" },
      { ...good, prefixSha256: "nope" },
      { ...good, absent: true },
    ]
    for (const [k, value] of bad.entries()) {
      const path = join(f.dir, `bad-${k}.json`)
      await writeFile(path, JSON.stringify(value))
      expect(await f.run("after", "--log", f.log, "--baseline", path, "--out", join(f.dir, `out-${k}.json`))).toBe(2)
    }
  })

  test("an existing output, an output equal to an input and relative paths are refused, and nothing is overwritten", async () => {
    const f = await fixture("x\n")
    const existing = join(f.dir, "existing.json")
    await writeFile(existing, "keep")
    expect(await f.run("baseline", "--log", f.log, "--out", existing)).toBe(2)
    expect(await readFile(existing, "utf8")).toBe("keep")
    expect(await f.run("baseline", "--log", f.log, "--out", f.log)).toBe(2)
    expect(await readFile(f.log, "utf8")).toBe("x\n")
    expect(await f.run("baseline", "--log", "opencode.log", "--out", join(f.dir, "b.json"))).toBe(2)
    expect(await f.run("unknown")).toBe(2)
  })
})

describe("v8-capture failures and evidence", () => {
  test("a complete line that is not valid UTF-8 is unparsed and nothing of it is kept; a partial multibyte tail is incomplete", () => {
    const good = Buffer.from(created({ id: "ses_a", title: "MAD a" }))
    const bad = Buffer.concat([Buffer.from('timestamp=t run=r message=created id=ses_bad title="MAD '), Buffer.from([0xff, 0xfe]), Buffer.from('" directory=/repo permission="[]"\n')])
    const tail = Buffer.from([0xe6, 0x97])
    const parsed = parseRange(Buffer.concat([good, bad, tail]))
    expect(parsed.rows.map((row) => row.id)).toEqual(["ses_a"])
    expect(parsed.unparsed).toBe(1)
    expect(parsed.incomplete).toBe(1)
    expect(JSON.stringify(parsed)).not.toContain("ses_bad")
  })

  test("the records keep the observed identities, sizes and times behind continuity", async () => {
    const { code, record, f } = await captureAround(created({ id: "ses_a", title: "MAD a" }), (log) => appendFile(log, created({ id: "ses_b", title: "MAD b" })))
    expect(code).toBe(0)
    const baseline = await f.json(join(f.dir, "baseline.json"))
    for (const key of ["pathBefore", "handleBefore", "handleAfter", "pathAfter"]) {
      expect(Object.keys(baseline.checks[key]).sort()).toEqual(["at", "device", "inode", "size"])
      expect(Object.keys(record.checks[key]).sort()).toEqual(["at", "device", "inode", "size"])
      expect(record.checks[key].device).toBe(baseline.device)
      expect(record.checks[key].inode).toBe(baseline.inode)
    }
    expect(baseline.checks.handleBefore.size).toBe(baseline.B)
    expect(record.checks.handleBefore.size).toBe(record.E)
    expect(record.checks.pathAfter.size).toBeGreaterThanOrEqual(record.E)
    expect(record.checks.recomputedPrefixSha256).toBe(baseline.prefixSha256)
    expect(record.checks.bytesRead).toBe(record.E - record.B)
  })

  /** A handle that fails one operation with a file-system error, as a disk or permission failure would. */
  function failingOpen(fail: { readCall?: number; statCall?: number }) {
    return async (path: string): Promise<LogHandle> => {
      const real = await open(path, "r")
      let reads = 0
      let stats = 0
      const ioError = () => Object.assign(new Error("simulated"), { code: "EIO" })
      return {
        stat: async () => {
          stats++
          if (stats === fail.statCall) throw ioError()
          return real.stat()
        },
        read: async (buffer, offset, length, position) => {
          reads++
          if (reads === fail.readCall) throw ioError()
          return real.read(buffer, offset, length, position)
        },
        close: () => real.close(),
      }
    }
  }

  test("a read that fails after the log was opened gives an unavailable record, at baseline and after", async () => {
    const f = await fixture(created({ id: "ses_a", title: "MAD a" }))
    f.io.openLog = failingOpen({ readCall: 1 })
    const baseline = join(f.dir, "baseline.json")
    expect(await f.run("baseline", "--log", f.log, "--out", baseline)).toBe(1)
    expect((await f.json(baseline)).reason).toBe("a read or stat of the log failed")

    const g = await captureAround(created({ id: "ses_a", title: "MAD a" }), (log) => appendFile(log, created({ id: "ses_b", title: "MAD b" })))
    expect(g.code).toBe(0)
    g.f.io.openLog = failingOpen({ readCall: 1 })
    const out = join(g.f.dir, "capture-2.json")
    expect(await g.f.run("after", "--log", g.f.log, "--baseline", join(g.f.dir, "baseline.json"), "--out", out)).toBe(1)
    const record = await g.f.json(out)
    expect(record.reason).toBe("a read or stat of the log failed")
    expect(record.rows).toBeUndefined()
  })

  test("a stat that fails after the reads gives an unavailable record", async () => {
    const g = await captureAround(created({ id: "ses_a", title: "MAD a" }), (log) => appendFile(log, created({ id: "ses_b", title: "MAD b" })))
    g.f.io.openLog = failingOpen({ statCall: 2 })
    const out = join(g.f.dir, "capture-2.json")
    expect(await g.f.run("after", "--log", g.f.log, "--baseline", join(g.f.dir, "baseline.json"), "--out", out)).toBe(1)
    const record = await g.f.json(out)
    expect(record.reason).toBe("a read or stat of the log failed")
    expect(record.checks.handleBefore).toBeDefined()
  })

  test("a directory and a FIFO are refused before any open, without blocking", async () => {
    const f = await fixture(null)
    await mkdir(f.log)
    expect(await f.run("baseline", "--log", f.log, "--out", join(f.dir, "dir.json"))).toBe(1)
    expect((await f.json(join(f.dir, "dir.json"))).reason).toBe("the log is not a regular file")
    const fifo = join(f.dir, "fifo.log")
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0)
    expect(await f.run("baseline", "--log", fifo, "--out", join(f.dir, "fifo.json"))).toBe(1)
    expect((await f.json(join(f.dir, "fifo.json"))).reason).toBe("the log is not a regular file")
  }, 5_000)

  test("baselines with unsafe identities or a malformed time are refused", async () => {
    const f = await fixture("x\n")
    const baseline = join(f.dir, "baseline.json")
    expect(await f.run("baseline", "--log", f.log, "--out", baseline)).toBe(0)
    const text = await readFile(baseline, "utf8")
    const good = JSON.parse(text)
    const variants = [
      text.replace(/"device": \d+/, '"device": 1e999'),
      JSON.stringify({ ...good, inode: -1 }),
      JSON.stringify({ ...good, device: 1.5 }),
      JSON.stringify({ ...good, takenAt: "yesterday" }),
    ]
    for (const [k, variant] of variants.entries()) {
      const path = join(f.dir, `bad-${k}.json`)
      await writeFile(path, variant)
      expect(await f.run("after", "--log", f.log, "--baseline", path, "--out", join(f.dir, `out-${k}.json`))).toBe(2)
    }
  })

  test("a range limit that is not a non-negative safe integer is refused", async () => {
    const f = await fixture("x\n")
    f.io.rangeLimitBytes = Number.NaN
    expect(await f.run("baseline", "--log", f.log, "--out", join(f.dir, "b.json"))).toBe(2)
  })
})
