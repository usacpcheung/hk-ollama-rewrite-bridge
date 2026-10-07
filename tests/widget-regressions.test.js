const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Expose private functions in memory only; production retains its public mount API.
const source = fs.readFileSync(path.join(__dirname, '../public/rewrite-widget/rewrite-widget.js'), 'utf8')
  .replace('global.RewriteWidget = { mount };', 'global.RewriteWidget = { mount, consumeNdjsonStream, fetchWithTimeout, SharedStatus };');
function widget(extra = {}) {
  const context = { window: {}, TextDecoder, AbortController, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(source, context);
  return context.window.RewriteWidget;
}
test('widget rejects premature EOF and ignores text after completion, including a stalled socket', async () => {
  const w = widget(); const chunks = [];
  const partial = await w.consumeNdjsonStream(new Response('{"response":"partial","done":false}\n'), { onChunk: x => chunks.push(x) });
  assert.match(partial.errorMessage, /before completion/);
  let cancelled = false;
  const res = new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('{"response":"ok","done":false}\n{"done":true}\n{"response":"late"}\n'));
  }, cancel() { cancelled = true; } }));
  chunks.length = 0;
  const result = await w.consumeNdjsonStream(res, { onChunk: x => chunks.push(x) });
  assert.equal(result.errorMessage, ''); assert.deepEqual(chunks, ['ok']); assert.equal(cancelled, true);
});
test('widget treats malformed frames and terminal errors as failures', async () => {
  const w = widget();
  for (const body of ['null\n', '[]\n', '{broken}\n']) {
    await assert.rejects(w.consumeNdjsonStream(new Response(body), { onChunk() {} }));
  }
  const result = await w.consumeNdjsonStream(new Response('{"done":true,"error":{"code":"FAIL"}}\n'), { onChunk() { assert.fail('error must not be text'); } });
  assert.ok(result.errorMessage);
});
test('widget timeout covers JSON and streaming body reads after headers', async () => {
  for (const streaming of [false, true]) {
    const w = widget({ fetch: async (_url, { signal }) => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(streaming ? '{"response":"partial"}\n' : '{'));
      signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
    } })) });
    const res = await w.fetchWithTimeout('http://fixture.invalid', {}, 20);
    try { await assert.rejects(streaming ? w.consumeNdjsonStream(res, { onChunk() {} }) : res.json(), { name: 'AbortError' }); }
    finally { res.finishRequest(); }
  }
});
test('widget request cleanup and caller cancellation abort unread bodies', async () => {
  let signal;
  const w = widget({ fetch: async (_url, opts) => { signal = opts.signal; return new Response('body'); } });
  const res = await w.fetchWithTimeout('http://fixture.invalid', {}, 1000);
  res.finishRequest(); assert.equal(signal.aborted, true);
  const controller = new AbortController();
  const next = await w.fetchWithTimeout('http://fixture.invalid', { signal: controller.signal }, 1000);
  controller.abort(); assert.equal(signal.aborted, true); next.finishRequest();
});
test('mounted widget counts Unicode characters and prevents reentrant rewrite callbacks', async () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.classList = { remove() {}, add() {}, toggle() {} }; }
    appendChild(e) { this.children.push(e); e.parentElement = this; return e; }
    addEventListener() {}
    querySelector() { return this.appendChild(new Element()); }
  }
  const root = new Element();
  let rewriteRequests = 0;
  const w = widget({ window: { location: { pathname: '/', href: 'http://fixture.invalid/' } },
    document: { querySelector: () => root, getElementById: () => true, createElement: () => new Element() },
    sessionStorage: { getItem: () => '😀'.repeat(101), setItem() {} }, setInterval: () => 1, clearInterval() {},
    fetch: async (_url, options) => {
      if (options.method === 'POST') { rewriteRequests++; return new Response('{"ok":true,"result":"正式"}'); }
      return new Response('{"status":"ready","serviceState":"ready"}');
    } });
  const mounted = await w.mount({ containerSelector: '#widget', maxChars: 200 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const flat = e => [e, ...e.children.flatMap(flat)];
  assert.equal(flat(root).find(e => e.textContent === 'Rewrite').disabled, false);
  let callbackRan = false;
  mounted.onRewriteStart(() => { if (!callbackRan) { callbackRan = true; void mounted.rewrite(); } });
  await mounted.rewrite();
  assert.equal(rewriteRequests, 1);
  mounted.destroy();
});

test('widget does not treat a live service with a warming model as model ready', async () => {
  const w = widget({ fetch: async () => new Response('{"status":"warming","serviceState":"ready"}') });
  const state = await w.SharedStatus.get('http://fixture.invalid').pollOnce();
  assert.equal(state.modelReady, false);
  assert.equal(state.phase, 'starting');
});
