# ADR 0001: Internal Bridge Contract

- Status: Accepted; amended to reflect current structured output
- Date: 2026-03-03
- Implementation reviewed: 2026-10-06 against main `2a453d040506b909ada41842eed3f7b2347dbf82`

## Context

Ollama, MiniMax and Google Speech adapters use a common internal result surface. The contract now carries structured output as well as the original rewrite text alias. Internal artifacts must not be mistaken for public HTTP fields.

## Decision

[`lib/bridge-contract.js`](../../../lib/bridge-contract.js) defines:

1. Sync success: `{ ok: true, data: { output, response, usage?, doneReason? } }`. `output` contains `{ text, artifacts?, meta? }`; `response` mirrors `output.text` for compatibility. Without explicit output, the helper supplies empty artifacts and metadata.
2. Sync failure: `{ ok: false, error: { code, message, status } }`.
3. Text event: `{ type: 'text', payload, text, raw? }`. `payload` may contain structured data; `text` mirrors `payload.text`.
4. Done event: `{ type: 'done', reason?, usage?, raw? }`.
5. Error event: `{ type: 'error', error: { code, message, status }, raw? }`.

Provider implementations are responsible for stream event order and completion. These helper functions create shapes; they do not enforce lifecycle state themselves. The public stream writer suppresses duplicate terminal done/error writes. The intended stream invariant is one terminal event and no text after it; do not assume the contract module independently validates that invariant.

## Public boundary

[`lib/service-output-writer.js`](../../../lib/service-output-writer.js) translates internal results into service-specific HTTP contracts:

- Rewrite JSON: `ok`, `result`, optional `usage`; internal artifacts/metadata are not exposed.
- Rewrite NDJSON: text in `response`, `done`, optional `done_reason` and `usage`, or a terminal `error`.
- T2A: raw audio bytes by default, or the established base64 JSON fields. Audio buffers live internally in artifacts/metadata.
- Transcription: its independent handler returns transcript, duration, request ID and timings, using the shared sync result for the Google adapter.

## Consequences and evidence

Transport parsing can evolve inside providers without making callers depend on provider event formats. The HTTP writer remains the authority for public fields; the internal structured output is not a promise of a generic public artifact API.

Relevant coverage: [`tests/providers/ollama.test.js`](../../../tests/providers/ollama.test.js), [`tests/providers/minimax.test.js`](../../../tests/providers/minimax.test.js), [`tests/service-output-writer.test.js`](../../../tests/service-output-writer.test.js), [`tests/api-contract.test.js`](../../../tests/api-contract.test.js), and [`tests/transcription.test.js`](../../../tests/transcription.test.js).
