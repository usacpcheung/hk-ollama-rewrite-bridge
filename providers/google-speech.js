const { shareInFlight } = require('../lib/shared-operation');
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
  let initialized = false;
  const waitForInitialization = shareInFlight(async () => {
    const speech = client;
    try {
      await speech.initialize?.();
      initialized = true;
    } catch (error) {
      client = undefined;
      void Promise.resolve().then(() => speech.close?.()).catch(() => {});
      throw error;
    }
  });
  async function initialize(signal, timeoutMs) {
    if (initialized) return;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.')), timeoutMs);
    try {
      await waitForInitialization(signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal);
    } finally {
      clearTimeout(timer);
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
    services: { transcription: {
      inputRequirements: Object.freeze({ encoding: 'flac', sampleRate: 16000, channels: 1,
        delivery: 'inline', cancellation: 'deadline-only', maxDurationSeconds: 60, maxPreparedBytes: 4 * 1024 * 1024 }),
      sync: async ({ audio, content, signal, timeoutMs }) => {
      try {
        checkAbort(signal);
        const speech = getClient();
        // Resolve ADC before the generated recognize wrapper; initialization errors
        // are then caught here instead of the wrapper's detached initialization catch.
        const started = Date.now();
        await initialize(signal, timeoutMs);
        checkAbort(signal);
        const remainingMs = timeoutMs - (Date.now() - started);
        if (remainingMs <= 0) throw new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.');
        const [response] = await speech.recognize({
          recognizer: `projects/${config.project}/locations/${config.location}/recognizers/_`,
          config: { autoDecodingConfig: {}, model: config.model, languageCodes: [config.language] },
          content: audio ? audio.content : content
        }, { timeout: remainingMs, retry: null });
        // This SDK's public promise is not cancellable. Keep admission until the RPC
        // settles or its deadline expires, then discard results for a disconnected client.
        checkAbort(signal);
        if (!response || typeof response !== 'object' || Array.isArray(response) ||
            (response.results !== undefined && !Array.isArray(response.results)) ||
            (response.results || []).some(result => !result || typeof result !== 'object' || Array.isArray(result) ||
              (result.alternatives !== undefined && !Array.isArray(result.alternatives)) ||
              (result.alternatives || []).some(alternative => !alternative || typeof alternative !== 'object' ||
                Array.isArray(alternative) || (alternative.transcript !== undefined && typeof alternative.transcript !== 'string')))) {
          throw new TranscriptionError(502, 'TRANSCRIPTION_FAILED', 'Transcription failed. Please try again later.');
        }
        const text = (response.results || []).map(result => result.alternatives?.[0]?.transcript?.trim() || '').filter(Boolean).join('\n');
        if (!text) throw new TranscriptionError(422, 'NO_SPEECH', 'No speech was recognized. Please try a clearer recording.');
        return successResult({ response: text });
      } catch (error) { return failureResult(mapGoogleSpeechError(error)); }
    } } },
    close: async () => { if (client) await client.close(); }
  };
}
module.exports = { createGoogleSpeechProvider, mapGoogleSpeechError };
