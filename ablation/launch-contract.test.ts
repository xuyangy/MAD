import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runIdentityProblems as pilotIdentityProblems } from "../scripts/oauth-pilot.ts"
import { apiKeyEvaluationIdentityProblems, evaluationIdentityProblems, type EvaluationRun } from "../scripts/paired.ts"
import { LAUNCH_EVIDENCE_DIR, launchIdentityProblems, reserveExclusive, stageOneBinary, type ReserveWhy } from "./launch-contract.ts"
import {
  ADVERSARIAL_RUN,
  adversarialReservation,
  API_KEY_EVALUATION_RUN,
  apiKeyEvaluationEvidencePattern,
  apiKeyEvaluationReservation,
  adversarialRunProblem,
  EVALUATION_RUN,
  evaluationReservation,
  OAUTH_PILOT_EVIDENCE_DIR,
  OAUTH_PILOT_RUN,
  oauthPilotReservation,
  type AdversarialRun,
  type ApiKeyEvaluationRun,
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

/** The launchers' rule sets, each through its own wrapper, returning every problem (adversarial: its first only). */
const pilot = (identity: unknown) => pilotIdentityProblems(identity as OAuthPilotRun)
const paired = (identity: unknown) => evaluationIdentityProblems(identity as EvaluationRun)
const apiKey = (identity: unknown) => apiKeyEvaluationIdentityProblems(identity as ApiKeyEvaluationRun)
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
const apiKeyPrior = (run: number) => ({
  run,
  reservation: apiKeyEvaluationReservation(run),
  evidence: `${LAUNCH_EVIDENCE_DIR}/paired-api-key-evaluation-run-${run}-2026-11-02.json`,
})

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
    label: "API_KEY_EVALUATION_RUN",
    check: apiKey,
    run: 3,
    base: (prior: unknown[]) => ({ run: 3, reservation: apiKeyEvaluationReservation(3), prior }),
    prior: apiKeyPrior,
    reservationOf: apiKeyEvaluationReservation,
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

describe("launchIdentityProblems: the shipped constants", () => {
  test("OAUTH_PILOT_RUN, EVALUATION_RUN, API_KEY_EVALUATION_RUN and ADVERSARIAL_RUN pass their launchers' rules", () => {
    expect(pilotIdentityProblems(OAUTH_PILOT_RUN)).toEqual([])
    expect(evaluationIdentityProblems(EVALUATION_RUN)).toEqual([])
    expect(apiKeyEvaluationIdentityProblems(API_KEY_EVALUATION_RUN)).toEqual([])
    expect(apiKeyEvaluationIdentityProblems()).toEqual([])
    expect(adversarialRunProblem(ADVERSARIAL_RUN)).toBeNull()
  })
})

describe("launchIdentityProblems: malformed identities, for each launcher", () => {
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
        expect(check(base([...list]))[0], shown).toBe(`${label}.prior lists runs ${shown}, not exactly runs 1 to 2 before run 3: a gap, a duplicate, a reused run or an extra entry`)
      }
    })

    test(`${label}: a prior entry that is not an object is named, and adds no entry-level extra`, () => {
      const listed = `${label}.prior lists runs [1, (not an object)], not exactly runs 1 to 2 before run 3: a gap, a duplicate, a reused run or an extra entry`
      const problems = check(base([prior(1), null]))
      // The adversarial wrapper returns its first problem only; the others list every one.
      if (label === "ADVERSARIAL_RUN") expect(problems[0]).toBe(listed)
      else expect(problems).toEqual([listed, `${label}.prior entry 2 is not an object`])
    })

    test(`${label}: an entry with no run is shown as (missing)`, () => {
      const { run: _run, ...noRun } = prior(2)
      expect(check(base([prior(1), noRun]))[0]).toBe(
        `${label}.prior lists runs [1, (missing)], not exactly runs 1 to 2 before run 3: a gap, a duplicate, a reused run or an extra entry`,
      )
    })

    test(`${label}: a 2**40 run is refused by its length alone`, () => {
      expect(check({ ...good(), run: 2 ** 40, ...(launcher.own ? { reservation: launcher.reservationOf(2 ** 40) } : {}) })[0]).toBe(
        `${label}.prior lists runs [1, 2], not exactly runs 1 to ${2 ** 40 - 1} before run ${2 ** 40}: a gap, a duplicate, a reused run or an extra entry`,
      )
    })

    test(`${label}: a run that is not an integer, and one below the floor, are refused with different reasons`, () => {
      for (const run of [2.5, "3"]) {
        expect(check({ ...good(), run })[0], JSON.stringify(run)).toBe(`${label} names run ${JSON.stringify(run)}, which is not an integer`)
      }
      const below =
        label === "OAUTH_PILOT_RUN"
          ? "OAUTH_PILOT_RUN names run 1: run 1 has run and is spent, so the run gate 8 authorizes is an integer of at least 2"
          : `${label} names run 0: the run is an integer of at least 1`
      expect(check({ ...good(), run: label === "OAUTH_PILOT_RUN" ? 1 : 0 })[0]).toBe(below)
    })

    test(`${label}: evidence outside ${LAUNCH_EVIDENCE_DIR} and another run's reservation are named`, () => {
      const outside = { ...prior(2), evidence: "docs/run-2.json" }
      expect(check(base([prior(1), outside]))[0]).toBe(`${label}.prior names run 2's evidence \`docs/run-2.json\`, which is not a file in ${LAUNCH_EVIDENCE_DIR}`)
      for (const evidence of [`${LAUNCH_EVIDENCE_DIR}/.`, `${LAUNCH_EVIDENCE_DIR}/..`, `${LAUNCH_EVIDENCE_DIR}/./run-2.json`, `${LAUNCH_EVIDENCE_DIR}//run-2.json`, `${LAUNCH_EVIDENCE_DIR}/sub/run-2.json`]) {
        expect(check(base([prior(1), { ...prior(2), evidence }])), evidence).toEqual(
          [`${label}.prior names run 2's evidence \`${evidence}\`, which is not a file in ${LAUNCH_EVIDENCE_DIR}`],
        )
      }
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

  test("API_KEY_EVALUATION_RUN: a wrong own reservation, a bad prior and a non-integer run each name the constant; no pin is checked", () => {
    expect(apiKey({ ...API_KEY_EVALUATION_RUN, reservation: evaluationReservation(1) })).toEqual([
      `API_KEY_EVALUATION_RUN names its own reservation \`${evaluationReservation(1)}\`, which is not \`${apiKeyEvaluationReservation(1)}\``,
    ])
    expect(apiKey({ ...API_KEY_EVALUATION_RUN, prior: [{ run: 1, reservation: apiKeyEvaluationReservation(1), evidence: `${LAUNCH_EVIDENCE_DIR}/x.json` }] })).toEqual([
      "API_KEY_EVALUATION_RUN.prior lists runs [1], not exactly runs [] before run 1: a gap, a duplicate, a reused run or an extra entry",
    ])
    expect(apiKey({ ...API_KEY_EVALUATION_RUN, run: 1.5 })).toEqual(["API_KEY_EVALUATION_RUN names run 1.5, which is not an integer"])
    expect(apiKey({ ...API_KEY_EVALUATION_RUN, pins: null })).toEqual([])
  })

  describe("API_KEY_EVALUATION_RUN: a prior run's evidence is that run's dated api-key evaluation file", () => {
    const run2 = (evidence: unknown) => ({ run: 2, reservation: apiKeyEvaluationReservation(2), prior: [{ ...apiKeyPrior(1), evidence }] })
    const notItsName = (evidence: string) =>
      `API_KEY_EVALUATION_RUN.prior names run 1's evidence \`${evidence}\`, which is not run 1's api-key evaluation evidence name in ${LAUNCH_EVIDENCE_DIR}`

    test("the pattern is the dated name, with no calendar check", () => {
      expect(apiKeyEvaluationEvidencePattern(1).test("paired-api-key-evaluation-run-1-2026-11-02.json")).toBe(true)
      expect(apiKeyEvaluationEvidencePattern(1).test("paired-api-key-evaluation-run-1-2026-13-45.json")).toBe(true)
      expect(apiKeyEvaluationEvidencePattern(1).test("paired-api-key-evaluation-run-11-2026-11-02.json")).toBe(false)
      expect(apiKeyEvaluationEvidencePattern(11).test("paired-api-key-evaluation-run-1-2026-11-02.json")).toBe(false)
    })

    // Each name is the right dated name plus extra characters, so only the anchors and the escaped dot refuse it.
    const decorated = [
      "old-paired-api-key-evaluation-run-1-2026-11-02.json",
      "paired-api-key-evaluation-run-1-2026-11-02.json.bak",
      "paired-api-key-evaluation-run-1-2026-11-02.json.reservation",
      "paired-api-key-evaluation-run-1-2026-11-02xjson",
    ]

    test("the pattern is anchored at both ends and its dot is literal", () => {
      for (const name of decorated) expect(apiKeyEvaluationEvidencePattern(1).test(name), name).toBe(false)
    })

    test("a prefixed, suffixed or wrongly separated name is one problem", () => {
      for (const name of decorated) {
        const evidence = `${LAUNCH_EVIDENCE_DIR}/${name}`
        expect(apiKey(run2(evidence)), name).toEqual([notItsName(evidence)])
      }
    })

    test("evidence that is not a file name at all is only the shared problem", () => {
      for (const evidence of [null, 7, "", LAUNCH_EVIDENCE_DIR, `${LAUNCH_EVIDENCE_DIR}/`]) {
        const problems = apiKey(run2(evidence))
        expect(problems, String(evidence)).toHaveLength(1)
        expect(problems[0], String(evidence)).toContain(`which is not a file in ${LAUNCH_EVIDENCE_DIR}`)
      }
    })

    test("the shipped run passes", () => {
      expect(apiKey(API_KEY_EVALUATION_RUN)).toEqual([])
    })

    test("a good prior passes", () => {
      expect(apiKey(run2(`${LAUNCH_EVIDENCE_DIR}/paired-api-key-evaluation-run-1-2026-11-02.json`))).toEqual([])
    })

    test("the run's own reservation as evidence is one problem", () => {
      expect(apiKey(run2(apiKeyEvaluationReservation(1)))).toEqual([notItsName(apiKeyEvaluationReservation(1))])
    })

    test("another launcher's file is one problem", () => {
      for (const name of ["paired-oauth-evaluation-run-1-2026-10-02.json", "oauth-pilot-live-2026-09-28.json"]) {
        const evidence = `${LAUNCH_EVIDENCE_DIR}/${name}`
        expect(apiKey(run2(evidence)), name).toEqual([notItsName(evidence)])
      }
    })

    test("a wrong run or an undated name is one problem", () => {
      for (const name of ["paired-api-key-evaluation-run-2-2026-11-02.json", "paired-api-key-evaluation-run-1.json"]) {
        const evidence = `${LAUNCH_EVIDENCE_DIR}/${name}`
        expect(apiKey(run2(evidence)), name).toEqual([notItsName(evidence)])
      }
    })

    test("evidence outside the directory is only the shared problem", () => {
      expect(apiKey(run2("elsewhere/x.json"))).toEqual([`API_KEY_EVALUATION_RUN.prior names run 1's evidence \`elsewhere/x.json\`, which is not a file in ${LAUNCH_EVIDENCE_DIR}`])
    })

    test("a malformed prior list is only the shared list problem: the extra adds nothing", () => {
      const badName = { ...apiKeyPrior(2), evidence: `${LAUNCH_EVIDENCE_DIR}/x.json` }
      expect(apiKey({ run: 3, reservation: apiKeyEvaluationReservation(3), prior: [badName] })).toEqual([
        "API_KEY_EVALUATION_RUN.prior lists runs [2], not exactly runs 1 to 2 before run 3: a gap, a duplicate, a reused run or an extra entry",
      ])
      expect(apiKey({ run: 3, reservation: apiKeyEvaluationReservation(3), prior: [{ ...apiKeyPrior(1), evidence: `${LAUNCH_EVIDENCE_DIR}/x.json` }, null] })).toEqual([
        "API_KEY_EVALUATION_RUN.prior lists runs [1, (not an object)], not exactly runs 1 to 2 before run 3: a gap, a duplicate, a reused run or an extra entry",
        "API_KEY_EVALUATION_RUN.prior entry 2 is not an object",
      ])
    })
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
    expect(adversarial({ ...ADVERSARIAL_RUN, pins: ["a/b", "c/d"] })).toEqual(['ADVERSARIAL_RUN.pins ["a/b","c/d"] are not exactly one `provider/model` pin for the one-slot roster'])
    expect(paired({ ...EVALUATION_RUN, pins: [] })).toEqual(["EVALUATION_RUN.pins [] is not a non-empty list of distinct `provider/model` pins"])
  })

  test("the shared validator takes no launcher fact of its own: a custom label, floor and reservation name", () => {
    const rules = { label: "X", floor: 1, reservationOf: (run: number) => `${LAUNCH_EVIDENCE_DIR}/x-${run}`, ownReservation: true }
    expect(launchIdentityProblems({ run: 1, reservation: `${LAUNCH_EVIDENCE_DIR}/x-1`, prior: [] }, rules)).toEqual([])
    expect(launchIdentityProblems({ run: 1, reservation: `${LAUNCH_EVIDENCE_DIR}/x-1`, prior: "none" }, rules)).toEqual(["X.prior is not a list: it must list exactly runs [] before run 1"])
  })

  test("a floor that is not an integer of at least 1 is a programming error: it throws", () => {
    for (const floor of [0, -1, 1.5, Number.NaN]) {
      expect(() => launchIdentityProblems({ run: 1, prior: [] }, { label: "X", floor, reservationOf: (run) => `${run}` }), String(floor)).toThrow("X's rules name the floor")
    }
  })

  test("the extras see whether the list is well formed; the pilot's add nothing to a rejected run or list", () => {
    const seen: boolean[] = []
    const rules = { label: "X", floor: 1, reservationOf: (run: number) => `${LAUNCH_EVIDENCE_DIR}/x-${run}`, extra: (_: unknown, shape: { wellFormed: boolean }) => (seen.push(shape.wellFormed), []) }
    launchIdentityProblems({ run: 2, prior: [{ run: 1, reservation: `${LAUNCH_EVIDENCE_DIR}/x-1`, evidence: `${LAUNCH_EVIDENCE_DIR}/e.json` }] }, rules)
    launchIdentityProblems({ run: 2, prior: [] }, rules)
    launchIdentityProblems({ run: 0, prior: [] }, rules)
    expect(seen).toEqual([true, false, false])
    const bad = { ...pilotPrior(1), evidence: "docs/x.json", proposalSha256: "short" }
    expect(pilot({ run: 3, prior: [bad] })).toEqual([
      "OAUTH_PILOT_RUN.prior lists runs [1], not exactly runs 1 to 2 before run 3: a gap, a duplicate, a reused run or an extra entry",
    ])
    expect(pilot({ run: 1, prior: [bad] })).toEqual(["OAUTH_PILOT_RUN names run 1: run 1 has run and is spent, so the run gate 8 authorizes is an integer of at least 2"])
    // Evidence the shared rules refused is named once, not again as a misnamed pilot file.
    expect(pilot({ run: 2, prior: [{ ...pilotPrior(1), evidence: `${OAUTH_PILOT_EVIDENCE_DIR}/..` }] })).toEqual([
      `OAUTH_PILOT_RUN.prior names run 1's evidence \`${OAUTH_PILOT_EVIDENCE_DIR}/..\`, which is not a file in ${LAUNCH_EVIDENCE_DIR}`,
    ])
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

  test("the seam's measured build passes through, so the spawn-time re-check expects what stage 1 expected", () => {
    const measured = { version: "0.0.0-test", sha256: "f".repeat(64) }
    expect(stageOneBinary("/real/opencode", { binary: "/link/opencode", measured })).toEqual({ binary: "/real/opencode", measured })
  })
})
