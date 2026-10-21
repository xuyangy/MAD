import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runIdentityProblems as pilotIdentityProblems } from "../scripts/oauth-pilot.ts"
import { evaluationIdentityProblems, type EvaluationRun } from "../scripts/paired.ts"
import { LAUNCH_EVIDENCE_DIR, reserveExclusive, runIdentityProblems, stageOneBinary, type ReserveWhy } from "./launch-contract.ts"
import {
  ADVERSARIAL_RUN,
  adversarialReservation,
  adversarialRunProblem,
  EVALUATION_RUN,
  evaluationReservation,
  OAUTH_PILOT_EVIDENCE_DIR,
  OAUTH_PILOT_RUN,
  oauthPilotReservation,
  type AdversarialRun,
  type OAuthPilotRun,
} from "./paired-gates.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mad-launch-contract-"))
  roots.push(root)
  return root
}

const WHY: ReserveWhy = {
  exists: (relative) => `exists ${relative}`,
  failed: (relative, message) => `failed ${relative} (${message})`,
}

describe("reserveExclusive", () => {
  const relative = `${LAUNCH_EVIDENCE_DIR}/example-run-1.reservation`

  test("fresh: creates the directory, writes 2-space JSON in the caller's key order and a newline", async () => {
    const root = await temp()
    const record = { run: 1, story: "x", createdAt: "2026-10-21T00:00:00.000Z", out: "/o", commit: "c" }
    const result = await reserveExclusive(root, relative, record, WHY)
    expect(result).toEqual({ ok: true, path: join(root, relative) })
    expect(await readFile(join(root, relative), "utf8")).toBe(`${JSON.stringify(record, null, 2)}\n`)
  })

  test("race: of eight concurrent creations exactly one wins; the others get the caller's exists text and the winner's bytes stay", async () => {
    const root = await temp()
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => reserveExclusive(root, relative, { index }, WHY)))
    const won = results.flatMap((result, index) => (result.ok ? [index] : []))
    expect(won).toHaveLength(1)
    for (const result of results) if (!result.ok) expect(result.why).toBe(`exists ${relative}`)
    expect(JSON.parse(await readFile(join(root, relative), "utf8"))).toEqual({ index: won[0] })
  })

  test("another error: an unwritable directory gives the caller's failed text with the error's message", async () => {
    if (process.getuid?.() === 0) return
    const root = await temp()
    await mkdir(join(root, LAUNCH_EVIDENCE_DIR), { recursive: true })
    await chmod(join(root, LAUNCH_EVIDENCE_DIR), 0o500)
    try {
      const result = await reserveExclusive(root, relative, {}, WHY)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.why).toMatch(new RegExp(`^failed ${relative.replaceAll(".", "\\.")} \\(.*EACCES`))
    } finally {
      await chmod(join(root, LAUNCH_EVIDENCE_DIR), 0o700)
    }
  })

  test("a path whose parent is a file cannot be created: the failed text, not exists", async () => {
    const root = await temp()
    await writeFile(join(root, "ablation"), "a file\n")
    const result = await reserveExclusive(root, relative, {}, WHY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.why.startsWith(`failed ${relative} (`)).toBe(true)
  })
})

/** The three launchers' rule sets, each through its own wrapper, returning every problem (adversarial: its first only). */
const pilot = (identity: unknown) => pilotIdentityProblems(identity as OAuthPilotRun)
const paired = (identity: unknown) => evaluationIdentityProblems(identity as EvaluationRun)
const adversarial = (identity: unknown) => {
  const first = adversarialRunProblem(identity as AdversarialRun)
  return first === null ? [] : [first]
}

/** A well-formed identity of run `run` for each launcher, from its own path helpers. */
const pilotPrior = (run: number) => ({
  run,
  reservation: oauthPilotReservation(run),
  evidence: run === 1 ? `${OAUTH_PILOT_EVIDENCE_DIR}/oauth-pilot-live-2026-09-28.json` : `${OAUTH_PILOT_EVIDENCE_DIR}/oauth-pilot-live-run-${run}-2026-09-29.json`,
  proposalSha256: "a".repeat(64),
})
const plainPrior = (reservationOf: (run: number) => string) => (run: number) => ({ run, reservation: reservationOf(run), evidence: `${LAUNCH_EVIDENCE_DIR}/run-${run}.json` })

const LAUNCHERS = [
  { label: "OAUTH_PILOT_RUN", check: pilot, run: 3, base: (prior: unknown[]) => ({ run: 3, prior }), prior: pilotPrior, reservationOf: oauthPilotReservation, own: false },
  {
    label: "EVALUATION_RUN",
    check: paired,
    run: 3,
    base: (prior: unknown[]) => ({ run: 3, pins: ["a/b", "c/d"], reservation: evaluationReservation(3), prior }),
    prior: plainPrior(evaluationReservation),
    reservationOf: evaluationReservation,
    own: true,
  },
  {
    label: "ADVERSARIAL_RUN",
    check: adversarial,
    run: 3,
    base: (prior: unknown[]) => ({ run: 3, pins: ["a/b"], reservation: adversarialReservation(3), prior }),
    prior: plainPrior(adversarialReservation),
    reservationOf: adversarialReservation,
    own: true,
  },
] as const

describe("runIdentityProblems: the shipped constants", () => {
  test("OAUTH_PILOT_RUN, EVALUATION_RUN and ADVERSARIAL_RUN pass their launchers' rules", () => {
    expect(pilotIdentityProblems(OAUTH_PILOT_RUN)).toEqual([])
    expect(evaluationIdentityProblems(EVALUATION_RUN)).toEqual([])
    expect(adversarialRunProblem(ADVERSARIAL_RUN)).toBeNull()
  })
})

describe("runIdentityProblems: malformed identities, for each launcher", () => {
  for (const launcher of LAUNCHERS) {
    const { label, check, base, prior } = launcher
    const good = () => base([prior(1), prior(2)])

    test(`${label}: a well-formed run 3 passes`, () => {
      expect(check(good())).toEqual([])
    })

    test(`${label}: a gap, a duplicate and a misorder each name the listed runs`, () => {
      for (const [list, shown] of [
        [[prior(1)], "[1]"],
        [[prior(1), prior(1)], "[1, 1]"],
        [[prior(2), prior(1)], "[2, 1]"],
        [[prior(1), prior(2), prior(3)], "[1, 2, 3]"],
      ] as const) {
        expect(check(base([...list]))[0], shown).toBe(`${label}.prior lists runs ${shown}, not exactly runs 1 to 2 before run 3: a gap, a duplicate or a reused run`)
      }
    })

    test(`${label}: a prior entry that is not an object is named`, () => {
      const problems = check(base([prior(1), null]))
      expect(problems[0]).toBe(`${label}.prior lists runs [1, (not an object)], not exactly runs 1 to 2 before run 3: a gap, a duplicate or a reused run`)
    })

    test(`${label}: a 2**40 run is refused by its length alone`, () => {
      expect(check({ ...good(), run: 2 ** 40, ...(launcher.own ? { reservation: launcher.reservationOf(2 ** 40) } : {}) })[0]).toBe(
        `${label}.prior lists runs [1, 2], not exactly runs 1 to ${2 ** 40 - 1} before run ${2 ** 40}: a gap, a duplicate or a reused run`,
      )
    })

    test(`${label}: a run below the floor or not an integer is refused`, () => {
      const floor = label === "OAUTH_PILOT_RUN" ? 2 : 1
      for (const run of [floor - 1, 2.5, "3"]) {
        expect(check({ ...good(), run })[0], JSON.stringify(run)).toBe(`${label} names run ${JSON.stringify(run)}, which is not an integer of at least ${floor}`)
      }
    })

    test(`${label}: evidence outside ${LAUNCH_EVIDENCE_DIR} and another run's reservation are named`, () => {
      const outside = { ...prior(2), evidence: "docs/run-2.json" }
      expect(check(base([prior(1), outside]))[0]).toBe(`${label}.prior names run 2's evidence \`docs/run-2.json\`, which is not a file in ${LAUNCH_EVIDENCE_DIR}`)
      const renamed = { ...prior(2), reservation: launcher.reservationOf(1) }
      expect(check(base([prior(1), renamed]))[0]).toBe(`${label}.prior names run 2's reservation \`${launcher.reservationOf(1)}\`, not \`${launcher.reservationOf(2)}\``)
    })

    if (launcher.own) {
      test(`${label}: a wrong own reservation is named`, () => {
        expect(check({ ...good(), reservation: "ablation/evidence/elsewhere.reservation" })[0]).toBe(
          `${label} names its own reservation \`ablation/evidence/elsewhere.reservation\`, which is not \`${launcher.reservationOf(3)}\``,
        )
      })
    }
  }

  test("every problem is listed, not only the first", () => {
    const run = { run: 3, pins: ["a/b"], reservation: "elsewhere", prior: [{ run: 1, reservation: "x", evidence: "docs/1.json" }, { run: 2, reservation: evaluationReservation(2), evidence: "" }] }
    expect(paired(run)).toEqual([
      `EVALUATION_RUN names its own reservation \`elsewhere\`, which is not \`${evaluationReservation(3)}\``,
      `EVALUATION_RUN.prior names run 1's reservation \`x\`, not \`${evaluationReservation(1)}\``,
      `EVALUATION_RUN.prior names run 1's evidence \`docs/1.json\`, which is not a file in ${LAUNCH_EVIDENCE_DIR}`,
      `EVALUATION_RUN.prior names run 2's evidence \`\`, which is not a file in ${LAUNCH_EVIDENCE_DIR}`,
    ])
  })

  test("the pilot's legacy run-1 reservation name is the derived one", () => {
    expect(oauthPilotReservation(1)).toBe("ablation/evidence/oauth-pilot-live.reservation")
    expect(pilotIdentityProblems({ run: 2, prior: [pilotPrior(1)] })).toEqual([])
  })

  test("the extras: the pilot's dated evidence name and proposal sha256, adversarial's single pin, paired's pin list", () => {
    expect(pilot({ run: 2, prior: [{ ...pilotPrior(1), evidence: `${OAUTH_PILOT_EVIDENCE_DIR}/oauth-pilot-live-run-1.json`, proposalSha256: "short" }] })).toEqual([
      `OAUTH_PILOT_RUN.prior names run 1's evidence \`${OAUTH_PILOT_EVIDENCE_DIR}/oauth-pilot-live-run-1.json\`, which is not run 1's evidence name in ${OAUTH_PILOT_EVIDENCE_DIR}`,
      "OAUTH_PILOT_RUN.prior records no sha256 for run 1's proposal",
    ])
    expect(adversarial({ ...ADVERSARIAL_RUN, pins: ["a/b", "c/d"] })).toEqual([
      'adversarial run 1\'s pins ["a/b","c/d"] are not exactly one `provider/model` pin for the one-slot roster',
    ])
    expect(paired({ ...EVALUATION_RUN, pins: [] })).toEqual(["EVALUATION_RUN.pins [] is not a non-empty list of distinct `provider/model` pins"])
  })

  test("the shared validator takes no launcher fact of its own: a custom label, floor and reservation name", () => {
    const rules = { label: "X", floor: 1, reservationOf: (run: number) => `${LAUNCH_EVIDENCE_DIR}/x-${run}`, ownReservation: true }
    expect(runIdentityProblems({ run: 1, reservation: `${LAUNCH_EVIDENCE_DIR}/x-1`, prior: [] }, rules)).toEqual([])
    expect(runIdentityProblems({ run: 1, reservation: `${LAUNCH_EVIDENCE_DIR}/x-1`, prior: "none" }, rules)).toEqual(["X.prior is not a list: it must list exactly runs [] before run 1"])
  })
})

describe("stageOneBinary", () => {
  test("the identified real path replaces the seam's binary; the overridden seam functions pass through; nothing else is added", () => {
    const resolveBinary = async (path: string) => path
    const hashFile = async () => "0"
    expect(stageOneBinary("/real/opencode", { binary: "/link/opencode", resolveBinary, hashFile })).toEqual({ binary: "/real/opencode", resolveBinary, hashFile })
    expect(stageOneBinary("/real/opencode", undefined)).toEqual({ binary: "/real/opencode" })
    expect(stageOneBinary(undefined, undefined)).toEqual({})
  })
})
