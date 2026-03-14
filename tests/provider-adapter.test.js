const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderAdapter } = require('../lib/provider-adapter');

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
