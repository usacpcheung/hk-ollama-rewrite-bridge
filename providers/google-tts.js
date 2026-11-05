const { performance } = require('node:perf_hooks');
const { createInvocationAbort } = require('../lib/invocation-abort');
const { successResult, failureResult } = require('../lib/bridge-contract');
const { convertAudio } = require('../lib/tts-audio');
const presets = require('./google-tts-voices');
const fault = (code, status, message) => Object.assign(new Error(message), { bridgeError: { code, status, message } });
function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function createGoogleTTSProvider({ project, location = 'global', model = 'gemini-3.8-flash-tts',
  credentialsFile, sdkLogging = process.env.GOOGLE_SDK_NODE_LOGGING, ffmpeg = '/usr/bin/ffmpeg',
  fetchImpl = globalThis.fetch, getAccessToken, convert = convertAudio } = {}) {
  if (sdkLogging) throw Error('Unset GOOGLE_SDK_NODE_LOGGING when Google TTS is selected.');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project || '')) throw Error('Invalid T2A_GOOGLE_PROJECT.');
  if (location !== 'global') throw Error('T2A_GOOGLE_LOCATION must be global for this tested TTS adapter.');
  if (!/^gemini-[a-z0-9][a-z0-9.-]{0,100}-tts$/.test(model)) throw Error('Invalid T2A_GOOGLE_MODEL.');
  if (typeof ffmpeg !== 'string' || !ffmpeg.startsWith('/')) throw Error('T2A_FFMPEG_PATH must be absolute.');
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`;
  let auth, pendingToken;
  function token() {
    if (!pendingToken) pendingToken = Promise.resolve().then(async () => {
      if (getAccessToken) return getAccessToken();
      if (!auth) {
        const { GoogleAuth } = require('google-auth-library');
        auth = new GoogleAuth({ keyFilename: credentialsFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      }
      return (await (await auth.getClient()).getAccessToken()).token;
    }).finally(() => { pendingToken = undefined; });
    return pendingToken;
  }
  function mapError(error) {
    if (error?.bridgeError) return error.bridgeError;
    if (['AbortError','TimeoutError'].includes(error?.name)) return { status: 504, code: 'MODEL_TIMEOUT', message: 'Model response timed out. Please retry.' };
    if (error?.message === 'AUDIO_PROCESSOR_UNAVAILABLE') return { status: 503, code: 'AUDIO_PROCESSOR_UNAVAILABLE', message: 'Audio processing is unavailable.' };
    return { status: 502, code: 'GEMINI_TTS_ERROR', message: 'Gemini speech generation or audio processing failed.' };
  }
  async function synthesize(request) {
    const timeoutMs = request.timeoutMs ?? 30000, started = performance.now();
    const { controller, dispose } = createInvocationAbort(request.signal, timeoutMs);
    const signal = controller.signal;
    const expire = () => { if (!signal.aborted && performance.now() - started >= timeoutMs) controller.abort(); };
    const check = () => { expire(); signal.throwIfAborted(); };
    let reader;
    try {
      check();
      const selection = request.voiceSelection;
      const preset = selection?.kind === 'default' ? presets.cantonese_narrator_female
        : selection?.kind === 'preset' && Object.hasOwn(presets, selection.id) ? presets[selection.id] : null;
      if (!preset) throw fault('INVALID_INPUT',400,'Unsupported Gemini voice selection.');
      let access;
      try { access = await waitFor(token(), signal); } catch { check(); throw fault('GEMINI_AUTH_ERROR',503,'Google credentials could not authorize speech.'); }
      check();
      if (typeof access !== 'string' || !access) throw fault('GEMINI_AUTH_ERROR',503,'Google credentials could not authorize speech.');
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: request.text, speechMetadata: { style: preset.style } }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: preset.voice } } } }) });
      check();
      if ([401,403].includes(response.status)) throw fault('GEMINI_AUTH_ERROR',503,'Google denied speech generation; check permissions and billing controls.');
      if (response.status === 429) throw fault('GEMINI_QUOTA_EXCEEDED',429,'Google speech quota or spending limit reached.');
      if (!response.ok || !response.body) throw Error('GOOGLE_HTTP_ERROR');
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const next = await reader.read(); check();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 20 * 1024 * 1024) throw Error('RESPONSE_TOO_LARGE');
        chunks.push(next.value);
      }
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (payload.error || payload.promptFeedback?.blockReason || payload.candidates?.length !== 1) throw Error('INVALID_RESPONSE');
      const candidate = payload.candidates[0], parts = candidate.content?.parts;
      if (candidate.finishReason !== 'STOP' || !Array.isArray(parts) || parts.length !== 1) throw Error('INCOMPLETE_AUDIO');
      const inline = parts[0]?.inlineData;
      if (!inline || !['audio/wav','audio/x-wav'].includes(inline.mimeType) || typeof inline.data !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(inline.data)) throw Error('INVALID_AUDIO');
      const input = Buffer.from(inline.data,'base64');
      check();
      const data = await convert(input, request.audio, { signal, ffmpeg });
      check();
      if (!Buffer.isBuffer(data) || !data.length) throw Error('INVALID_AUDIO');
      const format = request.audio.format, mime = { mp3:'audio/mpeg', wav:'audio/wav', pcm:'audio/pcm' }[format];
      if (!mime) throw Error('INVALID_AUDIO');
      return successResult({ output: { text: '', artifacts: [{ kind:'audio', data, format, mime, contentType:mime }],
        meta: { provider: { name:'google-gemini', model, voice:preset.voice, format, contentType:mime } } } });
    } catch (error) { expire(); return failureResult(mapError(signal.aborted ? signal.reason : error)); }
    finally { dispose(); if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } }
  }
  return { services: { t2a: { sync: synthesize } }, mapError,
    getInfo: () => ({ provider:'google-gemini', model, location, project }) };
}
module.exports = { createGoogleTTSProvider };
