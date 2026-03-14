# ADR 0001: Internal Bridge Contract for Provider Results and Stream Events

- Status: Accepted
- Date: 2026-03-13

## Context

The bridge has multiple provider adapters (Ollama, Minimax) that feed a single `/rewrite` route. Historically, adapters emitted slightly different stream event payloads (`token`, `chunk`, `final`) and assembled success/failure objects inline. This made lifecycle handling and internal compatibility harder to reason about.

## Decision

Introduce a shared internal contract module at `lib/bridge-contract.js` that defines:

1. Sync result shape:
   - Success: `{ ok: true, data: { response, usage?, doneReason? } }`
   - Failure: `{ ok: false, error: { code, message, status } }`
2. Stream event shape used by all providers:
   - text chunk/token event: `{ type: 'text', text, raw? }`
   - done event: `{ type: 'done', reason?, usage?, raw? }`
   - error event: `{ type: 'error', error: { code, message, status }, raw? }`
3. Lifecycle invariants:
   - terminal `done` emitted once,
   - no text events after done,
   - usage may appear on final done event.

## Consequences

- Provider adapters can evolve transport parsing independently while presenting one normalized event surface.
- Route logic can enforce stream lifecycle invariants centrally.
- Public `/rewrite` response contract remains unchanged (NDJSON stream chunks and non-stream JSON format are preserved).
