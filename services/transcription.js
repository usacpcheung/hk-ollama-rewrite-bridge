const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createProviderAdapter } = require('../lib/provider-adapter');
const { createGoogleSpeechProvider } = require('../providers/google-speech');
const { createFixedWindowRateLimiter } = require('../middleware/rate-limit');
const { readTranscriptionConfig } = require('../lib/transcription-config');
const { TranscriptionError, aborted, checkAbort } = require('../lib/transcription-errors');
const { createConversionSlots } = require('../lib/transcription-slots');
const { prepareDirectory, createJobDirectory } = require('../lib/transcription-files');
const { receiveAudio } = require('../lib/transcription-upload');
const { normalizeAudio } = require('../lib/transcription-media');

function createTranscriptionService({ config = readTranscriptionConfig(), provider, normalize = normalizeAudio } = {}) {
  const paths = ['/transcriptions', '/api/transcriptions'];
  if (!config.enabled) return { paths, middleware: [(_req, res) => res.status(503).json({
    ok: false, error: { code: 'TRANSCRIPTION_DISABLED', message: 'Transcription is not enabled.' }
  })] };
  const adapter = createProviderAdapter(provider || createGoogleSpeechProvider(config));
  const acquireConversion = createConversionSlots(config.conversions);
  const users = new Set();
  let active = 0;
  let storageFailed = false;
  const directoryReady = prepareDirectory(config.directory).then(() => true, () => {
    storageFailed = true;
    console.error(JSON.stringify({ level: 'error', code: 'TRANSCRIPTION_STORAGE_UNAVAILABLE' }));
    return false;
  });
  const limiter = createFixedWindowRateLimiter({
    policyScope: 'transcription', getPolicy: () => ({ windowSec: 60, maxRequests: config.ratePerMinute })
  });
  async function handler(req, res) {
    res.set('Cache-Control', 'no-store');
    const requestId = crypto.randomUUID();
    const user = req.auth?.email;
    function sendError(error) {
      if (res.destroyed || res.writableEnded) return;
      if ([429, 503].includes(error.status)) res.set('Retry-After', '10');
      // Early rejection must not leave an unbounded unread upload on a keep-alive socket.
      if (!req.complete) {
        req.pause();
        res.set('Connection', 'close');
        res.once('finish', () => req.destroy());
      }
      res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message }, requestId });
    }
    if (!user) return sendError(new TranscriptionError(401, 'AUTH_REQUIRED', 'Login required'));
    const origin = req.get('Origin');
    if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && !config.allowedOrigins.includes(origin))) {
      return sendError(new TranscriptionError(403, 'TRANSCRIPTION_ORIGIN_FORBIDDEN', 'Use the worksheet application to upload recordings.'));
    }
    if (storageFailed) return sendError(new TranscriptionError(503, 'TRANSCRIPTION_UNAVAILABLE', 'Transcription storage is unavailable.'));
    if (users.has(user)) return sendError(new TranscriptionError(429, 'TRANSCRIPTION_ALREADY_ACTIVE', 'You already have a transcription in progress.'));
    if (active >= config.concurrency) return sendError(new TranscriptionError(503, 'TRANSCRIPTION_BUSY', 'Transcription is busy. Please retry shortly.'));
    // Reserve capacity before reading any audio, including time spent receiving uploads.
    active++;
    users.add(user);
    const controller = new AbortController();
    const signal = controller.signal;
    const disconnect = () => { if (!res.writableEnded) controller.abort(aborted()); };
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    const timer = setTimeout(() => {
      const error = new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out.');
      controller.abort(error);
      sendError(error);
    }, config.totalMs);
    let directory;
    let responseError;
    const started = Date.now();
    try {
      if (!await directoryReady) throw new TranscriptionError(503, 'TRANSCRIPTION_UNAVAILABLE', 'Transcription storage is unavailable.');
      checkAbort(signal);
      directory = await createJobDirectory(config.directory);
      const input = path.join(directory, 'upload');
      await receiveAudio(req, input, config, signal);
      const release = await acquireConversion(signal);
      let audio;
      const conversionStarted = Date.now();
      try { audio = await normalize(input, directory, config, signal); } finally { release(); }
      const conversionMs = Date.now() - conversionStarted;
      checkAbort(signal);
      const providerStarted = Date.now();
      const result = await adapter.invokeSync({ serviceId: 'transcription', requestId,
        payload: { content: audio.content, signal }, timeoutMs: Math.min(config.googleMs, Math.max(1, config.totalMs - (Date.now() - started))) });
      checkAbort(signal);
      if (!result.ok) throw new TranscriptionError(result.error.status, result.error.code, result.error.message);
      const transcriptionMs = Date.now() - providerStarted;
      // Delete audio before returning success; no audio or result is retained by the bridge.
      try { await fs.rm(directory, { recursive: true, force: true }); }
      catch (error) { storageFailed = true; throw error; }
      directory = null;
      checkAbort(signal);
      res.json({ ok: true, result: result.data.response, durationSeconds: audio.durationSeconds, requestId,
        timings: { conversionMs, transcriptionMs, totalMs: Date.now() - started } });
    } catch (error) {
      const safeError = error instanceof TranscriptionError ? error : new TranscriptionError(503, 'TRANSCRIPTION_UNAVAILABLE', 'Transcription is temporarily unavailable.');
      responseError = safeError;
    } finally {
      clearTimeout(timer);
      req.removeListener('aborted', disconnect);
      res.removeListener('close', disconnect);
      if (directory) {
        try { await fs.rm(directory, { recursive: true, force: true }); }
        catch {
          storageFailed = true;
          console.error(JSON.stringify({ level: 'error', code: 'TRANSCRIPTION_CLEANUP_FAILED', requestId }));
        }
      }
      active--;
      users.delete(user);
      if (responseError) sendError(responseError);
    }
  }
  return { paths, middleware: [limiter, handler] };
}
module.exports = { createTranscriptionService };
