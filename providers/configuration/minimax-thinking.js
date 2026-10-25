// Provider-specific capability validation; never inferred from public request fields.
function resolveMinimaxThinking(value = 'disabled', { model, apiFormat } = {}) {
  if (!['disabled', 'adaptive'].includes(value)) {
    throw new Error('REWRITE_MINIMAX_THINKING must be disabled or adaptive');
  }
  if (value === 'adaptive' && (model !== 'MiniMax-M3' || apiFormat !== 'anthropic')) {
    throw new Error('Adaptive MiniMax thinking requires MiniMax-M3 and anthropic API format');
  }
  return value;
}
module.exports = { resolveMinimaxThinking };
