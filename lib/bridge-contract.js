/**
 * Internal bridge contract shared by route handlers and provider adapters.
 *
 * This module is intentionally internal-only and does not change the public
 * `/rewrite` API payloads.
 *
 * ## Sync result shape
 * - Success: `{ ok: true, data: { response, usage?, doneReason? } }`
 * - Failure: `{ ok: false, error: { code, message, status } }`
 *
 * ## Stream event shape
 * - Text chunk/token event: `{ type: 'text', text, raw? }`
 * - Done event: `{ type: 'done', reason?, usage?, raw? }`
 * - Error event: `{ type: 'error', error: { code, message, status }, raw? }`
 *
 * ## Lifecycle invariants
 * - Terminal `done` must be emitted at most once per stream.
 * - No text events may be emitted after terminal `done`.
 * - `usage` may appear on the final `done` event.
 */

function successResult({ response, usage, doneReason }) {
  return {
    ok: true,
    data: {
      response,
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

function streamTextEvent({ text, raw }) {
  return {
    type: 'text',
    text,
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
