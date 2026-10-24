# Gemini rewrite adapter — PR 2 validation

Base: PR #139, `codex/gemini-rewrite-plan` at
`562859ce45d4da70d0f0cc15717aa2f753641ddd`. This increment targets that branch,
not main. Keep the stack unmerged pending maintenance acceptance and operator
approval. Production/VPS settings have not been changed.

## Scope

Add `google-gemini` rewrite registration, startup configuration, lazy ADC,
Vertex REST generateContent/streamGenerateContent translation and sanitized
errors. Retain service-owned instructions, OpenCC conversion, default provider,
public requests/output, T2A and transcription. Promote the already locked
`google-auth-library` 11.0.2 to a direct dependency without changing its version.
No policy selector or evaluator is implemented here.

## Checks completed

- Node 24.19.0: `npm ci --ignore-scripts` and full `npm test`: **403 passed,
  zero failed, zero skipped**, including existing real FFmpeg tests.
- 28 new Gemini cases: JSON and SSE; byte-split UTF-8/CRLF/multiline frames;
  reasoning exclusion; native usage whitelist; truncation, safety, empty,
  malformed, oversized and missing-terminal failures; terminal before EOF;
  HTTP auth/quota/server errors without inference retries; coalesced ADC waiters,
  cancellation/deadline/recovery; endpoint syntax and SDK logging protection.
- Actual server composition: both rewrite aliases, unchanged auth/validation,
  JSON/NDJSON, passive readiness without calls, MiniMax T2A coexistence, slow
  upstream abort, client disconnect, released admission and isolated queued calls.
- Manual curl using real bridge and mock upstream: both aliases returned HTTP
  200 with expected JSON and NDJSON with one terminal completion each.
- Existing `services/rewrite.js` is unchanged, preserving instruction text and
  output postprocessing. No route/auth/server implementation changed.
- `git diff --check` passed. The approved 60 language fixtures are unchanged.

An initial sandbox run could not bind loopback (EPERM); tests were rerun with
network permission. A manual smoke attempt while the full suite owned port 3001
failed to start; the isolated rerun passed. Neither was a provider test failure.

## Security follow-up incorporated

PR #141 patched body-parser to 1.20.9 on main at
`d0654c6e1d57ea00ee2a74490207030e1856cd3f`. Main was merged into #139,
then #139 into this branch; both Gemini PRs remain open with their original bases.
The combined tree passed **405 tests, zero failures/skips** on Node 24.19.0 and
`npm audit --omit=dev` reported **zero vulnerabilities**. Its executable files,
lockfile and tests match the integration tree tested before propagation.
The standalone security fix passed 377 tests locally on Node 22/24 and both
GitHub CI jobs before merging. Production still requires the operator's VPS
update and acceptance; the initial audit finding below is historical.

## Initial dependency finding (resolved by PR #141)

`npm audit --omit=dev` reports **one high-severity body-parser vulnerability**:
[GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), denial
of service with trailing bytes after a compressed request body, affected versions
below 1.20.9. The locked body-parser entry is identical to main; this PR neither
introduces nor fixes it. The separately authorized main-targeted security PR updated the lock and added
request-body/auth regression tests before propagation into this stack. Audit output is not an exploitability
assessment of the deployed proxy/bridge.

## Remaining acceptance / limitations

No paid Gemini calls or live language evaluation were made. The operator's
previous one-request VPS smoke result is not evidence for this adapter's live
streaming or long-running quality. Node 22 is covered by the repository CI matrix,
not by this local run. Run bounded live JSON/streaming checks, language evaluation
and full worksheet acceptance before changing production.

ADC waiters honor request deadlines; a shared SDK credential discovery operation
cannot itself be cancelled and can remain pending after those waiters leave.
At most one is retained per adapter, and expired waiters never launch inference.
A stuck credential operation may require restart. Passive readiness is not proof
of credentials/quota/model availability. Streaming failures can follow partial
text. LOW thinking consumes the configured output budget; truncation is an error.
Billing caps remain external, delayed controls. There is no fallback or exact
monthly budget ledger in this change.
