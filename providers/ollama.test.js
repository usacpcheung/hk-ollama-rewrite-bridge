const test = require('node:test');
const assert = require('node:assert/strict');

const { createOllamaProvider } = require('./ollama');

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
