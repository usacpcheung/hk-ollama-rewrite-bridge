# Candidate B limited production trial

This is an operator-authorized trial, not full language acceptance. Keep main and
Gemini PRs unchanged until separately approved. Production is last reported on
main cb610fc00dad33b829a04beb894d12e5977f92df; verify its actual state first.

## Trial configuration

- Keep REWRITE_PROVIDER=minimax and the existing MiniMax-M3/Anthropic configuration.
- Select REWRITE_POLICY=hk-school-v2 (exact evaluated prompt B).
- Keep thinking disabled through the existing adapter; no reasoning experiment.
- Retain existing production limits/timeouts/auth and T2A/transcription settings.
  The reported production output limit is 4096 versus 1024 in evaluation. Record
  that difference; trial results do not represent identical evaluation settings.
- This process serves all services: deployment and configuration rollback require
  a brief maintenance restart. It is not a per-user canary or zero-downtime switch.

## Before deployment

1. Verify current SHA, clean checkout, running service cwd/user/env file, actual
   HTTP health/readiness and selected provider. Do not print credentials.
2. Pin the reviewed PR head and matching acceptance kit. Do not deploy a moving
   branch tip or use an acceptance kit pinned to another revision.
3. Back up source, installed dependencies, effective systemd unit, proxy and private
   environment/credentials. Use root-only directories, checksum manifests and
   validate archives. Save the exact baseline environment for configuration rollback.
4. Prepare rollback commands before stopping service. For git checkout/npm ci use
   umask 022; keep secrets/backups private separately. Verify service-user access.

## During maintenance

1. Restrict traffic and drain active requests. Stop the bridge; deploy the pinned
   candidate and locked dependencies, preserving the baseline configuration.
2. Restart and poll actual /healthz and /readyz with a bounded wait. systemd active
   alone is insufficient. Verify the running PID/checkout/environment and run the
   candidate-pinned acceptance preflight with MiniMax/current-v1.
3. Set only REWRITE_POLICY=hk-school-v2 in the administrator environment file,
   restart and verify startup log rewritePolicy and actual health/readiness.
4. Run bounded live acceptance on the pinned candidate and manually verify normal
   worksheet login, rewrite, streaming, T2A and recording/transcription/rewrite.
   Infrastructure success is separate from language quality. Check example quotes,
   mixed language and negation before ending maintenance.
5. Record candidate SHA, policy/model and token limit. Do not merge or pull another
   revision automatically during the observation period.

## Observation and rollback

Review a small sample of real use, with permission and without collecting sensitive
student text unnecessarily. Watch meaning changes, quoted wording, colloquial
residue, latency/timeouts and provider usage/cost. Candidate B is known to sometimes
change quoted words and obligation/uncertainty. Users must review generated text.

For policy rollback on this candidate: restore REWRITE_POLICY=current-v1 (or remove
that setting), restart in maintenance, then verify HTTP health/readiness and a real
rewrite. Existing provider configuration is retained. Do not use hk-school-v1 as the
production baseline: that is the earlier experimental school policy, not current-v1.

If the release itself is unhealthy: stop it, restore the exact baseline code,
matching dependency archive and saved environment, repair only application access
as needed, restart and verify actual HTTP health and service behavior. A systemd
restart-loop is not successful rollback. Preserve reports for diagnosis.

The observation duration and merge decision remain with the operator. Ending the
trial does not automatically retire current-v1 or authorize Gemini deployment.
