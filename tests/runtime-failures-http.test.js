const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);
const assert = require('node:assert/strict');
const http = require('node:http');
const { fixture, AUTH, AUDIO, POST_ROUTES, json } = require('../test-support/server-fixture');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const deadlines = {
  REWRITE_READY_INVOKE_TIMEOUT_MS: '1000',
  REWRITE_COLD_INVOKE_TIMEOUT_MS: '1000',
  T2A_INVOKE_TIMEOUT_MS: '1000',
  REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD: '100',
};
for (const partial of [false, true])
  test(`timeout ${partial ? 'partial JSON' : 'no headers'} and recovery`, async (t) => {
    let slow = true;
    const f = await fixture(t, {
      env: deadlines,
      handle: (req, res) => {
        if (!slow) return false;
        if (partial) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{');
        }
        return true;
      },
    });
    for (const route of ['/rewrite', '/t2a']) {
      const start = Date.now();
      const r = await f.request(route);
      const body = await r.json();
      assert.ok(Date.now() - start < 2500);
      assert.equal(r.status, 504);
      assert.equal(body.error.code, 'MODEL_TIMEOUT');
    }
    slow = false;
    assert.equal((await f.request('/rewrite')).status, 200);
    assert.equal((await f.request('/t2a')).status, 200);
  });
test('queued disconnected request is removed without a provider call', async (t) => {
  let finish, enteredResolve;
  const entered = new Promise((r) => (enteredResolve = r));
  const f = await fixture(t, {
    env: { MINIMAX_MAX_CONCURRENCY: '1', MINIMAX_MAX_QUEUE_SIZE: '5' },
    handle: (req, res) => {
      if (req.url === '/rewrite' && !finish) {
        finish = () => json(res, 200, { reply: 'done' });
        enteredResolve();
        return true;
      }
      return false;
    },
  });
  const first = f.request('/rewrite');
  await entered;
  const req = http.request(
    'http://127.0.0.1:3001/t2a',
    { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' } },
    (r) => r.resume(),
  );
  req.on('error', () => {});
  req.end(JSON.stringify({ text: 'cancelled' }));
  await pause(150);
  req.destroy();
  await pause(100);
  finish();
  await (await first).text();
  await pause(300);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/t2a')).status, 200);
});
test('upstream done frame followed by stall', async (t) => {
  const f = await fixture(t, {
    env: { ...deadlines, MINIMAX_MAX_CONCURRENCY: '1', MINIMAX_MAX_QUEUE_SIZE: '0' },
    handle: (req, res) => {
      if (req.url !== '/rewrite') return false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      return true;
    },
  });
  const start = Date.now();
  const r = await f.request('/rewrite', { body: { text: 'test', stream: true } });
  const reader = r.body.getReader();
  let first = Buffer.from((await reader.read()).value).toString();
  await pause(100);
  const blocked = await f.request('/t2a');
  let rest = '';
  while (true) {
    const x = await reader.read();
    if (x.done) break;
    rest += Buffer.from(x.value).toString();
  }
  assert.equal(blocked.status, 200);
  assert.ok(Date.now() - start < 800);
  const events = (first + rest).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((x) => x.done).length, 1);
  assert.ok(!events.at(-1).error);
});
test('permissions and malformed upstream bodies', async (t) => {
  let status = 401,
    raw = '{}';
  const f = await fixture(t, {
    env: deadlines,
    handle: (req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(raw);
      return true;
    },
  });
  for (status of [401, 403, 429, 500])
    for (raw of ['{}', '<html>denied</html>'])
      for (const route of ['/rewrite', '/t2a']) {
        const r = await f.request(route);
        const body = await r.json();
        assert.equal(r.status, 502);
        assert.equal(body.error.code, [401, 403].includes(status) ? 'PROVIDER_AUTH_ERROR' : 'PROVIDER_ERROR');
      }
});
test('concurrent mixed requests remain isolated and queue recovers', async (t) => {
  let active = 0,
    peak = 0;
  const f = await fixture(t, {
    env: {
      ...deadlines,
      MINIMAX_MAX_CONCURRENCY: '2',
      MINIMAX_MAX_QUEUE_SIZE: '30',
      MINIMAX_MAX_WAIT_MS: '5000',
    },
    handle: (req, res, body) => {
      active++;
      peak = Math.max(active, peak);
      setTimeout(() => {
        active--;
        if (req.url === '/rewrite') json(res, 200, { reply: 'ok' });
        else json(res, 200, { data: { audio: AUDIO.toString('hex'), format: 'mp3' } });
      }, 40);
      return true;
    },
  });
  const responses = await Promise.all(
    Array.from({ length: 24 }, (_, i) => f.request(i % 2 ? '/t2a' : '/rewrite')),
  );
  for (let i = 0; i < responses.length; i++) {
    assert.equal(responses[i].status, 200);
    if (i % 2) assert.deepEqual(Buffer.from(await responses[i].arrayBuffer()), AUDIO);
    else assert.equal((await responses[i].json()).result, 'ok');
  }
  assert.equal(peak, 2);
  assert.equal((await f.request('/rewrite')).status, 200);
});
test('authentication rejects forged headers on every alias', async (t) => {
  const f = await fixture(t);
  for (const route of POST_ROUTES)
    for (const headers of [
      {},
      { ...AUTH, 'X-Bridge-Auth': 'bad' },
      { ...AUTH, 'X-Authenticated-Email': 'other@example.com' },
      { 'X-Authenticated-Email': 'student@hs.edu.hk', 'X-Forwarded-For': '127.0.0.1' },
    ]) {
      const r = await f.request(route, { headers });
      assert.ok([401, 403].includes(r.status));
      await r.text();
    }
  assert.equal(f.calls.length, 0);
});
test('legacy SSE malformed or truncated completion', async (t) => {
  let wire = '';
  const f = await fixture(t, {
    env: deadlines,
    handle: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(wire);
      return true;
    },
  });
  for (const [name, value] of [
    ['malformed', 'data: {not-json}\n\n'],
    [
      'missing-terminal',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }) + '\n\n',
    ],
    [
      'text-after-terminal',
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: 'before' } }] }) +
        '\n\ndata: [DONE]\n\ndata: ' +
        JSON.stringify({ choices: [{ delta: { content: 'late' } }] }) +
        '\n\n',
    ],
  ]) {
    wire = value;
    const r = await f.request('/rewrite', { body: { text: 'test', stream: true } });
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.equal(r.status, 200);
    if (name === 'text-after-terminal') {
      assert.equal(
        events
          .filter((x) => !x.done)
          .map((x) => x.response)
          .join(''),
        'before',
      );
      assert.equal(events.at(-1).done, true);
      assert.ok(!events.at(-1).error);
    } else {
      assert.equal(events.at(-1).error.code, 'PROVIDER_ERROR');
    }
  }
});
test('active disconnect frees capacity before another caller can hit its admission wait deadline', async (t) => {
  let finish,
    enteredResolve,
    closed = false;
  const entered = new Promise((r) => (enteredResolve = r));
  const f = await fixture(t, {
    env: {
      ...deadlines,
      REWRITE_READY_INVOKE_TIMEOUT_MS: '3000',
      MINIMAX_MAX_CONCURRENCY: '1',
      MINIMAX_MAX_QUEUE_SIZE: '1',
      MINIMAX_MAX_WAIT_MS: '100',
    },
    handle: (req, res) => {
      if (req.url !== '/rewrite') return false;
      res.on('close', () => (closed = true));
      finish = () => json(res, 200, { reply: 'done' });
      enteredResolve();
      return true;
    },
  });
  const req = http.request(
    'http://127.0.0.1:3001/rewrite',
    { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' } },
    (r) => r.resume(),
  );
  req.on('error', () => {});
  req.end(JSON.stringify({ text: 'abort' }));
  await entered;
  req.destroy();
  await pause(100);
  const r = await f.request('/t2a');
  await r.arrayBuffer();
  assert.equal(closed, true);
  assert.equal(r.status, 200);
  finish();
  await pause(100);
  assert.equal((await f.request('/t2a')).status, 200);
});

function providerScenario(kind) {
  const env =
    kind === 'ollama'
      ? { REWRITE_PROVIDER: 'ollama', REWRITE_OLLAMA_MODEL: 'fixture-model' }
      : kind === 'anthropic'
        ? { REWRITE_MINIMAX_API_FORMAT: 'anthropic' }
        : {};
  const path = kind === 'ollama' ? '/generate' : kind === 'anthropic' ? '/anthropic/v1/messages' : '/rewrite';
  const text =
    kind === 'ollama'
      ? JSON.stringify({ response: 'first', done: false }) + '\n'
      : kind === 'anthropic'
        ? 'event: content_block_delta\ndata: ' +
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } }) +
          '\n\n'
        : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'first' } }] }) + '\n\n';
  const end =
    kind === 'ollama'
      ? JSON.stringify({ response: '', done: true }) + '\n'
      : kind === 'anthropic'
        ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : 'data: [DONE]\n\n';
  return { env, path, text, end };
}

for (const kind of ['ollama', 'legacy', 'anthropic']) {
  test(`${kind} streaming terminates without EOF and ignores subsequent tokens`, async (t) => {
    const spec = providerScenario(kind);
    let closed = false;
    const f = await fixture(t, {
      env: { ...deadlines, ...spec.env },
      handle: (req, res) => {
        if (req.url === '/ps') {
          json(res, 200, { models: [{ name: 'fixture-model' }] });
          return true;
        }
        if (req.url !== spec.path) return false;
        res.on('close', () => {
          closed = true;
        });
        res.writeHead(200, {
          'Content-Type': kind === 'ollama' ? 'application/x-ndjson' : 'text/event-stream',
        });
        res.write(spec.text + spec.end + spec.text); // Deliberately leave the socket open.
        return true;
      },
    });
    const start = Date.now();
    const r = await f.request('/rewrite', { body: { text: 'test', stream: true } });
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.ok(Date.now() - start < 800, 'must finish before the provider deadline');
    assert.deepEqual(
      events.filter((x) => !x.done).map((x) => x.response),
      ['first'],
    );
    assert.equal(events.filter((x) => x.done).length, 1);
    assert.ok(!events.at(-1).error);
    for (let i = 0; !closed && i < 50; i++) await pause(10);
    assert.equal(closed, true, 'upstream connection must be cancelled');
  });

  for (const stream of [false, true])
    test(`${kind} ${stream ? 'streaming' : 'sync'} disconnect aborts provider and releases capacity`, async (t) => {
      const spec = providerScenario(kind);
      let closed = false;
      let enter;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const f = await fixture(t, {
        env: { ...spec.env, ...deadlines, MINIMAX_MAX_CONCURRENCY: '1', MINIMAX_MAX_QUEUE_SIZE: '0' },
        handle: (req, res) => {
          if (req.url === '/ps') {
            json(res, 200, { models: [{ name: 'fixture-model' }] });
            return true;
          }
          if (req.url !== spec.path) return false;
          res.on('close', () => {
            closed = true;
          });
          if (stream) {
            res.writeHead(200, {
              'Content-Type': kind === 'ollama' ? 'application/x-ndjson' : 'text/event-stream',
            });
            res.write(spec.text);
          }
          enter();
          return true;
        },
      });
      const req = http.request(
        'http://127.0.0.1:3001/rewrite',
        { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' } },
        (res) => res.resume(),
      );
      req.on('error', () => {});
      t.after(() => req.destroy());
      req.end(JSON.stringify({ text: 'test', stream }));
      await entered;
      req.destroy();
      for (let i = 0; !closed && i < 50; i++) await pause(10);
      assert.equal(closed, true);
      await pause(20);
      assert.equal((await f.request('/t2a')).status, 200);
      assert.equal((await f.request('/healthz', { method: 'GET', headers: {} })).status, 200);
    });
}

test('legacy streaming preserves final message fallback, combined delta completion and terminal usage', async (t) => {
  let wire;
  const f = await fixture(t, {
    handle: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(wire);
      return true;
    },
  });
  for (const frame of [
    { choices: [{ message: { content: 'final' } }] },
    { choices: [{ delta: { content: 'final' }, finish_reason: 'length' }], usage: { total_tokens: 8 } },
  ]) {
    wire = 'data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n';
    const r = await f.request('/rewrite', { body: { text: 'test', stream: true } });
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].response, 'final');
    assert.equal(events.at(-1).done, true);
    assert.ok(!events.at(-1).error);
    if (frame.usage) {
      assert.deepEqual(events.at(-1).usage, frame.usage);
      assert.equal(events.at(-1).done_reason, 'length');
    }
  }
});

for (const kind of ['ollama', 'anthropic'])
  test(`${kind} timeout during JSON body read remains a timeout`, async (t) => {
    const spec = providerScenario(kind);
    const f = await fixture(t, {
      env: { ...spec.env, ...deadlines },
      handle: (req, res) => {
        if (req.url === '/ps') {
          json(res, 200, { models: [{ name: 'fixture-model' }] });
          return true;
        }
        if (req.url !== spec.path) return false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        return true;
      },
    });
    const r = await f.request('/rewrite');
    assert.equal(r.status, 504);
    assert.equal((await r.json()).error.code, 'MODEL_TIMEOUT');
  });

test('active T2A disconnect aborts its upstream and preserves rewrite capacity', async (t) => {
  let entered;
  const entry = new Promise((resolve) => {
    entered = resolve;
  });
  let closed = false;
  const f = await fixture(t, {
    env: { MINIMAX_MAX_CONCURRENCY: '1', MINIMAX_MAX_QUEUE_SIZE: '0' },
    handle: (req, res) => {
      if (req.url !== '/t2a') return false;
      res.on('close', () => {
        closed = true;
      });
      entered();
      return true;
    },
  });
  const req = http.request(
    'http://127.0.0.1:3001/t2a',
    { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' } },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.end(JSON.stringify({ text: 'test' }));
  await entry;
  req.destroy();
  for (let i = 0; !closed && i < 50; i++) await pause(10);
  assert.equal(closed, true);
  await pause(20);
  assert.equal((await f.request('/rewrite')).status, 200);
});

test('mixed slow successes, upstream failures and cancelled sessions preserve capacity and response identity', async (t) => {
  let active = 0,
    peak = 0;
  const f = await fixture(t, {
    env: {
      MINIMAX_MAX_CONCURRENCY: '3',
      MINIMAX_MAX_QUEUE_SIZE: '100',
      MINIMAX_MAX_WAIT_MS: '5000',
      REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD: '100',
      RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS: '1000',
      RATE_LIMIT_T2A_AUTH_MAX_REQUESTS: '1000',
    },
    handle: (req, res, body) => {
      const match = JSON.stringify(body).match(/case-(\d+)/);
      if (!match) return false;
      const id = Number(match[1]);
      active++;
      peak = Math.max(peak, active);
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          active--;
        }
      };
      res.on('close', finish);
      setTimeout(
        () => {
          finish();
          if (res.destroyed) return;
          if (id % 11 === 0) return json(res, 500, {});
          if (req.url === '/rewrite') json(res, 200, { reply: `case-${id}` });
          else
            json(res, 200, {
              data: { audio: Buffer.from(`case-${id}:`.padEnd(96, 'x')).toString('hex'), format: 'mp3' },
            });
        },
        80 + (id % 4) * 10,
      );
      return true;
    },
  });
  const outcomes = await Promise.all(
    Array.from({ length: 60 }, async (_, id) => {
      const controller = new AbortController();
      const timer = id % 3 === 0 ? setTimeout(() => controller.abort(), 40) : null;
      try {
        const r = await fetch('http://127.0.0.1:3001' + (id % 2 ? '/t2a' : '/rewrite'), {
          method: 'POST',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `case-${id}` }),
          signal: controller.signal,
        });
        if (id % 11 === 0) {
          assert.equal(r.status, 502);
          await r.text();
          return 'provider-error';
        }
        assert.equal(r.status, 200);
        if (id % 2)
          assert.equal(Buffer.from(await r.arrayBuffer()).toString(), `case-${id}:`.padEnd(96, 'x'));
        else assert.equal((await r.json()).result, `case-${id}`);
        return 'success';
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        return 'cancelled';
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  await pause(150);
  assert.ok(
    outcomes.includes('success') && outcomes.includes('provider-error') && outcomes.includes('cancelled'),
  );
  assert.ok(peak <= 3, `upstream concurrency reached ${peak}`);
  assert.equal(active, 0);
  assert.equal((await f.request('/rewrite')).status, 200);
  assert.equal((await f.request('/t2a')).status, 200);
});
