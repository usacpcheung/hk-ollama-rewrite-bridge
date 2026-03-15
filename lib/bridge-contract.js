/**
 * Internal bridge contract shared by route handlers and provider adapters.
 *
 * This module is intentionally internal-only and does not change the public
 * `/rewrite` API payloads.
 *
 * ## Sync result shape
 * - Success: `{ ok: true, data: { output, response, usage?, doneReason? } }`
 *   - `output` is the normalized success object used by all providers:
 *     `{ text, artifacts?, meta? }`
 *   - `response` remains a compatibility alias for rewrite clients and mirrors
 *     `output.text`.
 * - Failure: `{ ok: false, error: { code, message, status } }`
 *
 * ## Stream event shape
 * - Text chunk/token event:
 *   `{ type: 'text', payload, text, raw? }`
 *   - `payload` supports structured JSON fields (for example
 *     `{ text, artifacts?, meta?, ... }`).
 *   - `text` remains a compatibility alias and mirrors `payload.text`.
 * - Done event: `{ type: 'done', reason?, usage?, raw? }`
 * - Error event: `{ type: 'error', error: { code, message, status }, raw? }`
 *
 * ## Lifecycle invariants
 * - Terminal `done` must be emitted at most once per stream.
 * - No text events may be emitted after terminal `done`.
 * - `usage` may appear on the final `done` event.
 */

function successResult({ output, response, usage, doneReason }) {
  const normalizedOutput = output
    ? {
        text: output.text ?? response ?? '',
        ...(output.artifacts !== undefined ? { artifacts: output.artifacts } : {}),
        ...(output.meta !== undefined ? { meta: output.meta } : {})
      }
    : {
        text: response ?? '',
        artifacts: [],
        meta: {}
      };

  return {
    ok: true,
    data: {
      output: normalizedOutput,
      response: normalizedOutput.text,
      ...(usage ? { usage } : {}),
      ...(doneReason ? { doneReason } : {})
    }
  };
}

function failureResult({ code, message, status }) {
  return {
    ok: false,
    error: { code, message, status }
  };
}

function streamTextEvent({ text, payload, raw }) {
  const normalizedPayload = payload
    ? {
        ...payload,
        ...(payload.text === undefined && text !== undefined ? { text } : {})
      }
    : {
        text: text ?? ''
      };

  return {
    type: 'text',
    payload: normalizedPayload,
    text: normalizedPayload.text ?? '',
    ...(raw !== undefined ? { raw } : {})
  };
}

function streamDoneEvent({ reason, usage, raw }) {
  return {
    type: 'done',
    ...(reason ? { reason } : {}),
    ...(usage ? { usage } : {}),
    ...(raw !== undefined ? { raw } : {})
  };
}

function streamErrorEvent({ error, raw }) {
  return {
    type: 'error',
    error,
    ...(raw !== undefined ? { raw } : {})
  };
}

module.exports = {
  successResult,
  failureResult,
  streamTextEvent,
  streamDoneEvent,
  streamErrorEvent
};
