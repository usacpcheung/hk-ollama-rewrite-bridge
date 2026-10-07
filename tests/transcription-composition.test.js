const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, AUTH, json } = require('../test-support/server-fixture');
const enabled = {
  TRANSCRIPTION_ENABLED: 'true',
  NODE_OPTIONS: `--require=${path.join(__dirname, '../test-support/google-stub.cjs')}`,
};
function wav() {
  const b = Buffer.alloc(44 + 3200);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(3200, 40);
  return b;
}
async function submit(route) {
  const form = new FormData();
  form.append('audio', new Blob([wav()], { type: 'audio/wav' }), 'test.wav');
  return fetch('http://127.0.0.1:3001' + route, {
    method: 'POST',
    headers: AUTH,
    body: form,
    signal: AbortSignal.timeout(10000),
  });
}
test('actual server transcription aliases: real FFmpeg and mocked Google success', async (t) => {
  const f = await fixture(t, { env: enabled });
  for (const route of ['/transcriptions', '/api/transcriptions']) {
    const r = await submit(route);
    const b = await r.json();
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.equal(b.result, '广东话 unchanged');
    assert.equal(b.durationSeconds, 0.1);
    assert.ok(b.requestId);
    assert.ok(b.timings);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});
for (const [code, status, error] of [
  [7, 503, 'TRANSCRIPTION_UNAVAILABLE'],
  [16, 503, 'TRANSCRIPTION_UNAVAILABLE'],
  [4, 504, 'TRANSCRIPTION_TIMEOUT'],
  [8, 429, 'TRANSCRIPTION_RATE_LIMITED'],
])
  test('actual server Google error ' + code, async (t) => {
    const f = await fixture(t, { env: { ...enabled, REVIEW_GOOGLE_ERROR: String(code) } });
    const r = await submit('/transcriptions');
    const b = await r.json();
    assert.equal(r.status, status);
    assert.equal(b.error.code, error);
    assert.ok(!JSON.stringify(b).includes('private'));
    assert.deepEqual(await fs.readdir(f.directory), []);
  });
test('actual server denied FFmpeg executable fails safely', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'denied-executable-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'not-executable');
  await fs.writeFile(file, 'not executable', { mode: 0o600 });
  const f = await fixture(t, { env: { ...enabled, TRANSCRIPTION_FFMPEG_PATH: file } });
  const r = await submit('/transcriptions');
  const b = await r.json();
  assert.equal(r.status, 503, JSON.stringify(b));
  assert.equal(b.error.code, 'AUDIO_PROCESSOR_UNAVAILABLE');
  assert.deepEqual(await fs.readdir(f.directory), []);
});
test('actual server slow upload deadline cleans files', async (t) => {
  const f = await fixture(t, { env: { ...enabled, TRANSCRIPTION_UPLOAD_TIMEOUT_MS: '1000' } });
  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      'http://127.0.0.1:3001/transcriptions',
      { method: 'POST', headers: { ...AUTH, 'Content-Type': 'multipart/form-data; boundary=slow' } },
      (res) => {
        let b = '';
        res.on('data', (x) => (b += x));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      },
    );
    req.on('error', reject);
    t.after(() => req.destroy());
    req.write(
      '--slow\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nx',
    );
  });
  assert.equal(result.status, 408, JSON.stringify(result));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await fs.readdir(f.directory), []);
});
