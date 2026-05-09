const { writeJsonSuccess } = require('./output-writer');

function writeRewriteJsonSuccess({ res, service, response, usage }) {
  const processedOutput = service.postProcessOutput({ payload: { result: response } });
  return writeJsonSuccess(res, {
    result: processedOutput?.result || '',
    ...(usage ? { usage } : {})
  });
}

function writeRewriteStreamText({ streamWriter, service, text }) {
  const processedChunk = service.postProcessOutput({ payload: { response: text } });
  streamWriter.writeChunk({ response: processedChunk?.response || '', done: false });
}

function writeRewriteStreamDone({ streamWriter, doneReason }) {
  streamWriter.writeDone(doneReason ? { done_reason: doneReason } : {});
}

function writeRewriteStreamError({ streamWriter, error, defaultStatus }) {
  const status = error.status || defaultStatus;
  streamWriter.writeError({
    ...error,
    ...(status ? { status } : {})
  });
}

function extractT2AAudioOutput(output = {}) {
  const audioArtifact = output?.artifacts?.find((artifact) => artifact?.kind === 'audio');
  const fallbackArtifact = output?.artifacts?.[0];
  const audioBuffer = output?.meta?.audio || audioArtifact?.data;
  const format = output?.meta?.format || fallbackArtifact?.format || 'mp3';
  const contentType =
    output?.meta?.contentType || output?.meta?.mime || fallbackArtifact?.contentType || 'audio/mpeg';
  const providerMeta = output?.meta?.provider || null;

  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return {
      ok: false,
      error: {
        status: 502,
        code: 'PROVIDER_ERROR',
        message: 'Provider response did not include audio data'
      }
    };
  }

  return {
    ok: true,
    audioBuffer,
    format,
    contentType,
    providerMeta
  };
}

function writeT2ABase64Json({ res, audio }) {
  return writeJsonSuccess(res, {
    audio: audio.audioBuffer.toString('base64'),
    format: audio.format,
    mime: audio.contentType,
    contentType: audio.contentType,
    size: audio.audioBuffer.length,
    provider: audio.providerMeta
  });
}

function writeT2ABinary({ res, audio }) {
  res.status(200);
  res.set('Content-Type', audio.contentType);
  res.set('Content-Length', String(audio.audioBuffer.length));
  res.set('Content-Disposition', `inline; filename="speech.${audio.format}"`);
  return res.end(audio.audioBuffer);
}

function writeT2AOutput({ res, output, responseMode }) {
  const audio = extractT2AAudioOutput(output);
  if (!audio.ok) {
    return audio;
  }

  if (responseMode === 'base64_json') {
    writeT2ABase64Json({ res, audio });
    return { ok: true };
  }

  writeT2ABinary({ res, audio });
  return { ok: true };
}

module.exports = {
  writeRewriteJsonSuccess,
  writeRewriteStreamText,
  writeRewriteStreamDone,
  writeRewriteStreamError,
  extractT2AAudioOutput,
  writeT2ABase64Json,
  writeT2ABinary,
  writeT2AOutput
};
