const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfiguration } = require('../providers/configuration/minimax-rewrite');
const { createMinimaxProvider } = require('../providers/minimax');
const model = { REWRITE_MINIMAX_MODEL: 'MiniMax-M3', REWRITE_MINIMAX_API_FORMAT: 'anthropic' };
test('thinking defaults off and explicit adaptive is captured independently of later env changes', () => {
  assert.equal(readConfiguration({ env: {} }).runtime.thinking, 'disabled');
  const env = { ...model, REWRITE_MINIMAX_THINKING: 'adaptive' };
  const config = readConfiguration({ env });
  env.REWRITE_MINIMAX_THINKING = 'disabled';
  assert.equal(config.runtime.thinking, 'adaptive');
  assert.equal(config.sources.minimaxThinking.key, 'REWRITE_MINIMAX_THINKING');
  assert.equal(readConfiguration({ env }).runtime.thinking, 'disabled');
});
test('invalid thinking values fail without echoing supplied values', () => {
  for (const value of ['', ' ', 'Adaptive', 'adaptive ', 'low', 'private-value', null]) {
    assert.throws(() => readConfiguration({ env: { ...model, REWRITE_MINIMAX_THINKING: value } }), { message: 'REWRITE_MINIMAX_THINKING must be disabled or adaptive' });
  }
});
test('adaptive is restricted to the tested model and protocol, including direct construction', () => {
  for (const [name, apiFormat] of [['MiniMax-M3', 'legacy-chat'], ['MiniMax-M3.1-Flash', 'anthropic'], ['M2-her', 'anthropic']]) {
    assert.throws(() => readConfiguration({ env: { REWRITE_MINIMAX_MODEL: name, REWRITE_MINIMAX_API_FORMAT: apiFormat, REWRITE_MINIMAX_THINKING: 'adaptive' } }), /requires MiniMax-M3 and anthropic/);
    assert.throws(() => createMinimaxProvider({ model: name, apiFormat, thinking: 'adaptive' }), /requires MiniMax-M3 and anthropic/);
  }
});
