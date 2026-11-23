const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, AUTH } = require('../test-support/server-fixture');
const { ffmpeg, ffprobe, available, ffprobeAvailable, skipReason } = require('../test-support/media-tools');
const mediaTest = (name, run) => nodeTest(name, { timeout: 30_000, skip: !available && skipReason }, run);
const enabled = {
  TRANSCRIPTION_ENABLED: 'true',
  TRANSCRIPTION_FFMPEG_PATH: ffmpeg,
  TRANSCRIPTION_FFPROBE_PATH: ffprobe,
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
mediaTest('actual server transcription aliases: real FFmpeg and mocked Google success', async (t) => {
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
  mediaTest('actual server Google error ' + code, async (t) => {
    const f = await fixture(t, { env: { ...enabled, REVIEW_GOOGLE_ERROR: String(code) } });
    const r = await submit('/transcriptions');
    const b = await r.json();
    assert.equal(r.status, status);
    assert.equal(b.error.code, error);
    assert.ok(!JSON.stringify(b).includes('private'));
    assert.deepEqual(await fs.readdir(f.directory), []);
  });
// This case must reach conversion, so it requires FFprobe but not real FFmpeg.
nodeTest(
  'actual server denied FFmpeg executable fails safely',
  { timeout: 30_000, skip: !ffprobeAvailable && skipReason },
  async (t) => {
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
  },
);
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

for (const hint of ['', 'yue-Hant-HK']) {
  mediaTest(`Gemini transcription uses normalized WAV on both aliases (hint: ${hint || 'auto'})`, async t => {
    const f = await fixture(t, {
      env: { ...enabled, TRANSCRIPTION_PROVIDER: 'google-gemini',
        ...(hint && { TRANSCRIPTION_GEMINI_LANGUAGE_HINT: hint }),
        TRANSCRIPTION_GOOGLE_LOCATION: 'us', TRANSCRIPTION_GOOGLE_MODEL: 'chirp_3',
        NODE_OPTIONS: '--require=' + path.join(__dirname, '../test-support/gemini-transport.cjs') },
      handle(req, res, body) {
        if (req.url !== '/gemini') return false;
        assert.equal(req.headers.authorization, 'Bearer test-only-token');
        const inline = body.contents[0].parts[0].inlineData;
        assert.equal(inline.mimeType, 'audio/wav');
        assert.equal(Buffer.from(inline.data, 'base64').toString('ascii', 0, 4), 'RIFF');
        const expected = { contents: [{ role: 'user', parts: [{ inlineData: inline }] }] };
        if (hint) expected.generationConfig = { audioTranscriptionConfig: { languageCodes: ['yue-Hant-HK'] } };
        assert.deepEqual(body, expected);
        res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: {
          parts: [{ text: '我哋用 ' }, { audioTranscription: { text: 'Google Classroom。' } }]
        } }] }));
        return true;
      }
    });
    for (const route of ['/transcriptions', '/api/transcriptions']) {
      const response = await submit(route);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.result, '我哋用 Google Classroom。');
      assert.equal(data.durationSeconds, 0.1);
      assert.ok(data.requestId && data.timings);
      assert.deepEqual(await fs.readdir(f.directory), []);
    }
    assert.equal(f.calls.length, 2);
  });
}

mediaTest('Gemini stalled response body times out, cleans up and admits the next upload', async t => {
  let attempts = 0;
  const f = await fixture(t, {
    env: { ...enabled, TRANSCRIPTION_PROVIDER: 'google-gemini', TRANSCRIPTION_GOOGLE_TIMEOUT_MS: '1000',
      NODE_OPTIONS: '--require=' + path.join(__dirname, '../test-support/gemini-transport.cjs') },
    handle(req, res) {
      if (req.url !== '/gemini') return false;
      if (++attempts === 1) res.write('{"candidates":');
      else res.end(JSON.stringify({ candidates: [{ finishReason:'STOP', content:{parts:[{text:'今日'}]} }] }));
      return true;
    }
  });
  const first = await submit('/transcriptions');
  assert.equal(first.status, 504);
  assert.equal((await first.json()).error.code, 'TRANSCRIPTION_TIMEOUT');
  assert.deepEqual(await fs.readdir(f.directory), []);
  const next = await submit('/transcriptions');
  assert.equal((await next.json()).result, '今日');
  assert.equal(attempts, 2);
});
