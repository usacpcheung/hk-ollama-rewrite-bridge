# Independent rewrite policy rollout

Status: implementation and offline engineering review; live language acceptance
pending. Decision accepted 2026-10-24. This supersedes the policy PR's dependency
on Gemini described in open draft PR #139; it does not authorize merging Gemini.

## Baseline and branch sequence

Branch directly from main `cb610fc00dad33b829a04beb894d12e5977f92df`.
The operator reported automated and worksheet web acceptance on that VPS revision,
with MiniMax rewrite/T2A and Google Speech transcription. This is operator evidence,
not a new remote inspection. Gemini drafts #139 and #140 remain open and paused:
VPS direct and bridge tests had intermittent 60-second timeouts; US multi-region
also timed out once in ten requests. Geography alone is not an established cause.

This PR implements only policy selection and its documentation/tests. It carries
over the approved specification and all 60 evaluation cases from #139 without
Gemini source, dependencies or credentials. The obsolete Gemini-dependent sequence
is not copied into active main documentation. If Gemini resumes, reconcile its
planning documents and duplicate fixtures against this work before merging it.

Further policy corrections stack on this PR's branch while it remains open.
Verify the latest branch/base before opening any increment. Keep production on
accepted main until explicit maintenance-window deployment; merging requires
operator approval. Do not retarget or merge Gemini as part of this rollout.

## Runtime contract

- `REWRITE_POLICY` absent or `current-v1`: exact original instruction text.
- `REWRITE_POLICY=hk-school-v1`: service-owned school policy implementing the
  [specification](../reference/hk-school-rewrite-specification.md).
- Invalid, empty, padded or differently cased IDs fail startup with a fixed error.
- Resolve once at startup. Changing environment requires restart. No hot reload.
- Provider selection is independent. Existing MiniMax and Ollama share this policy
  path; future adapters consume the same service instructions. No provider default
  change, automatic fallback or extra model calls.
- Both aliases and JSON/NDJSON modes keep validation, authentication, admission,
  timeouts, usage/output envelopes and OpenCC conversion. The school prompt is
  longer and can increase input-token cost; measure latency and quality rather than
  assuming improvement. Existing input and output budgets are not raised. Public body/query/header
  policy-like fields cannot override server selection.
- T2A and transcription do not use rewrite policy and remain unchanged.

## Acceptance sequence

1. Review the prompt against the approved specification. Run offline configuration,
   request-boundary, provider translation and full regression tests. These use
   synthetic upstreams and do not certify linguistic correctness.
2. Prepare a bounded evaluation runner separately. Start with the ten suggested
   cases in the [rubric](../evaluation/README.md), then review all 60 school-policy
   outputs. Compare current-v1 on useful subsets. Record provider/model, prompt
   digest, settings, revision, latency, output, usage and human verdicts. No paid
   calls without explicit authorization; no automatic retries. Current production
   must not be reconfigured for preparation. Gemini is not required.
3. Before VPS rollout, pin the exact candidate and acceptance kit. Verify running
   revision/environment and take source, dependencies, systemd, proxy and private
   configuration backups with checksums. Prepare rollback first. Use umask 022 for
   git checkout/npm ci so the service user can read application files; keep backup
   directories 0700 and secret files 0600 separately. Check access as the service
   user. Do not recursively make credentials or backups world-readable.
4. During maintenance, stop/drain the bridge, deploy exact code and locked
   dependencies with MiniMax/current-v1, restart and poll actual HTTP health and
   readiness (systemd active alone is insufficient). Run the pinned automated
   acceptance and normal worksheet/OIDC/rewrite/T2A/transcription tests.
5. Only after human language acceptance, select hk-school-v1, restart and repeat
   acceptance, including recording → transcription → rewrite. These restarts
   briefly affect all services in the process. End maintenance only on success.
6. Observe quality for an operator-chosen period of a few months. Roll back via
   current-v1 plus restart if needed. Code rollback must also restore matching
   dependencies/configuration and verify HTTP health. Keep original credentials,
   backups and reports securely. Retiring current-v1 requires a separate approved
   PR; there is no automatic expiry.

No new deployment or paid evaluation was performed by this implementation PR.
