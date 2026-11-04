# MiniMax adaptive thinking trial

This increment stacks on PR #144 (`codex/rewrite-policy`), not main or the paused
Gemini branches. Do not merge the stack before explicit operator approval. Last
reported VPS candidate: 4a2977947962baa1fff3a64707915c9b84862966, MiniMax-M3,
Anthropic protocol, hk-school-v2, 4096 tokens, thinking disabled. Verify current
state before deployment; no deployment is performed by this document.

## Evidence and limitations

On 2026-10-25 the approved 60 cases were each evaluated with disabled and adaptive
thinking, exact B prompt, 4096 tokens, 60-second deadlines, alternating pair order,
no retries. All 120 completed normally. Median latency: disabled 1.24 s versus
adaptive 2.72 s; reported output tokens: 1362 versus 13439. Adaptive produced
thinking blocks on 57/60 requests. Highest adaptive output usage: 760 tokens.
Quality improvements included obligation in case 027 and creation of a table in
036; wording issues remain. One pair per case does not prove repeatability.
This direct API evaluation is not bridge or worksheet acceptance. No increase above
4096 tokens or the existing deadline is supported by this evidence.

## Maintenance acceptance

1. Verify clean checkout, exact candidate/base SHAs, live settings, service user,
   credentials, listener and actual HTTP health/readiness. Prepare a candidate-pinned
   acceptance kit and root-only verified backup of code, dependencies, environment,
   credentials, systemd and proxy configuration before stopping service.
2. Deploy the reviewed pinned candidate during maintenance with thinking absent or
   explicitly `disabled`. Keep policy B, model, protocol, budget and timeout unchanged.
   Use umask 022 for application checkout/install, separately protect backups and
   secrets. Check service-user readability and poll actual health/readiness.
3. Run automated acceptance and worksheet checks with disabled thinking first.
4. Only after review and operator agreement set `REWRITE_MINIMAX_THINKING=adaptive`
   in the service environment, restart during maintenance and repeat acceptance.
   Verify the running setting, JSON/stream completion, quotation preservation,
   first-text latency, audio and transcription workflows. Readiness alone does
   not prove provider request acceptance. Never reveal reasoning in public output.
5. Monitor latency, incomplete answers, usage/cost and real wording quality. Total
   output budget includes thinking; a partial response is not full language success.
   Do not raise tokens/timeouts or change provider/model automatically.

## Rollback

Restore `REWRITE_MINIMAX_THINKING=disabled` (or remove the variable), restart during
maintenance and verify actual HTTP health plus rewrite behavior. Retain policy B
unless a separate policy rollback is intended. For release-level faults restore
pinned baseline code, matching dependencies and saved configuration; verify file
permissions and health. A systemd active flag alone is insufficient.

## Provider contract

[MiniMax API reference](https://platform.minimax.io/docs/api-reference/text-anthropic-api)
was checked 2026-10-25. M3 uses adaptive/disabled, not a low effort level. M3.1 Flash
is a different model and is outside this opt-in's tested scope. Current documentation
says temperature is ignored for M3. No public API parameter or fallback is added.
