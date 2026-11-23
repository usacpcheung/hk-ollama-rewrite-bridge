const { createGoogleTokenSource } = require('./google-token');
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
  const token = createGoogleTokenSource(credentialsFile, getAccessToken);

  async function sync({ audio, signal, timeoutMs }) {
    // recognizeAudio supplies a single deadline signal covering ADC, headers and body.
    const started = performance.now();
    const controller = new AbortController();
    const callSignal = AbortSignal.any([signal, controller.signal]);
    try {
      let access;
      try { access = await token(callSignal); }
      catch { callSignal.throwIfAborted(); throw unavailable(); }
      if (typeof access !== 'string' || !access) throw unavailable();
      callSignal.throwIfAborted();
      const body = JSON.stringify({ contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'audio/wav', data: audio.content.toString('base64') } }
      ] }] });
      // Serialization and credential callbacks can finish before an overdue timer runs.
      if (performance.now() - started >= timeoutMs) throw timedOut();
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: callSignal,
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body
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
