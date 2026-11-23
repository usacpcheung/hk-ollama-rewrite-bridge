const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeminiTranscription } = require('../providers/gemini-transcription');
const { aborted } = require('../lib/transcription-errors');

const request = signal => ({ signal, audio: { content: Buffer.from('audio') } });
const fixture = (fetchImpl, getAccessToken = async () => 'test') =>
  createGeminiTranscription({ project: 'test-project', model: 'gemini-3.5-transcribe' }, { fetchImpl, getAccessToken }).services.transcription.sync;
const stop = parts => ({ candidates: [{ finishReason: 'STOP', content: { parts } }] });

for (const [description, status, upstream, expected] of [
  ['denied', 403, {}, 'TRANSCRIPTION_UNAVAILABLE'],
  ['quota', 429, {}, 'TRANSCRIPTION_RATE_LIMITED'],
  ['deadline', 504, {}, 'TRANSCRIPTION_TIMEOUT'],
  ['provider error', 500, {}, 'TRANSCRIPTION_FAILED'],
  ['truncation', 200, { candidates: [{ ...stop([{text:'private'}]).candidates[0], finishReason:'MAX_TOKENS' }] }, 'TRANSCRIPTION_FAILED'],
  ['object instead of candidate list', 200, { candidates: { 0: stop([{text:'wrong'}]).candidates[0], length: 1 } }, 'TRANSCRIPTION_FAILED'],
  ['partial HTTP response', 206, stop([{text:'partial'}]), 'TRANSCRIPTION_FAILED'],
  ['missing candidate', 200, {}, 'TRANSCRIPTION_FAILED'],
  ['malformed part', 200, stop([{}]), 'TRANSCRIPTION_FAILED'],
  ['silence', 200, stop([{ text: '' }]), 'NO_SPEECH'],
  ['silence in nested transcript', 200, stop([{audioTranscription:{text:''}}]), 'NO_SPEECH'],
  ['oversized body', 200, stop([{text:'a'.repeat(1024 * 1024)}]), 'TRANSCRIPTION_FAILED']
]) {
  test('Gemini transcription: ' + description, async () => {
    let calls = 0;
    const sync = fixture(async url => {
      calls++;
      assert.equal(url, 'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.5-transcribe:generateContent');
      return Response.json(upstream, { status });
    });
    const result = await sync(request(new AbortController().signal));
    assert.equal(result.error.code, expected);
    assert.equal(calls, 1);
  });
}

test('cancelled requests detach from shared ADC and never submit cancelled audio', async () => {
  let resolveToken, acquisitions = 0, requests = 0;
  const sync = fixture(async () => {
    requests++;
    return Response.json(stop([{ text: '今日' }]));
  }, () => { acquisitions++; return new Promise(resolve => { resolveToken = resolve; }); });
  const c = new AbortController();
  const first = sync(request(c.signal));
  const second = sync(request(new AbortController().signal));
  c.abort(aborted());
  assert.equal((await first).error.code, 'TRANSCRIPTION_CANCELLED');
  resolveToken('test');
  assert.equal((await second).data.output.text, '今日');
  assert.equal(acquisitions, 1);
  assert.equal(requests, 1);
});

test('Gemini settings select the model independently of Speech V2 rollback values', () => {
  const { readTranscriptionConfig } = require('../lib/transcription-config');
  const env = { TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER: 'google-gemini',
    TRANSCRIPTION_GOOGLE_PROJECT: 'test-project', TRANSCRIPTION_GOOGLE_LOCATION: 'us',
    TRANSCRIPTION_GOOGLE_MODEL: 'chirp_3', TRANSCRIPTION_GOOGLE_LANGUAGE: 'yue-Hant-HK' };
  assert.equal(readTranscriptionConfig(env).providerConfig.model, 'gemini-3.5-transcribe');
  assert.throws(() => readTranscriptionConfig({ ...env, TRANSCRIPTION_GEMINI_MODEL: 'gemini-3.5-transcribe-live' }),
    /TRANSCRIPTION_GEMINI_MODEL/);
  assert.equal(readTranscriptionConfig({ ...env, TRANSCRIPTION_PROVIDER: 'google-speech' }).providerConfig.model, 'chirp_3');
});


test('empty plain text uses the nested transcript exactly once', async () => {
  const sync = fixture(async () => Response.json(stop([
    { text: '', audioTranscription: { text: '今日' } },
    { text: '天晴', audioTranscription: { text: '天晴' } }
  ])));
  const result = await sync(request(new AbortController().signal));
  assert.equal(result.data.output.text, '今日天晴');
});


test('credential callback exceeding the deadline cannot dispatch a late paid request', async () => {
  let sent = false;
  const sync = fixture(async () => { sent = true; return Response.json(stop([{text:'late'}])); }, () => {
    const until = performance.now() + 20;
    while (performance.now() < until) {} // Simulate a delayed event loop.
    return 'token';
  });
  const result = await sync({ ...request(new AbortController().signal), timeoutMs: 5 });
  assert.equal(result.error.code, 'TRANSCRIPTION_TIMEOUT');
  assert.equal(sent, false);
});
