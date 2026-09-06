const { successResult, failureResult } = require('../lib/bridge-contract');
const { TranscriptionError, checkAbort } = require('../lib/transcription-errors');

function mapGoogleSpeechError(error) {
  if (error instanceof TranscriptionError) return { status: error.status, code: error.code, message: error.message };
  // Never return provider messages, credentials, paths, transcripts, or gRPC details.
  if (error?.code === 8) return { status: 429, code: 'TRANSCRIPTION_RATE_LIMITED', message: 'Transcription capacity is temporarily exhausted. Please retry later.' };
  if (error?.code === 4) return { status: 504, code: 'TRANSCRIPTION_TIMEOUT', message: 'Transcription timed out.' };
  if ([7, 16].includes(error?.code)) return { status: 503, code: 'TRANSCRIPTION_UNAVAILABLE', message: 'Transcription is unavailable. Please contact the administrator.' };
  return { status: 502, code: 'TRANSCRIPTION_FAILED', message: 'Transcription failed. Please try again later.' };
}

function createGoogleSpeechProvider(config, { createClient } = {}) {
  let client;
  let initialization;
  async function initialize(speech, signal, timeoutMs) {
    initialization ||= Promise.resolve().then(() => speech.initialize?.());
    // Initialization has no audio/request payload. Share it and bound each caller's
    // wait, so a stalled credential lookup cannot occupy all admission slots forever.
    let timer;
    let cancel;
    try {
      await Promise.race([initialization, new Promise((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        timer = setTimeout(() => reject(new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.')), timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      })]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  const getClient = () => {
    if (!client) {
      const factory = createClient || (options => new (require('@google-cloud/speech').v2.SpeechClient)(options));
      client = factory({ apiEndpoint: `${config.location}-speech.googleapis.com` });
    }
    return client;
  };
  return {
    name: 'google-speech',
    getInfo: () => ({ provider: 'google-speech' }),
    mapError: mapGoogleSpeechError,
    services: { transcription: { sync: async ({ content, signal, timeoutMs }) => {
      try {
        checkAbort(signal);
        const speech = getClient();
        // Resolve ADC before the generated recognize wrapper; initialization errors
        // are then caught here instead of the wrapper's detached initialization catch.
        const started = Date.now();
        await initialize(speech, signal, timeoutMs);
        checkAbort(signal);
        const remainingMs = timeoutMs - (Date.now() - started);
        if (remainingMs <= 0) throw new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.');
        const [response] = await speech.recognize({
          recognizer: `projects/${config.project}/locations/${config.location}/recognizers/_`,
          config: { autoDecodingConfig: {}, model: config.model, languageCodes: [config.language] },
          content
        }, { timeout: remainingMs, retry: null });
        // This SDK's public promise is not cancellable. Keep admission until the RPC
        // settles or its deadline expires, then discard results for a disconnected client.
        checkAbort(signal);
        const text = (response.results || []).map(result => result.alternatives?.[0]?.transcript?.trim() || '').filter(Boolean).join('\n');
        if (!text) throw new TranscriptionError(422, 'NO_SPEECH', 'No speech was recognized. Please try a clearer recording.');
        return successResult({ response: text });
      } catch (error) { return failureResult(mapGoogleSpeechError(error)); }
    } } },
    close: async () => { if (client) await client.close(); }
  };
}
module.exports = { createGoogleSpeechProvider, mapGoogleSpeechError };
