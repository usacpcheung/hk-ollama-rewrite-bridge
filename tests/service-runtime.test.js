const test = require('node:test');
const assert = require('node:assert/strict');

const { createServiceRuntimes } = require('../lib/service-runtime');
const { createProviderAdapter } = require('../lib/provider-adapter');
const { createProvider } = require('../providers');

function createRegistry(services) {
  return {
    list() {
      return services;
    }
  };
}

function createService({ id, providerName, capabilities = {}, timeouts = {} }) {
  return {
    id,
    provider: {
      selected: providerName,
      runtime: {}
    },
    capabilities,
    timeouts
  };
}

test('creates service runtimes with provider names, adapters, capabilities, and timeouts', async () => {
  const rewriteService = createService({
    id: 'rewrite',
    providerName: 'provider-a',
    capabilities: { streaming: true },
    timeouts: { readyMs: 100, coldMs: 200 }
  });
  const t2aService = createService({
    id: 't2a',
    providerName: 'provider-b',
    capabilities: { streaming: false },
    timeouts: { invokeMs: 300 }
  });
  const seenProviderOptions = [];

  const runtimes = createServiceRuntimes({
    serviceRegistry: createRegistry([rewriteService, t2aService]),
    createProviderAdapter,
    createProviderOptions: ({ service }) => {
      seenProviderOptions.push(service.id);
      return { optionMarker: service.id };
    },
    createProvider: ({ serviceConfig, optionMarker }) => ({
      services: {
        [serviceConfig.id]: {
          sync: async ({ requestId }) => ({
            ok: true,
            data: { response: `${serviceConfig.id}:${optionMarker}:${requestId}` }
          })
        }
      },
      mapError: (error) => error,
      checkReadiness: async () => ({ ready: true, error: null }),
      triggerWarmup: async () => ({ ok: true, data: null }),
      getInfo: () => ({ provider: serviceConfig.provider.selected })
    })
  });

  const rewriteRuntime = runtimes.get('rewrite');
  const t2aRuntime = runtimes.get('t2a');

  assert.equal(rewriteRuntime.service, rewriteService);
  assert.equal(rewriteRuntime.providerName, 'provider-a');
  assert.deepEqual(rewriteRuntime.capabilities, { streaming: true });
  assert.deepEqual(rewriteRuntime.timeouts, { readyMs: 100, coldMs: 200 });
  assert.equal(typeof rewriteRuntime.adapter.invokeSync, 'function');

  assert.equal(t2aRuntime.service, t2aService);
  assert.equal(t2aRuntime.providerName, 'provider-b');
  assert.deepEqual(t2aRuntime.capabilities, { streaming: false });
  assert.deepEqual(t2aRuntime.timeouts, { invokeMs: 300 });

  assert.deepEqual(seenProviderOptions, ['rewrite', 't2a']);
  assert.deepEqual(runtimes.list().map((runtime) => runtime.service.id), ['rewrite', 't2a']);

  const result = await rewriteRuntime.adapter.invokeSync({
    serviceId: 'rewrite',
    requestId: 'req-1',
    timeoutMs: 100
  });
  assert.equal(result.data.response, 'rewrite:rewrite:req-1');
});

test('returns null for unknown runtime ids', () => {
  const runtimes = createServiceRuntimes({
    serviceRegistry: createRegistry([]),
    createProviderAdapter,
    createProvider: () => ({})
  });

  assert.equal(runtimes.get('missing'), null);
});

test('preserves controlled unsupported provider-service behavior through adapters', async () => {
  const runtimes = createServiceRuntimes({
    serviceRegistry: createRegistry([
      {
        id: 't2a',
        provider: {
          selected: 'ollama',
          runtime: {
            generateUrl: 'http://ollama.test/api/generate',
            psUrl: 'http://ollama.test/api/ps',
            model: 'llama3'
          }
        },
        capabilities: { streaming: false },
        timeouts: { invokeMs: 500 }
      }
    ]),
    createProviderAdapter,
    createProvider,
    createProviderOptions: () => ({
      ollamaUrl: 'http://ollama.default/api/generate',
      ollamaPsUrl: 'http://ollama.default/api/ps',
      ollamaKeepAlive: '5m'
    })
  });

  const result = await runtimes.get('t2a').adapter.invokeSync({
    serviceId: 't2a',
    requestId: 'req-unsupported',
    payload: { text: 'hello' },
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
