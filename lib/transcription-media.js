const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TranscriptionError, checkAbort } = require('./transcription-errors');

const INPUT_FORMATS = 'mov,matroska,webm,ogg,wav,flac,mp3';
function runMedia(command, args, { signal, timeoutMs }) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    let failure;
    const stop = (error) => { failure ||= error; child.kill('SIGKILL'); };
    const cancel = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new TranscriptionError(504, 'AUDIO_PROCESSING_TIMEOUT', 'Audio processing timed out.')), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 32768) stop(new TranscriptionError(422, 'INVALID_AUDIO', 'Invalid audio metadata.'));
    });
    child.once('error', () => { failure ||= new TranscriptionError(503, 'AUDIO_PROCESSOR_UNAVAILABLE', 'Audio processing is unavailable.'); });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0) reject(new TranscriptionError(422, 'INVALID_AUDIO', 'The audio file could not be decoded.'));
      else resolve(output);
    });
    if (signal.aborted) cancel();
  });
}

function validateMedia(metadata) {
  const streams = metadata.streams || [];
  const audio = streams.filter(stream => stream.codec_type === 'audio');
  if (audio.length !== 1 || streams.some(stream => stream.codec_type !== 'audio')) {
    throw new TranscriptionError(415, 'UNSUPPORTED_AUDIO', 'Use a file containing a single audio stream and no video.');
  }
  const stream = audio[0];
  const formats = String(metadata.format?.format_name || '').split(',');
  const codec = stream.codec_name;
  const allowed = (formats.includes('flac') && codec === 'flac') ||
    (formats.includes('wav') && ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'].includes(codec)) ||
    (formats.includes('mp3') && codec === 'mp3') ||
    (formats.includes('mov') && codec === 'aac') ||
    (formats.some(format => ['ogg', 'webm', 'matroska'].includes(format)) && codec === 'opus');
  if (!allowed || ![1, 2].includes(stream.channels) ||
      !Number.isFinite(Number(stream.sample_rate)) || Number(stream.sample_rate) < 8000 || Number(stream.sample_rate) > 192000) {
    throw new TranscriptionError(415, 'UNSUPPORTED_AUDIO', 'Use WAV, FLAC, MP3, AAC in M4A/MP4, or Opus in WebM/OGG with one or two channels.');
  }
}

async function normalizeAudio(input, directory, config, signal, run = runMedia) {
  const deadline = Date.now() + config.conversionMs;
  const execute = (binary, args) => run(binary, args, { signal, timeoutMs: Math.max(1, deadline - Date.now()) });
  const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS];
  const rawMetadata = await execute(config.ffprobe, ['-v', 'error', ...inputOptions,
    '-show_entries', 'format=format_name:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', input]);
  let metadata;
  try { metadata = JSON.parse(rawMetadata); } catch { throw new TranscriptionError(422, 'INVALID_AUDIO', 'Invalid audio metadata.'); }
  validateMedia(metadata);
  const pcm = path.join(directory, 'decoded.pcm');
  const flac = path.join(directory, 'normalized.flac');
  // Decode one extra second to detect overlong audio without trusting container duration.
  // The output duration bound prevents compressed duration bombs from filling the disk.
  await execute(config.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-threads', '1', ...inputOptions,
    '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-filter_threads', '1', '-threads', '1', '-t', String(config.maxSeconds + 1),
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', '-n', pcm]);
  const { size } = await fs.stat(pcm);
  const durationSeconds = size / 32000;
  if (!size || size % 2) throw new TranscriptionError(422, 'INVALID_AUDIO', 'The audio contains no decodable samples.');
  if (durationSeconds > config.maxSeconds) throw new TranscriptionError(413, 'AUDIO_TOO_LONG', `Maximum recording duration is ${config.maxSeconds} seconds.`);
  checkAbort(signal);
  await execute(config.ffmpeg, ['-nostdin', '-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1',
    '-protocol_whitelist', 'file,pipe', '-i', pcm, '-map_metadata', '-1', '-threads', '1',
    '-c:a', 'flac', '-compression_level', '0', '-n', flac]);
  const content = await fs.readFile(flac);
  if (!content.length || content.length > 4 * 1024 * 1024) {
    throw new TranscriptionError(422, 'INVALID_AUDIO', 'Invalid normalized audio.');
  }
  return { content, durationSeconds };
}
module.exports = { runMedia, validateMedia, normalizeAudio };
