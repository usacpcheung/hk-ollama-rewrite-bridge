# Hong Kong school rewrite evaluation

The [JSON fixture](hk-school-rewrite-cases.json) contains all 60 user-approved
cases from the planning conversation, recorded 2026-10-24. Cases 1–15 were approved
first (case 7 terminology explicitly accepted), followed by 16–60. Approval means
agreement on requirements/examples, not successful execution against any provider.
[Specification](../reference/hk-school-rewrite-specification.md) ·
[Migration and rollout](../architecture/rewrite-policy-rollout.md).

## Fixture contract

`schema_version: 1`; stable IDs HKS-001 through HKS-060. Each record includes
category, title, input, illustrative_output and review_requirements. Examples are
illustrative, never mandatory exact-match answers. Preserve IDs and original
approved text; proposed revisions require review and versioned evidence. Case 59
contains two paragraphs in both input and example. Fixtures contain synthetic,
non-sensitive passages, including deliberately quoted instructions treated as data.

| IDs | Coverage |
|---|---|
| 1–5 | Spoken Cantonese, negation, uncertainty, obligation and emphasis |
| 6–11 | Mixed English, school terminology, platform names and emotion |
| 12–15 | Existing written language, ambiguity, quotation and instruction boundary |
| 16–25 | Cantonese construction, order, preference and scope |
| 26–35 | English terms in school contexts |
| 36–43 | Names, filenames, abbreviations and ambiguous English words |
| 44–50 | Quantities, comparisons and uncertainty |
| 51–55 | Existing written Chinese, tone and quotations |
| 56–60 | Longer passages, paragraph structure, inference and embedded instructions |

## Human rubric

Assess meaning, completeness, Cantonese/English interpretation, Hong Kong school
register and output discipline separately. Outcomes:

- **Fail:** changed meaning, invented information, substantive omission, executing
  embedded instructions, or violating passage-only output requirements.
- **Needs improvement:** faithful content but unnatural or excessively formal wording.
- **Pass:** faithful and complete, appropriate school register and output discipline.

Do not hide a meaning failure behind an averaged score. Review requirements are
case-specific invariants and rejection examples, not exhaustive correctness proofs.
Teacher/operator judgment decides linguistic acceptance; an LLM judge may assist
but cannot be the only authority. Record disagreements and their resolution.

## Planned live execution (separate acceptance preparation)

This policy PR carries the approved cases unchanged; no live calls or language
results are included. Prepare a bounded evaluation runner separately before paid
execution; it must not change the production policy or send hidden retries. Begin with approximately ten
varied cases (suggested: 2, 3, 6, 7, 10, 12, 14, 41, 56, 60), review, then run all
60. Estimate cost from current model pricing and remaining allowance before
explicitly authorized paid batches. Bound input/output, concurrency and calls; no
automatic retries. A cost cap may reject requests: record infrastructure failures
separately from language failures; do not fabricate outputs or mark them passed.

Compare MiniMax/current-v1 and MiniMax/hk-school-v1 on useful subsets.
Gemini evaluation is paused and is not a dependency of this rollout. Record immutable code revision,
provider/model/location, policy ID and prompt digest, generation parameters, case
ID, output, finish reason, latency, usage including reported reasoning tokens,
request error, reviewer, verdict and rationale. Track estimated charges separately
from actual billing. Do not log keys/tokens or student recordings. Store run results
outside production request handling; do not overwrite previous runs.

Release requires full-set human review with no unresolved meaning/completeness or
output-boundary failures and operator acceptance of register. Recheck previously
passing and affected cases after revisions. Keep evaluation inputs out of the
runtime prompt wholesale; curated examples must remain small. Since this set is
known during development, it is regression evidence, not an unbiased quality
benchmark. Later add independently reviewed held-out examples without replacing
the approved suite.

Text cases do not prove speech recognition, quota capacity, security robustness,
stream cancellation or API compatibility. Engineering tests and real worksheet/
VPS acceptance remain separate required gates. Do not make paid evaluations part
of default CI.
