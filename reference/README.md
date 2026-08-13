# Reference material

Code kept for reading, not for building on. Nothing here is imported by `core/`
or `adapters/`, nothing here is in the TypeScript project, and nothing here is
run by CI.

## `multi_agent_debate_ring.py`

An AutoGen-style multi-agent debate demo: four homogeneous math solvers wired in
a ring, three fixed rounds, a majority-vote aggregator, a mock LLM engine, and a
GSM8K word problem. Added 2026-08-13 as reference for MAD's debate stage.

**Read it for the round mechanics. Do not read it for the aggregation** — its
aggregator is the exact pattern MAD is designed against.

### Worth borrowing (story 5 — per-finding debate)

| Where | What |
| --- | --- |
| `:173-196` | The per-round barrier: buffer peer responses keyed by round, generate the next turn only once every neighbour has checked in, then pop the buffer. This is the synchronisation `debate` needs, and it is fiddly to derive from scratch. |
| `:329-342` | A concrete sparse topology. `cost-model.md` lever 4 ("sparse rooms: author + skeptic + co-finders") is otherwise only a sentence; this is one implemented. |
| `:250-300` | A scripted converging debate — two agents start wrong, read a neighbour's reasoning, and concede with a stated reason. Usable as a deterministic fixture for the `converged` exit (CAP-4) and for the concession deltas AD-7 requires. |

### A bug in it that is a lesson for us

`:178` advances only when `len(self._buffer[round]) == self._num_neighbors`. A
participant that never answers hangs the ring forever, silently. MAD's debate
barrier must **proceed on a missing participant** — one retry, then continue with
a warning naming it — which is AD-6(b) reaching into the debate stage. Worth an
explicit test in story 5.

### Where it conflicts with MAD (most of the design)

- **Majority vote** (`:238`) — `survey-grounding.md` names majority vote as the
  field default and MAD's position as three separate numbers; AD-9 forbids
  computing a scalar across signals. This is the anti-pattern, not a model.
- **Homogeneous debaters** — four instances of one class on one engine. MAD's
  recall mechanism is lineage diversity (AD-4, AD-5).
- **Debates the whole answer** — MAD's foundational constraint is that the unit
  of debate is the individual finding. This ring maps to *one finding's room*,
  never to a review.
- **Regex-scrapes `{{answer}}` out of prose** (`:147-151`), with a fallback that
  grabs the first integer anywhere in the response. This is the failure mode
  AD-12's schema-validated envelopes exist to prevent.
- **Verbatim transcript passing** (`:182-192`) versus MAD's non-verbatim
  structured findings and extracted evidence.
- **No degradation reporting** — no denominator, no drop-out path, a fixed round
  count, and no `stalled` exit.
