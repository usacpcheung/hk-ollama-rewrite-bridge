function extractOllamaUsage(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const usage = {};
  const fields = [
    'prompt_eval_count',
    'prompt_eval_duration',
    'eval_count',
    'eval_duration',
    'total_duration',
    'load_duration'
  ];

  for (const field of fields) {
    if (typeof payload[field] === 'number') {
      usage[field] = payload[field];
    }
  }

  return Object.keys(usage).length > 0 ? usage : null;
}

function extractMinimaxText(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  return (
    payload.reply ||
    payload.choices?.[0]?.message?.content ||
    payload.choices?.[0]?.text ||
    ''
  );
}

function extractMinimaxDoneReason(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return payload.choices?.[0]?.finish_reason || payload.done_reason || null;
}

function normalizeProviderSyncResponse({ provider, payload, fallbackText = '' }) {
  if (provider === 'ollama') {
    return {
      text: typeof payload?.response === 'string' ? payload.response : fallbackText,
      usage: extractOllamaUsage(payload),
      doneReason: payload?.done_reason || null
    };
  }

  if (provider === 'minimax') {
    const text = extractMinimaxText(payload) || fallbackText;
    return {
      text,
      usage: payload?.usage || null,
      doneReason: extractMinimaxDoneReason(payload)
    };
  }

  return {
    text: fallbackText,
    usage: null,
    doneReason: null
  };
}

function normalizeProviderStreamTerminal({ provider, payload, fallbackText = '', fallbackDoneReason = 'stop' }) {
  const normalizedSync = normalizeProviderSyncResponse({ provider, payload, fallbackText });

  return {
    text: normalizedSync.text || fallbackText,
    usage: normalizedSync.usage,
    doneReason: normalizedSync.doneReason || fallbackDoneReason
  };
}

module.exports = {
  extractOllamaUsage,
  normalizeProviderSyncResponse,
  normalizeProviderStreamTerminal
};
