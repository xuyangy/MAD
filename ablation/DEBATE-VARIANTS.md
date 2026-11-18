# Debate variants: the comparison that would promote one to a default

MAD has two opt-in debate variants, both off by default:

- **references** (`ReviewDeps.debateReferences`, arm option `debate.references`): each debate entry
  gets a MAD id, a speaker who changes position is asked to cite the earlier entries that changed it,
  MAD records which citations were valid and flags a change with none, and the judge and the report
  see those recorded facts.
- **open questions** (`ReviewDeps.debateMissingEvidence`, arm option `debate.missingEvidence`): a
  speaker may list facts it could not check as questions, which only the Fact-Checker sees.

This document fixes, before any run, how a variant is compared with the baseline and what result
makes it a default. Nothing here authorizes a run. A comparison is a live, possibly paid run and
needs the human's scope and budget.

## Prerequisite

The paired runner (`ablation/paired.ts`) forks a prepared review into two continuations that differ
only in the routing policy (`shipped` or `debate-off`). The comparison below needs continuations
that differ only in the debate options, under the `shipped` policy, and for both variants at once a
three-way fork. That runner change has to be built and reviewed before any comparison runs. Until
then, `runArm` (`ablation/arms.ts`) runs a single arm with a variant on, which is enough for
scripted checks and not a matched comparison.

## Design

- **Change under review:** the labelled seeded-defect change (`fixtures/seeded-defects/`), with its
  answer keys never inside the reviewed worktree.
- **Blocks:** at least 3. In each block one review is prepared once (discovery and clustering), then
  forked into continuations that differ only in the debate options: baseline, references, open
  questions. Same roster, same host route, same budget dials.
- **Order:** the order in which a block's continuations run is rotated across blocks.
- **Each variant is compared with the baseline of its own block.** The two variants are not compared
  with each other.

## Measures, per block and continuation

The shared prefix (discovery and clustering) is charged once per block, as overhead, and is not
part of any continuation's figures. Per continuation:

- **Planted-defect recall** from the matcher, against the seeded labels.
- **Findings left unresolved**, and the verdict counts.
- **Newly issued attempts**: admitted attempts in the continuation, retries included, read from the
  continuation's own admission journal (the unit `ablation/EVALUATION.md` uses). The prefix's attempts
  are reported once, separately.
- **Observed tokens**: the tokens the continuation itself executed,
  `spentTokens(usageByOrigin(ledger).executedHere.tokens)` (`core/budget/ledger.ts`). A forked
  continuation's `ledger.total` is attributed usage and includes the inherited prefix, so it is never
  the measure.
- **Turns with unknown usage**: `usageByOrigin(ledger).executedHere.unknown`, read only after
  `usageIsAudited(ledger)` holds; an unaudited ledger makes the count missing. Reported as a count,
  never estimated, and never folded into tokens.
- **references only:** position changes, those with at least one valid citation, and those flagged
  `shiftWithoutValidReference`.
- **open questions only:** questions recorded, and questions that reached a Fact-Checker prompt.
- **Precision**, only from the blind adjudication sheet (`fixtures/seeded-defects/ADJUDICATION.md`),
  filled before the arms are read: `TP`, `U` (unresolved labels) and `N` reported, and the interval
  `[TP/N, (TP+U)/N]`. Without a filled sheet, precision is reported as unavailable.

## Handling of gaps

- **Failed block:** a block in which the baseline or the variant continuation did not complete gives
  no contrast for that variant. Its figures are reported as observed and are not used for promotion.
- **Missing metric:** a measure that could not be read for a continuation is reported as missing;
  it is never filled in or carried from another block.
- **Zero denominator:** a ratio whose denominator is zero (no position changes, `N = 0`) is reported
  as not applicable, not as 0 or 1.
- **Unavailable gate metric:** a measure a promotion gate needs that is missing, not applicable or
  unavailable in any block (precision with `N = 0` or no filled sheet included) fails that gate. No
  gate passes on a metric it could not read.
- **Unknown usage:** a continuation with any turn of unknown usage has incomplete token cost. Its
  tokens are reported as a floor, and the token gate below cannot be met in that block.

## Promotion

A variant becomes a default only if all of these hold:

1. **Coverage:** at least 3 blocks, and the baseline and variant continuations completed in every
   block.
2. **Recall:** in no block is the variant's planted-defect recall below the baseline's, and either it
   is higher in at least one block, or recall is equal in every block and the variant leaves fewer
   findings unresolved in at least two blocks and more in none.
3. **Precision:** a filled adjudication sheet exists, and the lower bound of the variant's precision
   interval is not below the baseline's in any block. Recall alone never promotes a variant.
4. **Cost:** in every block, both continuations have complete usage (no turn of unknown usage), the
   variant's observed tokens are at most 15% above the baseline's, and its newly issued attempts are
   at most 10% above the baseline's or at most 2 more, whichever is larger.
5. **Unknown usage:** in no block does the variant have more turns of unknown usage than the
   baseline. (Equal counts do not establish equal cost; gate 4 is what requires complete usage.)

Anything else leaves the variant opt-in. The outcome is published either way, with every block's
figures, in the form `ablation/EVALUATION.md` uses.
