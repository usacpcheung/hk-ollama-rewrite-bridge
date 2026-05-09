# AGENTS.md

## Purpose and Scope
This repository implements an Express-based rewrite bridge that converts Hong Kong colloquial Cantonese into formal Traditional Chinese. The codebase includes:
- Core bridge routes and request handling.
- Provider integrations (for example Ollama and Minimax) behind a compatible provider interface.
- Related frontend/widget integration surfaces used by consumers of the rewrite API.

This `AGENTS.md` applies to the full repository tree unless a deeper nested `AGENTS.md` defines stricter local rules.

## Safety Constraints
- Never hardcode secrets, API keys, tokens, or credentials in source, tests, or docs.
- Preserve authentication/authorization checks and gatekeeping behavior unless a change explicitly intends and documents auth logic updates.
- Keep service bind targets on localhost-only defaults unless an explicit, reviewed requirement changes network exposure.

## Change Rules
- Prefer small, focused diffs that solve the requested task directly.
- Avoid unrelated refactors, renames, or style-only churn in the same change.
- Maintain provider interface compatibility so existing provider selection and call paths continue to work.
- Preserve the bridge role as a centralized AI service interface: services may be backed by different providers, but callers should not need to know provider-specific details unless the public contract explicitly exposes them.

## Public API Compatibility Rules
Existing public behavior for `/rewrite`, `/api/rewrite`, `/t2a`, and `/api/t2a` must remain backward compatible unless the user explicitly requests a breaking API change.

Do not change the following without an explicit breaking-change request:
- Rewrite JSON success response field names: `ok`, `result`, and optional `usage`.
- Rewrite streaming NDJSON chunk shape: `response`, `done`, optional `done_reason`, optional `usage`, and optional `error`.
- T2A default binary response behavior, including default `response_mode`, raw audio bytes, `Content-Type`, and `Content-Disposition`.
- T2A `base64_json` response fields: `ok`, `audio`, `format`, `mime`, `contentType`, `size`, and `provider`.
- Existing validation status codes and error code strings, including `INVALID_INPUT`, `TOO_LONG`, `STREAMING_UNSUPPORTED`, and `MINIMAX_API_KEY_MISSING`.
- Existing authentication, authorization, trusted-header, and identity gatekeeping behavior.

When adding new services or providers:
- Keep provider-specific request/response details behind provider/service adapters.
- Do not alter existing rewrite or T2A route behavior as a side effect.
- Prefer additive endpoints, fields, env vars, and capabilities over changing existing ones.
- Make unsupported service/provider combinations fail with explicit controlled errors.

## Refactor Safety Rules
- Before separating service/provider runtime code, preserve current route behavior with HTTP-level contract tests from request to response.
- Internal contracts may evolve, but public contracts must remain stable.
- Refactors should move hardcoded provider logic into service/provider lifecycle or adapter layers without changing observable API behavior.
- If a refactor affects route handling, provider dispatch, admission control, readiness, warmup, streaming, output writing, or error mapping, update or add tests that prove rewrite and T2A compatibility is preserved.

## Testing Requirements
- Run `npm test` whenever provider logic changes.
- Run `npm test` whenever route behavior, service/provider runtime wiring, admission control, readiness/warmup logic, output writing, streaming, or API contract behavior changes.
- For route or API contract changes, include manual API smoke checks (for example `curl` validation of impacted endpoints and status codes).

## Documentation Sync
If environment variables, API endpoints, or request/response contracts change, update both of the following in the same change:
- `README.md`
- `docs/api-reference.md`

## Review Checklist Before Finalizing
- Input validation remains intact for modified request paths.
- Error mapping and reason-code behavior remain preserved unless intentionally updated and documented.
- OIDC/auth-related header handling is unchanged unless the change explicitly targets that behavior.
