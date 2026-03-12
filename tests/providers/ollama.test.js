const test = require('node:test');
const assert = require('node:assert/strict');

const { createOllamaProvider, extractOllamaUsage } = require('../../providers/ollama');
const { redactSensitiveValue } = require('../../providers/debug-logger');

function createJsonlStream(lines) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    }
  });
}

test('rewriteStream fails with invalid_json when stream line is malformed', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(createJsonlStream(['{"response":"ok"}\n', '{"response":bad}\n']), {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' }
  });

  const provider = createOllamaProvider({
    generateUrl: 'http://ollama.test/api/generate',
    psUrl: 'http://ollama.test/api/ps',
    model: 'qwen2.5:3b-instruct',
    keepAlive: '30m'
  });

  const result = await provider.rewriteStream({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, false);
  assert.equal(result.error.status, 502);
  assert.equal(result.error.code, 'OLLAMA_ERROR');
  assert.equal(result.error.message, 'Invalid model response');
});

test('rewriteStream fails with invalid_json when stream ends without done frame', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(createJsonlStream(['{"response":"partial"}\n']), {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' }
  });

  const provider = createOllamaProvider({
    generateUrl: 'http://ollama.test/api/generate',
    psUrl: 'http://ollama.test/api/ps',
    model: 'qwen2.5:3b-instruct',
    keepAlive: '30m'
  });

  const result = await provider.rewriteStream({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, false);
  assert.equal(result.error.status, 502);
  assert.equal(result.error.code, 'OLLAMA_ERROR');
  assert.equal(result.error.message, 'Invalid model response');
});


test('rewrite uses configured num_predict', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ response: 'ok', done: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const provider = createOllamaProvider({
    generateUrl: 'http://ollama.test/api/generate',
    psUrl: 'http://ollama.test/api/ps',
    model: 'qwen2.5:3b-instruct',
    keepAlive: '30m',
    maxCompletionTokens: 480
  });

  const result = await provider.rewrite({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, true);
  assert.equal(capturedBody.options.num_predict, 480);
});

test('rewriteStream uses configured num_predict', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(createJsonlStream(['{"response":"ok"}\n', '{"done":true,"done_reason":"stop"}\n']), {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' }
    });
  };

  const provider = createOllamaProvider({
    generateUrl: 'http://ollama.test/api/generate',
    psUrl: 'http://ollama.test/api/ps',
    model: 'qwen2.5:3b-instruct',
    keepAlive: '30m',
    maxCompletionTokens: 512
  });

  const result = await provider.rewriteStream({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, true);
  assert.equal(capturedBody.options.num_predict, 512);
});


test('extractOllamaUsage reads token/eval counters from completion payload', () => {
  const usage = extractOllamaUsage({
    prompt_eval_count: 14,
    eval_count: 9,
    eval_duration: 2200000,
    prompt_eval_duration: 1100000
  });

  assert.deepEqual(usage, {
    prompt_eval_count: 14,
    prompt_eval_duration: 1100000,
    eval_count: 9,
    eval_duration: 2200000
  });
});

test('redactSensitiveValue removes secrets from debug payloads', () => {
  const redacted = redactSensitiveValue({
    headers: {
      Authorization: 'Bearer abc',
      'X-Bridge-Auth': 'secret',
      'Content-Type': 'application/json'
    },
    apiKey: 'key-value',
    nested: { BRIDGE_INTERNAL_AUTH_SECRET: 'bridge-secret' }
  });

  assert.equal(redacted.headers.Authorization, '[REDACTED]');
  assert.equal(redacted.headers['X-Bridge-Auth'], '[REDACTED]');
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.BRIDGE_INTERNAL_AUTH_SECRET, '[REDACTED]');
  assert.equal(redacted.headers['Content-Type'], 'application/json');
});
