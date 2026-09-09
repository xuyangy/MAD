# Survey grounding

Source: Motger et al., *Multi-Agent Debate Strategies: Survey, Taxonomy, and Challenges* — `../../../mad.pdf`, an SLR over 141 primary studies with a three-dimensional taxonomy (participants / interaction / agreement). Cited by the **Why** in `SPEC.md`.

The survey's own conclusion is that the alternatives below are "not absent but marginal" — adopted against by convention rather than by comparison. MAD takes the marginal option at nearly every dimension. Collectively, that is the product.

## Where MAD sits against the field's default

| Dimension | Field default | MAD |
| --- | --- | --- |
| Authority | Single or fully-symmetric | Hybrid / decomposed judge pipeline (≈4% of studies) |
| Debaters | Homogeneous, one model family | Heterogeneous, especially unusual in coding tasks |
| Topology | Static, fully connected | Sparse rooms: author + skeptic + co-finders |
| Message passing | Verbatim transcript | Non-verbatim, structured findings and extracted evidence |
| Memory | Short-term, within session | Beyond the session (deferred to v2 — see `deferred-v2.md`) |
| Agent ordering | Uncontrolled | Controlled: anonymized, randomized before judging |
| Agreement | Majority vote | Three separate numbers; silence is abstention, not a no |

## The unclaimed surface

The pipeline has **three** agreement events, not one:

- **identity** — are two findings the same finding? (clustering)
- **verdict** — is it real?
- **severity** — how bad is it?

The survey's taxonomy has no slot for identity. Clustering is both the design's weakest link and its least-charted ground.

## Where this change moves toward the field, not away from it

Persona and role assignment is **well populated** in the survey's participants dimension — it is close to the field default in multi-agent debate work. Adding discovery lenses (CAP-11) is therefore the one dimension where MAD adopts the convention rather than the marginal option, and `SPEC.md`'s "nearly every choice here is the marginal option" carries this asterisk.

Two things remain unconventional and are the actual contribution: the personas carry **no vote weight and no co-discovery prior** (the field typically lets a persona's finding count like any other), and they are **stripped before adjudication** rather than being visible to the judge. The claim is not "MAD uses personas"; it is "MAD uses personas without letting them buy authority."

## The bet, and how to falsify it cheaply

Run the same diff two ways — a single strong model, and the full pipeline. If debate does not change verdicts often enough to justify its token bill, the design is wrong and that was learned cheaply. If it does, the result is publishable as well as usable: the survey states nobody has run this comparison.

Build the ablation harness early (CAP-9). It is the cheapest insurance in the project.
