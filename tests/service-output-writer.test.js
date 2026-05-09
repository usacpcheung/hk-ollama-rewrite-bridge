const test = require('node:test');
const assert = require('node:assert/strict');

const {
  writeRewriteJsonSuccess,
  writeRewriteStreamText,
  writeRewriteStreamDone,
  writeRewriteStreamError,
  extractT2AAudioOutput,
  writeT2ABinary,
  writeT2ABase64Json,
  writeT2AOutput
} = require('../lib/service-output-writer');

function createMockResponse() {
  return {
    statusCode: null,
    headers: {},
    jsonBody: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      if (typeof name === 'object') {
        Object.assign(this.headers, name);
        return this;
      }

      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.jsonBody = payload;
      return this;
    },
    end(payload) {
      this.body = payload;
      return this;
    }
  };
}

function createRewriteService() {
  return {
    postProcessOutput: ({ payload }) => ({
      ...payload,
      ...(typeof payload.result === 'string' ? { result: `processed:${payload.result}` } : {}),
      ...(typeof payload.response === 'string' ? { response: `processed:${payload.response}` } : {})
    })
  };
}

function createStreamWriter() {
  const chunks = [];
  return {
    chunks,
    writeChunk: (payload) => chunks.push(payload),
    writeDone: (payload) => chunks.push({ response: '', done: true, ...payload })
  };
}

test('writeRewriteJsonSuccess includes ok, result, and usage', () => {
  const res = createMockResponse();

  writeRewriteJsonSuccess({
    res,
    service: createRewriteService(),
    response: '正式內容',
    usage: { total_tokens: 7 }
  });

  assert.deepEqual(res.jsonBody, {
    ok: true,
    result: 'processed:正式內容',
    usage: { total_tokens: 7 }
  });
});

test('writeRewriteJsonSuccess omits usage when absent', () => {
  const res = createMockResponse();

  writeRewriteJsonSuccess({
    res,
    service: createRewriteService(),
    response: '正式內容'
  });

  assert.deepEqual(res.jsonBody, {
    ok: true,
    result: 'processed:正式內容'
  });
});

test('rewrite stream helpers preserve public chunk and done shapes', () => {
  const streamWriter = createStreamWriter();

  writeRewriteStreamText({
    streamWriter,
    service: createRewriteService(),
    text: '串流內容'
  });
  writeRewriteStreamDone({ streamWriter, doneReason: 'stop' });

  assert.deepEqual(streamWriter.chunks, [
    { response: 'processed:串流內容', done: false },
    { response: '', done: true, done_reason: 'stop' }
  ]);
});

test('rewrite stream error helper preserves pass-through and mapped error status behavior', () => {
  const errors = [];
  const streamWriter = {
    writeError: (payload) => errors.push(payload)
  };

  writeRewriteStreamError({
    streamWriter,
    error: {
      code: 'PROVIDER_STREAM_ERROR',
      message: 'provider failed',
      detail: 'provider_detail'
    }
  });
  writeRewriteStreamError({
    streamWriter,
    error: { code: 'PROVIDER_ERROR', message: 'mapped failed' },
    defaultStatus: 502
  });

  assert.deepEqual(errors, [
    { code: 'PROVIDER_STREAM_ERROR', message: 'provider failed', detail: 'provider_detail' },
    { code: 'PROVIDER_ERROR', message: 'mapped failed', status: 502 }
  ]);
});

test('extractT2AAudioOutput reads audio from output.meta.audio', () => {
  const audioBuffer = Buffer.from('meta audio');

  const result = extractT2AAudioOutput({
    meta: {
      audio: audioBuffer,
      format: 'wav',
      contentType: 'audio/wav',
      provider: { traceId: 'trace-meta' }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.audioBuffer, audioBuffer);
  assert.equal(result.format, 'wav');
  assert.equal(result.contentType, 'audio/wav');
  assert.deepEqual(result.providerMeta, { traceId: 'trace-meta' });
});

test('extractT2AAudioOutput falls back to audio artifact data', () => {
  const audioBuffer = Buffer.from('artifact audio');

  const result = extractT2AAudioOutput({
    artifacts: [
      {
        kind: 'audio',
        data: audioBuffer,
        format: 'mp3',
        contentType: 'audio/mpeg'
      }
    ],
    meta: {
      provider: { traceId: 'trace-artifact' }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.audioBuffer, audioBuffer);
  assert.equal(result.format, 'mp3');
  assert.equal(result.contentType, 'audio/mpeg');
  assert.deepEqual(result.providerMeta, { traceId: 'trace-artifact' });
});

test('writeT2ABinary sets stable binary response headers and body', () => {
  const res = createMockResponse();
  const audioBuffer = Buffer.from('binary audio');

  writeT2ABinary({
    res,
    audio: {
      audioBuffer,
      format: 'mp3',
      contentType: 'audio/mpeg'
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(res.headers['Content-Length'], String(audioBuffer.length));
  assert.equal(res.headers['Content-Disposition'], 'inline; filename="speech.mp3"');
  assert.equal(res.body, audioBuffer);
});

test('writeT2ABase64Json preserves current public field names', () => {
  const res = createMockResponse();
  const audioBuffer = Buffer.from('json audio');

  writeT2ABase64Json({
    res,
    audio: {
      audioBuffer,
      format: 'mp3',
      contentType: 'audio/mpeg',
      providerMeta: { traceId: 'trace-json' }
    }
  });

  assert.deepEqual(Object.keys(res.jsonBody).sort(), [
    'audio',
    'contentType',
    'format',
    'mime',
    'ok',
    'provider',
    'size'
  ]);
  assert.deepEqual(res.jsonBody, {
    ok: true,
    audio: audioBuffer.toString('base64'),
    format: 'mp3',
    mime: 'audio/mpeg',
    contentType: 'audio/mpeg',
    size: audioBuffer.length,
    provider: { traceId: 'trace-json' }
  });
});

test('writeT2AOutput returns existing controlled provider error when audio is missing', () => {
  const res = createMockResponse();

  const result = writeT2AOutput({
    res,
    output: { meta: { format: 'mp3' } },
    responseMode: 'binary'
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 502,
      code: 'PROVIDER_ERROR',
      message: 'Provider response did not include audio data'
    }
  });
  assert.equal(res.body, null);
  assert.equal(res.jsonBody, null);
});
