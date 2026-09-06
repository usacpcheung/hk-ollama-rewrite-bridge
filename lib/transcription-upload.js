const Busboy = require('busboy');
const fs = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { TranscriptionError, checkAbort } = require('./transcription-errors');

async function receiveAudio(req, target, config, signal) {
  checkAbort(signal);
  if (!/^multipart\/form-data\b/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) {
    throw new TranscriptionError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send multipart/form-data with one audio file.');
  }
  const totalLimit = config.maxBytes + 65536;
  const tooLarge = () => new TranscriptionError(413, 'AUDIO_TOO_LARGE', 'Audio upload exceeds the size limit.');
  if (Number(req.headers['content-length']) > totalLimit) throw tooLarge();
  let parser;
  try {
    parser = Busboy({ headers: req.headers, limits: {
      files: 1, fields: 0, parts: 2, fileSize: config.maxBytes + 1, headerPairs: 32
    } });
  } catch {
    throw new TranscriptionError(400, 'INVALID_UPLOAD', 'Invalid multipart upload.');
  }
  let total = 0;
  let bytes = 0;
  let seenFile = false;
  let writePromise = Promise.resolve();
  let fileStream;
  let output;
  const counter = new Transform({ transform(chunk, _encoding, callback) {
    total += chunk.length;
    callback(total > totalLimit ? tooLarge() : null, chunk);
  } });
  let failure;
  let finish;
  const completed = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  function fail(error) {
    if (failure) return;
    failure = error instanceof TranscriptionError ? error : new TranscriptionError(400, 'INVALID_UPLOAD', 'Invalid or interrupted audio upload.');
    req.unpipe(counter);
    req.pause();
    counter.unpipe(parser);
    counter.destroy();
    // Avoid destroying Busboy inside its own synchronous file/header callback.
    queueMicrotask(() => {
      fileStream?.destroy();
      output?.destroy();
      parser.destroy();
      finish.reject(failure);
    });
  }
  const cancel = () => fail(signal.reason);
  const requestError = () => fail(new TranscriptionError(400, 'INVALID_UPLOAD', 'Interrupted audio upload.'));
  const timer = setTimeout(() => fail(new TranscriptionError(408, 'UPLOAD_TIMEOUT', 'Audio upload timed out.')), config.uploadMs);
  signal.addEventListener('abort', cancel, { once: true });
  req.once('aborted', requestError);
  req.once('error', requestError);
  counter.on('error', fail);
  parser.on('error', fail);
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) {
    parser.on(event, () => fail(new TranscriptionError(400, 'INVALID_UPLOAD', 'Send exactly one file in the audio field.')));
  }
  parser.on('file', (name, stream) => {
    fileStream = stream;
    // Filename and declared MIME type are deliberately not used as media evidence.
    if (seenFile || name !== 'audio') {
      stream.resume();
      fail(new TranscriptionError(400, 'INVALID_UPLOAD', 'Send exactly one file in the audio field.'));
      return;
    }
    seenFile = true;
    output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    stream.on('data', chunk => { bytes += chunk.length; if (bytes > config.maxBytes) fail(tooLarge()); });
    stream.on('limit', () => fail(tooLarge()));
    writePromise = pipeline(stream, output).catch(error => { fail(error); });
  });
  parser.once('close', () => { if (!failure) finish.resolve(); });
  try {
    req.pipe(counter).pipe(parser);
    await completed;
    await writePromise;
    if (failure) throw failure;
    if (!seenFile || !bytes) throw new TranscriptionError(400, 'INVALID_UPLOAD', 'An audio file is required.');
    return bytes;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    req.removeListener('aborted', requestError);
    req.removeListener('error', requestError);
    req.unpipe(counter);
    await writePromise;
  }
}
module.exports = { receiveAudio };
