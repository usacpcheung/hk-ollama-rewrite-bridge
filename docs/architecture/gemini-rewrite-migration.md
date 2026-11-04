# Gemini rewrite provider trial plan

Status: resumed planning and branch reconciliation, 2026-11-04. PR #139 targets
main; PR #140 targets `codex/gemini-rewrite-plan`. Both remain unmerged drafts.
This document is a plan, not permission to switch production.

## Accepted baseline and scope

Main `0360aa9c19a0afbf724966d33fd1a0ed65a13f4d` includes administrator-selected
rewrite policies (#144), MiniMax adaptive thinking (#145), and qs 6.16.2 (#146).
The operator reported successful deployment, 43 live acceptance checks and manual
worksheet acceptance, followed by the identical-file-tree main switch.
Production uses MiniMax-M3/Anthropic, `hk-school-v2`, adaptive thinking, 4096
output tokens and a 60000 ms ready invocation deadline. These are deployment
settings, not new repository defaults. Reverify the actual VPS before rollout.

The goal is one accepted release in which the administrator can switch rewrite
between MiniMax and Gemini by configuration and restart. Keep public JSON/NDJSON
interfaces, authentication, MiniMax T2A formats/voices/legacy compatibility, and
Google transcription unchanged. No automatic fallback, inference retry, hot
reload, Google TTS migration, or prompt revision belongs to this work.

Policies are already implemented and service-owned. Retain `current-v1`,
`hk-school-v1`, and `hk-school-v2`; the trial uses the existing candidate B policy.
See [policy rollout](rewrite-policy-rollout.md),
[specification](../reference/hk-school-rewrite-specification.md), and
[evaluation protocol](../evaluation/README.md). Do not reimplement a future policy
PR or replace the accepted 60 fixtures.

## Evidence and its limits

Earlier direct Gemini calls had intermittent long delays. On 2026-11-04 the
operator's global 60-case diagnostic completed 60/60 within a 60-second deadline,
without retries: median 1.5135 s, mean 2.8072 s, maximum 29.455 s. Two requests
exceeded 10 s (26.865 s and 29.455 s). This is one run, not sustained reliability
proof or bridge acceptance. Its policy B SHA256 was
`51f7fd33ac9c1b719124f524aa63d5a1906c816ec4b671fd7b252527381a260a`.
The diagnostic used fresh HTTPS connections, a Chinese user-message prefix,
temperature 0.15, 4096 output tokens and LOW thinking.

Known quality concerns remain: HKS-055 changed quoted answer forms; HKS-034 used
an accusatory translation of copying; HKS-040 narrowed an ambiguous button to a
right-click. Review these during any limited trial. Technical success does not
mean linguistic acceptance. Quote conversion cannot restore model-altered quotes.
No new paid calls are authorized by editing this plan.

## Remaining implementation gates

The existing #140 adapter accepts service instructions, uses ADC, handles JSON/SSE,
normalizes results and excludes thoughts. Before deployment:

- Integrate main's policy selection, quote conversion, adaptive MiniMax and security
  changes; preserve accepted behavior when Gemini is unselected.
- Reconcile the evaluated request with the adapter: the old adapter omits the
  diagnostic's temperature and user prefix. Test the chosen exact wire payload.
  Keep semantic rewrite policy in the service, not hardcoded into the adapter.
- Prevent the misleading `us` configuration from constructing the previously
  rejected `us-aiplatform.googleapis.com` hostname. Use verified `global` for this
  trial; syntax-valid regional names do not prove model availability.
- Verify all policy/provider combinations, ignored public overrides, streaming
  quote conversion, slow bodies/reasoning, deadlines, cancellation, concurrent
  isolation, credential refresh/recovery, quota errors and truncated answers.
- Run complete Node 22/24 tests, audit dependencies, review comments and verify
  unchanged T2A/transcription and authentication contracts.

## Intended operator profiles

| Setting | Production/rollback | Gemini trial |
|---|---|---|
| `REWRITE_PROVIDER` | `minimax` | `google-gemini` |
| `REWRITE_POLICY` | `hk-school-v2` | `hk-school-v2` |
| `REWRITE_MAX_COMPLETION_TOKENS` | `4096` | `4096` |
| `REWRITE_READY_INVOKE_TIMEOUT_MS` | `60000` | `60000` |
| MiniMax model/protocol/thinking | Existing M3/Anthropic/adaptive settings | Retain for rollback; must not affect Gemini |
| `REWRITE_GOOGLE_PROJECT` | Not needed by MiniMax | Operator's project |
| `REWRITE_GOOGLE_LOCATION` | Not needed by MiniMax | `global` |
| `REWRITE_GOOGLE_MODEL` | Not needed by MiniMax | `gemini-3.8-flash` |
| Google authentication | Existing Speech credentials unchanged | Existing ADC/service identity, with verified access |

LOW thinking is fixed in the existing Gemini adapter; it is not an administrator
reasoning-level selector. Preserve existing timeout and streaming settings and
verify their resolved values. Explicitly enable streaming for streaming acceptance.
The ready invocation deadline includes credential waiting inside the adapter;
queue/proxy/browser limits are separate. Passive readiness proves neither billing
access nor successful inference. Global does not guarantee Hong Kong residency.

## Ordered development and rollout

1. Reconcile #139 with main, preserving current policy specifications and fixtures.
2. Incorporate that branch into #140; resolve documentation conflicts without
   discarding current production behavior. Keep both PRs as drafts.
3. Complete the implementation gates above and prepare a pinned acceptance kit
   that checks running provider, policy, revision, credentials privately and Node.
4. In maintenance, back up code, dependencies, environment, systemd and proxy
   configuration with restrictive permissions and checksums. Deploy the candidate
   with MiniMax adaptive first; run automated and worksheet acceptance.
5. Switch to Gemini during maintenance, restart, and run bounded live JSON,
   streaming, concurrent, auth, T2A and transcription checks plus worksheet tests.
6. Demonstrate switching back to MiniMax adaptive successfully.
7. Only after explicit operator merge approval, merge #139 then retarget #140 to
   main, verify its diff and fresh CI, merge and compare final main's file tree
   with the accepted candidate before the VPS main switch.
8. Keep MiniMax as the production profile until the operator chooses a limited
   real-life Gemini trial with spending, latency and rollback criteria.

Future corrective PRs stack on the latest open tip. Do not merge the stack merely
because the direct-provider diagnostic passed. Every restart briefly interrupts
all services in the process. Failed activation restores the prior configuration;
a release rollback restores dependencies as well as code. Avoid `umask 077` for
application checkout/install; use it only for private backups/configuration.

## Costs, observation and retirement

Recheck current model pricing, project access and billing controls before paid
trials. Earlier screenshots showed a $1 Vertex cap and $2 alerts-only overall
budget; those are historical operator evidence, not a verified current allowance.
Vertex controls do not automatically cover Speech charges, and delayed enforcement
is not an exact combined spending guarantee. Do not disable project billing.

Observe provider/model/policy, latency, sanitized errors and available token usage
without logging student text or reasoning by default. Retain rollback credentials,
profiles and backups. No automatic retirement of MiniMax or current-v1 is planned;
retirement requires a separate decision and compatibility review.

## Step 3 implementation status

The increment stacked on #140 implements payload alignment, rejects invalid
multi-region hostnames, and adds combined policy/provider and deadline tests.
See the [alignment report](../reviews/2026-11-04-gemini-call-alignment.md).
The remaining gates above continue to govern broader validation and live acceptance;
implementation does not authorize switching production or merging the stack.
