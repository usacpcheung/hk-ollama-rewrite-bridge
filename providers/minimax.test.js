const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMinimaxSseFrame } = require('./minimax');

test('parses normal delta chunk into canonical response chunk', () => {
  const payload = JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ delta: { content: '你好' }, finish_reason: null }]
  });

  const parsed = parseMinimaxSseFrame(payload);

  assert.ok(parsed);
  assert.equal(parsed.chunk.response, '你好');
  assert.equal(parsed.chunk.done, false);
  assert.equal(parsed.chunk.object, 'chat.completion.chunk');
});

test('handles empty delta without emitting chunk', () => {
  const payload = JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ delta: { content: '' }, finish_reason: null }]
  });

  const parsed = parseMinimaxSseFrame(payload);

  assert.ok(parsed);
  assert.equal(parsed.chunk, null);
});

test('keeps final message content for fallback when delta is missing', () => {
  const payload = JSON.stringify({
    object: 'chat.completion',
    choices: [{ message: { content: '最終內容' }, finish_reason: 'stop' }]
  });

  const parsed = parseMinimaxSseFrame(payload);

  assert.ok(parsed);
  assert.equal(parsed.finalMessageContent, '最終內容');
  assert.equal(parsed.chunk.done, true);
  assert.equal(parsed.chunk.done_reason, 'stop');
});

test('returns null for malformed JSON frame', () => {
  const parsed = parseMinimaxSseFrame('{"choices":[{"delta":{"content":"x"}}]');
  assert.equal(parsed, null);
});
