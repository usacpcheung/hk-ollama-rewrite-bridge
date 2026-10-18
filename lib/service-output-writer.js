const { writeJsonSuccess } = require('./output-writer');

function writeRewriteJsonSuccess({ res, service, response, usage }) {
  const processedOutput = service.postProcessOutput({ payload: { result: response } });
  return writeJsonSuccess(res, {
    result: processedOutput?.result || '',
    ...(usage ? { usage } : {})
  });
}

function writeRewriteStreamText({ streamWriter, service, text, signal, converter, final = false }) {
  const processedChunk = converter
    ? { response: converter.write(text, final) }
    : service.postProcessOutput({ payload: { response: text } });
  if (converter && !processedChunk.response) return;
  return streamWriter.writeChunk({ response: processedChunk?.response || '', done: false }, { signal });
}

function writeRewriteStreamDone({ streamWriter, doneReason, signal }) {
  return streamWriter.writeDone(doneReason ? { done_reason: doneReason } : {}, { signal });
}

function writeRewriteStreamError({ streamWriter, error, defaultStatus }) {
  const status = error.status || defaultStatus;
  return streamWriter.writeError({
    ...error,
    ...(status ? { status } : {})
  });
}

// Metadata must describe the selected audio, never an unrelated first artifact.
function normalizeAudioMetadata(sources) {
  const types = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm' };
  const formatsByMime = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/pcm': 'pcm' };
  const formats = [];
  for (const source of sources) {
    if (source?.format != null) {
      if (typeof source.format !== 'string') return null;
      const format = source.format.trim().toLowerCase();
      if (!Object.hasOwn(types, format)) return null;
      formats.push(format);
    }
    for (const mime of [source?.contentType, source?.mime]) {
      if (mime == null) continue;
      if (typeof mime !== 'string') return null;
      const type = mime.split(';', 1)[0].trim().toLowerCase();
      if (!Object.hasOwn(formatsByMime, type)) return null;
      formats.push(formatsByMime[type]);
    }
  }
  const format = formats[0] || 'mp3';
  if (formats.some(value => value !== format)) return null;
  return { format, contentType: types[format] };
}

function extractT2AAudioOutput(output = {}) {
  const audioArtifact = Array.isArray(output?.artifacts)
    ? output.artifacts.find(artifact => artifact?.kind === 'audio') : null;
  const meta = output?.meta;
  const hasMetaAudio = meta?.audio != null;
  const audioBuffer = hasMetaAudio ? meta.audio : audioArtifact?.data;
  const providerMeta = meta?.provider || null;

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

  // Preserve legacy meta.audio priority, without borrowing labels from different
  // artifact bytes. Global audio metadata can supplement artifact-only output.
  const sources = hasMetaAudio
    ? [meta, ...(audioArtifact?.data === audioBuffer ? [audioArtifact] : [])]
    : [audioArtifact, meta];
  const metadata = normalizeAudioMetadata(sources);
  if (!metadata) {
    return { ok: false, error: { status: 502, code: 'PROVIDER_ERROR',
      message: 'Provider response contained invalid audio metadata' } };
  }

  return { ok: true, audioBuffer, ...metadata, providerMeta };
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
