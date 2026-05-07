# ADR 0002: Service and Provider Runtime Boundary

- Status: Proposed
- Date: 2026-05-07

## Context

The bridge currently serves rewrite and T2A traffic for downstream applications. The public `/rewrite`, `/api/rewrite`, `/t2a`, and `/api/t2a` contracts are already consumed by other programs and must remain stable.

The codebase has useful layers already:

1. Service definitions in `services/`.
2. Provider integrations in `providers/`.
3. A generic provider adapter in `lib/provider-adapter.js`.
4. A normalized internal result/event contract in `lib/bridge-contract.js`.

However, some runtime behavior in `server.js` still assumes provider-specific cases, especially rewrite readiness/warmup logic around Ollama and Minimax. Future services, such as image generation, should be able to use different providers without adding more route-level provider branching.

## Decision

Refactor toward a service runtime boundary where each service resolves:

1. Its selected provider.
2. Its provider adapter.
3. Its capabilities.
4. Its timeouts.
5. Its lifecycle behavior, such as readiness and warmup.
6. Its output writer behavior, when the public response is not plain JSON text.

The intended runtime shape is:

```js
{
  service,
  providerName,
  adapter,
  capabilities,
  timeouts,
  lifecycle
}
```

Route handlers should call this runtime boundary instead of hardcoding provider-specific behavior. Provider-specific transport details, response parsing, and unsupported capability handling should remain behind provider/service adapters.

## Compatibility Requirements

This refactor must not change current public API behavior unless a breaking change is explicitly requested.

The following contracts are protected:

1. Rewrite JSON success response: `ok`, `result`, and optional `usage`.
2. Rewrite streaming NDJSON chunks: `response`, `done`, optional `done_reason`, optional `usage`, and optional `error`.
3. T2A default binary response: raw audio bytes with stable `Content-Type` and `Content-Disposition`.
4. T2A `base64_json` response: `ok`, `audio`, `format`, `mime`, `contentType`, `size`, and `provider`.
5. Existing validation/auth/error code behavior.

HTTP-level contract tests should be added or updated before route/runtime refactors and must pass before finalizing the refactor.

## Consequences

- Adding image generation or another AI service becomes an additive service/runtime change instead of another provider-specific branch in `server.js`.
- Different services can use different providers at the same time, such as rewrite on a new text provider while T2A remains on Minimax.
- Readiness, warmup, admission, and output writing can evolve per service/provider without changing caller-visible behavior.
- The first implementation step should extract runtime wiring without changing route response shapes, provider payloads, auth behavior, or documentation for public endpoints.
