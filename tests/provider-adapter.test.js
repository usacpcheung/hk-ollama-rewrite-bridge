const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderAdapter } = require('../lib/provider-adapter');
const { createProvider } = require('../providers');

function createJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

test('invokeSync dispatches to service handler with merged payload', async () => {
  let captured = null;
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        sync: async (args) => {
          captured = args;
          return { ok: true, data: { response: 'ok' } };
        }
      }
    },
    mapError: (error) => error,
    checkReadiness: async () => ({ ready: true, error: null }),
    triggerWarmup: async () => ({ ok: true, data: null })
  });

  const result = await adapter.invokeSync({
    serviceId: 'rewrite',
    requestId: 'req-1',
    payload: { prompt: 'hello' },
    timeoutMs: 1234
  });

  assert.equal(result.ok, true);
  assert.deepEqual(captured, {
    requestId: 'req-1',
    timeoutMs: 1234,
    prompt: 'hello'
  });
});

test('invokeStream dispatches to service stream handler with chunk callback', async () => {
  const events = [];
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        stream: async ({ onChunk }) => {
          await onChunk({ type: 'text', text: 'x' });
          return { ok: true, data: { response: 'x' } };
        }
      }
    },
    mapError: (error) => error,
    checkReadiness: async () => ({ ready: true, error: null }),
    triggerWarmup: async () => ({ ok: true, data: null })
  });

  const result = await adapter.invokeStream({
    serviceId: 'rewrite',
    requestId: 'req-2',
    payload: { prompt: 'hello' },
    timeoutMs: 1234,
    onChunk: async (event) => {
      events.push(event);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'text');
});

test('adapter resolves minimax t2a requests through the t2a service handler', async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return createJsonResponse(200, {
      data: {
        audio: 'aa'.repeat(64),
        format: 'mp3'
      }
    });
  };

  try {
    const adapter = createProviderAdapter(createProvider({
      serviceConfig: {
        id: 't2a',
        provider: {
          selected: 'minimax',
          runtime: {
            apiUrl: 'http://minimax.test/v1/t2a_v2',
            model: 'speech-02-hd'
          }
        }
      },
      minimaxApiKey: 'test-key',
      debugLog: () => {}
    }));

    const result = await adapter.invokeSync({
      serviceId: 't2a',
      requestId: 'req-t2a',
      payload: {
        text: '你好',
        voice: { voiceId: 'voice-1' },
        audio: { format: 'mp3' }
      },
      timeoutMs: 500
    });

    assert.equal(result.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://minimax.test/v1/t2a_v2');
    assert.equal(JSON.parse(fetchCalls[0].options.body).text, '你好');
  } finally {
    global.fetch = originalFetch;
  }
});

test('rewrite requests still resolve to the current ollama rewrite handler', async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return createJsonResponse(200, {
      response: 'formalized',
      done: true,
      done_reason: 'stop'
    });
  };

  try {
    const adapter = createProviderAdapter(createProvider({
      serviceConfig: {
        id: 'rewrite',
        provider: {
          selected: 'ollama',
          runtime: {
            generateUrl: 'http://ollama.test/api/generate',
            psUrl: 'http://ollama.test/api/ps',
            model: 'llama3'
          }
        }
      },
      ollamaUrl: 'http://ollama.default/api/generate',
      ollamaPsUrl: 'http://ollama.default/api/ps',
      ollamaKeepAlive: '5m',
      debugLog: () => {}
    }));

    const result = await adapter.invokeSync({
      serviceId: 'rewrite',
      requestId: 'req-ollama-rewrite',
      payload: { prompt: '原文' },
      timeoutMs: 500
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.response, 'formalized');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://ollama.test/api/generate');
    assert.equal(JSON.parse(fetchCalls[0].options.body).prompt, '原文');
  } finally {
    global.fetch = originalFetch;
  }
});

test('rewrite requests still resolve to the current minimax rewrite handler', async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return createJsonResponse(200, {
      choices: [
        {
          message: { content: '正式中文' },
          finish_reason: 'stop'
        }
      ]
    });
  };

  try {
    const adapter = createProviderAdapter(createProvider({
      serviceConfig: {
        id: 'rewrite',
        provider: {
          selected: 'minimax',
          runtime: {
            apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
            model: 'MiniMax-Text-01'
          }
        }
      },
      minimaxApiKey: 'test-key',
      minimaxSystemPrompt: 'system',
      minimaxUserTemplate: '{{prompt}}',
      debugLog: () => {}
    }));

    const result = await adapter.invokeSync({
      serviceId: 'rewrite',
      requestId: 'req-minimax-rewrite',
      payload: { prompt: '原文' },
      timeoutMs: 500
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.response, '正式中文');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://minimax.test/v1/text/chatcompletion_v2');
    assert.equal(JSON.parse(fetchCalls[0].options.body).stream, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('unsupported non-rewrite service requests fail with a controlled provider-service error', async () => {
  const adapter = createProviderAdapter(createProvider({
    serviceConfig: {
      id: 't2a',
      provider: {
        selected: 'ollama',
        runtime: {
          generateUrl: 'http://ollama.test/api/generate',
          psUrl: 'http://ollama.test/api/ps',
          model: 'llama3'
        }
      }
    },
    ollamaUrl: 'http://ollama.default/api/generate',
    ollamaPsUrl: 'http://ollama.default/api/ps',
    ollamaKeepAlive: '5m',
    debugLog: () => {}
  }));

  const result = await adapter.invokeSync({
    serviceId: 't2a',
    requestId: 'req-unsupported',
    payload: { text: '你好' },
    timeoutMs: 500
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'UNSUPPORTED_PROVIDER_SERVICE',
      message: 'Provider "ollama" does not support sync t2a requests',
      status: 501
    }
  });
});

test('legacy rewrite shim maps to invokeSync rewrite service', async () => {
  let seen = null;
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        sync: async (args) => {
          seen = args;
          return { ok: true, data: { response: 'ok' } };
        }
      }
    },
    mapError: (error) => error,
    checkReadiness: async () => ({ ready: true, error: null }),
    triggerWarmup: async () => ({ ok: true, data: null })
  });

  const result = await adapter.rewrite({
    requestId: 'legacy-1',
    prompt: 'p',
    systemPrompt: 's',
    userContent: 'u',
    timeoutMs: 99
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, {
    requestId: 'legacy-1',
    timeoutMs: 99,
    prompt: 'p',
    systemPrompt: 's',
    userContent: 'u'
  });
});

test('legacy rewriteStream shim maps to invokeStream rewrite service', async () => {
  let seen = null;
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        stream: async (args) => {
          seen = args;
          return { ok: true, data: { response: 'ok' } };
        }
      }
    },
    mapError: (error) => error,
    checkReadiness: async () => ({ ready: true, error: null }),
    triggerWarmup: async () => ({ ok: true, data: null })
  });

  const onChunk = async () => {};
  const result = await adapter.rewriteStream({
    requestId: 'legacy-2',
    prompt: 'p',
    systemPrompt: 's',
    userContent: 'u',
    timeoutMs: 77,
    onChunk
  });

  assert.equal(result.ok, true);
  assert.equal(seen.requestId, 'legacy-2');
  assert.equal(seen.timeoutMs, 77);
  assert.equal(seen.onChunk, onChunk);
  assert.equal(seen.prompt, 'p');
});

test('hasStreamHandler reflects availability and invokeStream returns null when unsupported', async () => {
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        sync: async () => ({ ok: true, data: { response: 'ok' } })
      }
    },
    mapError: (error) => error,
    checkReadiness: async () => ({ ready: true, error: null }),
    triggerWarmup: async () => ({ ok: true, data: null })
  });

  assert.equal(adapter.hasStreamHandler({ serviceId: 'rewrite' }), false);
  const result = await adapter.invokeStream({
    serviceId: 'rewrite',
    requestId: 'req-3',
    payload: { prompt: 'hi' },
    timeoutMs: 100,
    onChunk: async () => {}
  });
  assert.equal(result, null);
});

test('legacy rewriteStream shim remains null when rewrite stream handler is unavailable', () => {
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        sync: async () => ({ ok: true, data: { response: 'ok' } })
      }
    },
    mapError: (error) => error,
    checkReadiness: async () => ({ ready: true, error: null }),
    triggerWarmup: async () => ({ ok: true, data: null })
  });

  assert.equal(adapter.rewriteStream, null);
});

test('legacy rewriteStream shim is a function when rewrite stream handler exists', () => {
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        sync: async () => ({ ok: true, data: { response: 'ok' } }),
        stream: async () => ({ ok: true, data: { response: 'ok' } })
      }
    },
    mapError: (error) => error,
    checkReadiness: async () => ({ ready: true, error: null }),
    triggerWarmup: async () => ({ ok: true, data: null })
  });

  assert.equal(typeof adapter.rewriteStream, 'function');
});
