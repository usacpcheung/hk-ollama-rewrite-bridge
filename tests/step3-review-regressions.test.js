const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderRegistry } = require('../lib/provider-registry');
const { createProviderAdapter } = require('../lib/provider-adapter');
const { successResult } = require('../lib/bridge-contract');
const { extractT2AAudioOutput, writeT2AOutput } = require('../lib/service-output-writer');
const { fixture, json } = require('../test-support/server-fixture');

function response() {
  return { headers: {}, status(code) { this.code = code; return this; },
    set(key, value) { this.headers[key] = value; },
    end(value) { this.bytes = value; }, json(value) { this.body = value; } };
}

test('registered stateful service methods retain their receiver across concurrent sync and streaming calls', async () => {
  class Handlers {
    #prefix;
    constructor(prefix) { this.#prefix = prefix; }
    async sync({ text }) {
      await new Promise(resolve => setImmediate(resolve));
      return successResult({ response: this.#prefix + text });
    }
    async stream({ text, onChunk }) {
      await onChunk({ type: 'text', text: this.#prefix + text });
      return this.sync({ text });
    }
  }
  const registry = createProviderRegistry(['a', 'b'].map(provider => ({
    provider, serviceId: 'rewrite', capabilities: { sync: true, streaming: true },
    create: () => ({ services: { rewrite: Object.freeze(new Handlers(provider)) }, mapError: error => error })
  })));
  const adapters = ['a', 'b'].map(selected => createProviderAdapter(registry.create({
    serviceConfig: { id: 'rewrite', provider: { selected } }
  })));
  await Promise.all(Array.from({ length: 40 }, async (_, i) => {
    const adapter = adapters[i % 2], expected = ['a', 'b'][i % 2] + i;
    const events = [];
    const result = i % 3 === 0
      ? await adapter.invokeStream({ serviceId: 'rewrite', payload: { text: String(i) }, onChunk: event => events.push(event) })
      : await adapter.invokeSync({ serviceId: 'rewrite', payload: { text: String(i) } });
    assert.equal(result.data.response, expected);
    if (events.length) assert.equal(events[0].text, expected);
  }));
});

test('direct legacy adapter methods also retain their provider receiver', async () => {
  class Provider {
    #name = 'legacy';
    async rewrite() { return successResult({ response: this.#name }); }
    async rewriteStream({ onChunk }) { await onChunk(this.#name); return this.rewrite(); }
    mapError(error) { return error; }
  }
  const adapter = createProviderAdapter(new Provider());
  assert.equal((await adapter.rewrite({})).data.response, 'legacy');
  const events = [];
  assert.equal((await adapter.rewriteStream({ onChunk: text => events.push(text) })).data.response, 'legacy');
  assert.deepEqual(events, ['legacy']);
});

test('mixed artifacts use selected audio metadata in binary and JSON responses', () => {
  for (const format of ['mp3', 'wav', 'pcm']) for (const responseMode of ['binary', 'base64_json']) {
    const contentType = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm' }[format];
    const bytes = Buffer.from('audio bytes');
    const output = { artifacts: [
      { kind: 'transcript', format: 'txt', contentType: 'text/plain', data: 'captions' },
      { kind: 'audio', format, mime: contentType, data: bytes }
    ] };
    const res = response();
    assert.equal(writeT2AOutput({ res, output, responseMode }).ok, true);
    if (responseMode === 'binary') {
      assert.equal(res.bytes, bytes);
      assert.equal(res.headers['Content-Type'], contentType);
      assert.equal(res.headers['Content-Disposition'], `inline; filename="speech.${format}"`);
    } else {
      assert.equal(res.body.format, format);
      assert.equal(res.body.mime, contentType);
      assert.equal(res.body.audio, bytes.toString('base64'));
    }
  }
});

test('audio metadata is canonical, consistent, and isolated from unrelated bytes', () => {
  const data = Buffer.from('audio');
  const extract = fields => extractT2AAudioOutput({ artifacts: [{ kind: 'audio', data, ...fields }] });
  assert.equal(extract({ format: 'wav' }).contentType, 'audio/wav');
  assert.equal(extract({ mime: ' Audio/X-Wav; ignored=value ' }).format, 'wav');
  assert.equal(extract({}).format, 'mp3', 'retain the legacy no-metadata default');
  for (const fields of [
    { format: 'wav', contentType: 'audio/mpeg' }, { format: 'constructor' },
    { format: 'wav\r\nX-Injected: value' }, { mime: 'text/html' },
    { format: {} }, { mime: [] }, { mime: 'audio/wav', contentType: 'audio/pcm' }
  ]) {
    const res = response();
    const result = writeT2AOutput({ res, output: { artifacts: [{ kind: 'audio', data, ...fields }] }, responseMode: 'binary' });
    assert.equal(result.error.status, 502);
    assert.deepEqual(res.headers, {});
    assert.equal(res.bytes, undefined);
  }
  const legacy = extractT2AAudioOutput({ meta: { audio: data, format: 'pcm' },
    artifacts: [{ kind: 'audio', data: Buffer.from('different audio'), format: 'wav' }] });
  assert.equal(legacy.audioBuffer, data);
  assert.equal(legacy.format, 'pcm');
  assert.equal(extractT2AAudioOutput({ artifacts: {} }).error.status, 502);
  assert.equal(extractT2AAudioOutput({ meta: { format: 'mp3' },
    artifacts: [{ kind: 'audio', data, format: 'wav' }] }).error.status, 502);
});

for (const protocol of ['ollama', 'legacy', 'anthropic']) {
  test(`${protocol}: malformed stream fields fail once on both aliases, then capacity recovers`, { timeout: 20000 }, async t => {
    let bad;
    const f = await fixture(t, {
      env: { REWRITE_PROVIDER: protocol === 'ollama' ? 'ollama' : 'minimax',
        REWRITE_MINIMAX_API_FORMAT: protocol === 'anthropic' ? 'anthropic' : 'legacy-chat',
        REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD: '100',
        MINIMAX_MAX_CONCURRENCY: '1', OLLAMA_MAX_CONCURRENCY: '1' },
      handle(req, res, body) {
        if (req.url === '/ps') { json(res, 200, { models: [{ name: 'qwen2.5:3b-instruct' }] }); return true; }
        if (req.url === '/t2a') return false;
        if (protocol === 'ollama') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.end([{ response: 'valid prefix', done: false }, ...(bad ? [bad] : []),
            { response: '', done: true }].map(value => JSON.stringify(value) + '\n').join(''));
        } else if (protocol === 'legacy') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end([{ choices: [{ delta: { role: 'assistant', content: null } }] },
            { choices: [{ delta: { content: 'valid prefix' } }] }, ...(bad ? [bad] : []),
            { choices: [{ finish_reason: 'stop' }] }].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end([{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'valid prefix' } },
            ...(bad ? [bad] : []), { type: 'message_stop' }]
            .map(value => 'event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n').join(''));
        }
        return true;
      }
    });
    const variants = protocol === 'ollama'
      ? [{ response: {} }, { response: 7 }, { done: 'false' }, { done: true, done_reason: {} }]
      : protocol === 'legacy'
        ? [{ choices: [{ delta: { content: {} } }] }, { choices: [{ message: { content: [] }, finish_reason: 'stop' }] },
          { choices: [{ delta: 'invalid' }] }, { choices: [{ finish_reason: {} }] }]
        : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 7 } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } },
          { type: 'message_delta', delta: { stop_reason: {} } },
          { type: 'content_block_delta', index: 0, delta: null },
          { type: 'message_delta', delta: [] }];
    for (const route of ['/rewrite', '/api/rewrite']) {
      for (bad of variants) {
        const response = await f.request(route, { body: { text: 'source', stream: true } });
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        assert.equal(response.status, 200, 'stream headers have already been sent');
        assert.equal(events.at(-1).error?.status, 502, JSON.stringify(events));
        assert.equal(events.filter(event => event.done).length, 1);
        assert.equal(events.some(event => event.done && !event.error), false);
      }
      bad = null;
      const recovered = await f.request(route, { body: { text: 'source', stream: true } });
      const events = (await recovered.text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).done, true);
      assert.equal(events.at(-1).error, undefined);
      assert.equal((await f.request('/t2a')).status, 200);
    }
  });
}

test('throwing numeric input produces field-specific 400 errors on both T2A aliases without provider calls', { timeout: 15000 }, async t => {
  const f = await fixture(t, { env: { RATE_LIMIT_T2A_AUTH_MAX_REQUESTS: '100' } });
  for (const route of ['/t2a', '/api/t2a']) for (const field of ['speed', 'volume', 'pitch', 'sample_rate', 'bitrate']) {
    for (const value of [{ toString: 'invalid' }, { valueOf: null, toString: {} }, [{ toString: 'invalid' }]]) {
      const response = await f.request(route, { body: { text: 'hello', [field]: value } });
      const body = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.error.code, 'INVALID_INPUT');
      assert.ok(body.error.message.startsWith(field));
    }
  }
  assert.equal(f.calls.length, 0);
  const accepted = await f.request('/t2a', { body: { text: 'hello', speed: '1.5', volume: 0, pitch: '-1', sample_rate: '24000', bitrate: '64000' } });
  assert.equal(accepted.status, 200);
  const native = f.calls.at(-1).body;
  assert.equal(native.voice_setting.vol, 0);
  assert.equal(native.voice_setting.speed, 1.5);
  assert.equal(native.audio_setting.sample_rate, 24000);
});
