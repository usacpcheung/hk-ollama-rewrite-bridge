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

## Testing Requirements
- Run `npm test` whenever provider logic changes.
- For route or API contract changes, include manual API smoke checks (for example `curl` validation of impacted endpoints and status codes).

## Documentation Sync
If environment variables, API endpoints, or request/response contracts change, update both of the following in the same change:
- `README.md`
- `docs/api-reference.md`

## Review Checklist Before Finalizing
- Input validation remains intact for modified request paths.
- Error mapping and reason-code behavior remain preserved unless intentionally updated and documented.
- OIDC/auth-related header handling is unchanged unless the change explicitly targets that behavior.
