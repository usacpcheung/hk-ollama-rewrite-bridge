const { TranscriptionError, checkAbort } = require('./transcription-errors');

const failed = () => new TranscriptionError(502, 'TRANSCRIPTION_FAILED', 'Transcription failed. Please try again later.');

async function recognizeAudio({ adapter, audio, inputPlan, requestId, signal, timeoutMs }) {
  checkAbort(signal);
  if (!Buffer.isBuffer(audio?.content) || !audio.content.length || audio.content.length > inputPlan.maxPreparedBytes ||
      !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0 || audio.durationSeconds > inputPlan.maxDurationSeconds) {
    throw new TranscriptionError(422, 'INVALID_AUDIO', 'Invalid normalized audio.');
  }
  // Abort is a request, not proof of settlement. Always await the native promise,
  // even for an abortable adapter, so admission/files cannot be released early.
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.')), timeoutMs);
  try {
    checkAbort(controller.signal);
    const result = await adapter.invokeSync({ serviceId: 'transcription', requestId, timeoutMs, signal: controller.signal,
      payload: { audio: { content: audio.content, durationSeconds: audio.durationSeconds,
        encoding: inputPlan.encoding, sampleRate: inputPlan.sampleRate, channels: inputPlan.channels } } });
    if (Date.now() >= deadline) controller.abort(new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.'));
    checkAbort(controller.signal);
    if (result?.ok === false) {
      const error = result.error;
      if (!Number.isInteger(error?.status) || error.status < 400 || error.status > 599 ||
          typeof error.code !== 'string' || !error.code || typeof error.message !== 'string') throw failed();
      throw new TranscriptionError(error.status, error.code, error.message);
    }
    const text = result?.data?.output?.text;
    if (result?.ok !== true || typeof text !== 'string') throw failed();
    if (!text.trim()) throw new TranscriptionError(422, 'NO_SPEECH', 'No speech was recognized. Please try a clearer recording.');
    return text;
  } catch (error) {
    checkAbort(controller.signal);
    // Adapters own translation of native errors. Unexpected exceptions must never
    // expose SDK messages, credentials or audio through the public response.
    throw error instanceof TranscriptionError ? error : failed();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
module.exports = { recognizeAudio };
