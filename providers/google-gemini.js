const { createInvocationAbort } = require('../lib/invocation-abort');
const { successResult, failureResult, streamTextEvent, streamDoneEvent } = require('../lib/bridge-contract');

const LIMIT = 1024 * 1024;
const fault = (code = 'GEMINI_INVALID_RESPONSE', status = 502, message = 'Invalid Gemini response.') =>
  Object.assign(new Error(message), { bridgeError: { code, status, message } });

// Abort the waiter, not shared credential discovery. Only one credential operation
// may remain in flight per adapter, even when multiple callers time out.
function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function decode(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) throw fault();
  if (payload.promptFeedback?.blockReason) throw fault('GEMINI_CONTENT_BLOCKED', 422, 'Gemini blocked this rewrite.');
  if (!Array.isArray(payload.candidates) || payload.candidates.length !== 1) throw fault();
  const candidate = payload.candidates[0];
  if (!candidate || (candidate.index !== undefined && candidate.index !== 0)) throw fault();
  const reason = candidate.finishReason;
  if (reason === 'MAX_TOKENS') throw fault('GEMINI_OUTPUT_TRUNCATED', 502, 'Gemini output budget exhausted; rewrite is incomplete.');
  if (reason && reason !== 'STOP') throw fault('GEMINI_CONTENT_BLOCKED', 422, 'Gemini did not complete this rewrite.');
  const parts = candidate.content?.parts ?? [];
  if (!Array.isArray(parts)) throw fault();
  let text = '';
  for (const part of parts) {
    if (!part || typeof part !== 'object' || (part.thought !== undefined && typeof part.thought !== 'boolean')) throw fault();
    if (part.thought === true) continue;
    if (typeof part.text !== 'string') throw fault();
    text += part.text;
  }
  const usage = {};
  for (const key of ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount']) {
    const value = payload.usageMetadata?.[key];
    if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
  }
  return { text, done: reason === 'STOP', usage: Object.keys(usage).length ? usage : undefined };
}

function createGoogleGeminiProvider({ project, location = 'global', model = 'gemini-3.8-flash', credentialsFile, sdkLogging = process.env.GOOGLE_SDK_NODE_LOGGING,
  fetchImpl = globalThis.fetch, getAccessToken } = {}) {
  if (sdkLogging) throw new Error('Unset GOOGLE_SDK_NODE_LOGGING when Google rewriting is selected.');
  if (!project || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) throw new Error('REWRITE_GOOGLE_PROJECT must be a Google project ID or number.');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(location)) throw new Error('Invalid REWRITE_GOOGLE_LOCATION.');
  if (!/^gemini-[a-z0-9][a-z0-9.-]{0,100}$/.test(model)) throw new Error('Invalid REWRITE_GOOGLE_MODEL.');
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const endpoint = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}`;
  let auth;
  let pendingToken;
  function token() {
    if (!pendingToken) {
      pendingToken = Promise.resolve().then(async () => {
        if (getAccessToken) return getAccessToken();
        if (!auth) {
          const { GoogleAuth } = require('google-auth-library');
          auth = new GoogleAuth({ keyFilename: credentialsFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        }
        const client = await auth.getClient();
        return (await client.getAccessToken()).token;
      }).finally(() => { pendingToken = undefined; });
    }
    return pendingToken;
  }
  function mapError(error) {
    if (error?.bridgeError) return error.bridgeError;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { code: 'MODEL_TIMEOUT', status: 504, message: 'Model response timed out. Please retry.' };
    return { code: 'GEMINI_ERROR', status: 502, message: 'Failed to reach Gemini.' };
  }
  async function invoke(request, streaming) {
    const { controller, dispose } = createInvocationAbort(request.signal, request.timeoutMs ?? 30000);
    const signal = controller.signal;
    let reader;
    try {
      signal.throwIfAborted();
      let accessToken;
      try { accessToken = await waitFor(token(), signal); }
      catch (error) {
        signal.throwIfAborted();
        throw fault('GEMINI_AUTH_ERROR', 503, 'Google credentials could not authorize rewriting.');
      }
      signal.throwIfAborted();
      if (typeof accessToken !== 'string' || !accessToken) throw fault('GEMINI_AUTH_ERROR', 503, 'Google credentials could not authorize rewriting.');
      const response = await fetchImpl(`${endpoint}:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: request.instructions }] },
          contents: [{ role: 'user', parts: [{ text: request.text }] }],
          generationConfig: { candidateCount: 1, maxOutputTokens: request.outputBudget,
            thinkingConfig: { thinkingLevel: 'LOW' } } })
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw fault('GEMINI_AUTH_ERROR', 503, 'Google denied the rewrite request; check permissions and billing controls.');
        if (response.status === 429) throw fault('GEMINI_QUOTA_EXCEEDED', 429, 'Google rewrite quota or spending limit reached.');
        throw fault('GEMINI_ERROR', 502, 'Gemini request failed.');
      }
      if (!response.body) throw fault();
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      let received = 0;
      let text = '';
      let usage;
      let done = false;
      const emit = async event => {
        signal.throwIfAborted();
        if (request.onChunk) await request.onChunk(event, { signal });
        signal.throwIfAborted();
      };
      const processEvent = async record => {
        const data = record.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) return;
        const chunk = decode(JSON.parse(data));
        usage = chunk.usage || usage;
        text += chunk.text;
        if (chunk.done && !text.trim()) throw fault();
        if (chunk.text) await emit(streamTextEvent({ text: chunk.text }));
        done = chunk.done;
      };
      while (!done) {
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) {
          buffer += decoder.decode();
          break;
        }
        received += next.value.byteLength;
        if (received > LIMIT) throw fault();
        buffer += decoder.decode(next.value, { stream: true });
        if (streaming) {
          let boundary;
          while (!done && (boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
            const record = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            await processEvent(record);
          }
        }
      }
      if (!streaming) {
        const chunk = decode(JSON.parse(buffer));
        text = chunk.text; usage = chunk.usage; done = chunk.done;
      }
      if (!done || !text.trim()) throw fault();
      signal.throwIfAborted();
      if (streaming) await emit(streamDoneEvent({ reason: 'stop', usage }));
      return successResult({ response: text, usage, doneReason: 'stop' });
    } catch (error) {
      const malformed = error instanceof SyntaxError || (error instanceof TypeError && reader);
      return failureResult(mapError(signal.aborted ? signal.reason : malformed ? fault() : error));
    } finally {
      dispose();
      if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    }
  }
  return { services: { rewrite: { sync: request => invoke(request, false), stream: request => invoke(request, true) } },
    mapError, getInfo: () => ({ provider: 'google-gemini', model, location, project }) };
}
module.exports = { createGoogleGeminiProvider };
