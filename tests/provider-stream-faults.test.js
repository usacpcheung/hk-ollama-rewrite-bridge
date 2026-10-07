const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMinimaxProvider } = require('../providers/minimax');
const { createOllamaProvider } = require('../providers/ollama');
const { createStreamWriter } = require('../lib/output-writer');

function provider(kind) {
  return kind === 'minimax'
    ? createMinimaxProvider({ apiUrl: 'http://fixture.invalid', model: 'fixture', apiKey: 'synthetic' })
    : createOllamaProvider({ generateUrl: 'http://fixture.invalid', model: 'fixture' });
}
function wire(kind, text) {
  return kind === 'minimax'
    ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n'
    : JSON.stringify({ response: text, done: false }) +
        '\n' +
        JSON.stringify({ response: '', done: true }) +
        '\n';
}
for (const kind of ['minimax', 'ollama']) {
  test(`${kind} UTF-8 split across reads preserves output and terminal event`, async (t) => {
    const bytes = Buffer.from(wire(kind, '廣東話😀'));
    let i = 0;
    let cancelled = false;
    t.mock.method(
      global,
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (i < bytes.length) controller.enqueue(bytes.subarray(i, ++i));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const events = [];
    const result = await provider(kind).rewriteStream({
      prompt: 'test',
      timeoutMs: 1000,
      onChunk: async (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(
      events
        .filter((x) => x.type === 'text')
        .map((x) => x.text)
        .join(''),
      '廣東話😀',
    );
    assert.equal(events.filter((x) => x.type === 'done').length, 1);
    assert.equal(cancelled, true);
  });

  test(`${kind} oversized upstream frame fails with a controlled error`, async (t) => {
    t.mock.method(global, 'fetch', async () => new Response(wire(kind, 'x'.repeat(1024 * 1024 + 1))));
    const events = [];
    const result = await provider(kind).rewriteStream({
      prompt: 'test',
      timeoutMs: 1000,
      onChunk: async (event) => events.push(event),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 502);
    assert.deepEqual(
      events.map((x) => x.type),
      ['error'],
    );
  });

  test(`${kind} provider deadline interrupts a blocked output callback`, async (t) => {
    t.mock.method(global, 'fetch', async () => new Response(wire(kind, 'text')));
    const res = new EventEmitter();
    res.write = () => false;
    res.destroy = () => {
      res.destroyed = true;
      res.emit('close');
    };
    const writer = createStreamWriter(res);
    const start = Date.now();
    const result = await provider(kind).rewriteStream({
      prompt: 'test',
      timeoutMs: 30,
      onChunk: async (event, { signal }) => {
        if (event.type === 'text') await writer.writeChunk({ response: event.text }, { signal });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MODEL_TIMEOUT');
    assert.ok(Date.now() - start < 1000);
    assert.equal(res.destroyed, true);
    assert.equal(res.listenerCount('drain'), 0);
  });
}
