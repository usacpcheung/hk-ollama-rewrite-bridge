const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { shareInFlight } = require('../lib/shared-operation');

test('aborted credential waiters detach during a stall; remaining callers share failure and can recover', async () => {
  let starts = 0, rejectFirst;
  const wait = shareInFlight(() => {
    if (++starts === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    return 'recovered';
  });
  const live = new AbortController();
  const first = wait(live.signal);
  for (let i = 0; i < 32; i++) {
    const c = new AbortController();
    const cancelled = wait(c.signal);
    c.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(getEventListeners(c.signal, 'abort').length, 0);
  }
  assert.equal(starts, 1);
  rejectFirst(new Error('fixture ADC failure'));
  await assert.rejects(first, /fixture ADC failure/);
  assert.equal(getEventListeners(live.signal, 'abort').length, 0);
  assert.equal(await wait(live.signal), 'recovered');
  assert.equal(starts, 2);
});
