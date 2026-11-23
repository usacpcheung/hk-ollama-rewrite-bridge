const { once, EventEmitter } = require('node:events');
const { successResult, failureResult } = require('../lib/bridge-contract');
const { TranscriptionError } = require('../lib/transcription-errors');

const failed = () => new TranscriptionError(502, 'TRANSCRIPTION_FAILED', 'Transcription failed. Please try again later.');
const unavailable = () => new TranscriptionError(503, 'TRANSCRIPTION_UNAVAILABLE', 'Transcription is unavailable. Please contact the administrator.');
const timedOut = () => new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.');

async function readTranscript(response) {
  if (!response.body) throw failed();
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw failed();
    chunks.push(chunk);
  }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const candidate = body?.candidates?.[0];
  if (body?.error || body?.promptFeedback?.blockReason || !Array.isArray(body?.candidates) || body.candidates.length !== 1 ||
      candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw failed();
  const text = candidate.content.parts.map(part => {
    if (part?.text != null && typeof part.text !== 'string') throw failed();
    const value = part?.text || (part?.audioTranscription?.text ?? part?.text);
    if (part?.thought || typeof value !== 'string') throw failed();
    return value;
  }).join('').trim();
  if (!text) throw new TranscriptionError(422, 'NO_SPEECH', 'No speech was recognized. Please try a clearer recording.');
  return text;
}

function createGeminiTranscription({ project, model, credentialsFile }, { fetchImpl = fetch, getAccessToken } = {}) {
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`;
  let auth;
  const acquire = getAccessToken || (() => {
    const { GoogleAuth } = require('google-auth-library');
    auth ||= new GoogleAuth({ keyFilename: credentialsFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    return auth.getAccessToken();
  });
  // Credential discovery is shared. A disconnected caller can detach even if ADC is stalled.
  let pending;
  async function token(signal) {
    signal.throwIfAborted();
    if (!pending) {
      const waiters = new EventEmitter();
      waiters.setMaxListeners(0); // The transcription service enforces the admission limit.
      pending = waiters;
      const finish = value => {
        pending = undefined;
        waiters.emit('ready', value);
      };
      Promise.resolve().then(acquire).then(finish, () => finish(null));
    }
    const [value] = await once(pending, 'ready', { signal });
    if (typeof value !== 'string' || !value) throw unavailable();
    return value;
  }

  async function sync({ audio, signal }) {
    // recognizeAudio supplies a single deadline signal covering ADC, headers and body.
    const controller = new AbortController();
    const callSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const access = await token(callSignal);
      callSignal.throwIfAborted();
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: callSignal,
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: 'audio/wav', data: audio.content.toString('base64') } }
        ] }] })
      });
      if ([401, 403].includes(response.status)) throw unavailable();
      if (response.status === 429) throw new TranscriptionError(429, 'TRANSCRIPTION_RATE_LIMITED', 'Transcription capacity is temporarily exhausted. Please retry later.');
      if ([408, 504].includes(response.status)) throw timedOut();
      if (response.status !== 200) throw failed();
      return successResult({ response: await readTranscript(response) });
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      return failureResult(reason instanceof TranscriptionError ? reason : failed());
    } finally {
      controller.abort();
    }
  }
  return {
    getInfo: () => ({ provider: 'google-gemini', model }),
    mapError: failed,
    services: { transcription: {
      inputRequirements: { encoding: 'wav', sampleRate: 16000, channels: 1, delivery: 'inline',
        cancellation: 'abortable', maxDurationSeconds: 60, maxPreparedBytes: 4 * 1024 * 1024 },
      sync
    } }
  };
}
module.exports = { createGeminiTranscription };
