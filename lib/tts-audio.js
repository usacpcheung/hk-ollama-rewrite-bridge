const { spawn } = require('node:child_process');
const LIMIT = 24 * 1024 * 1024;
function validateWav(data) {
  if (!Buffer.isBuffer(data) || data.length < 44 || data.length > LIMIT
      || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE'
      || data.readUInt32LE(4) + 8 !== data.length) throw Error('INVALID_AUDIO');
  let fmt, samples, offset = 12;
  for (; offset + 8 <= data.length;) {
    const kind = data.toString('ascii', offset, offset + 4), size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > data.length) throw Error('INVALID_AUDIO');
    if (kind === 'fmt ') {
      if (fmt || size < 16) throw Error('INVALID_AUDIO');
      fmt = data.subarray(offset + 8, end);
    }
    if (kind === 'data') {
      if (samples) throw Error('INVALID_AUDIO');
      samples = data.subarray(offset + 8, end);
    }
    offset = end + (size % 2);
    if (offset > data.length) throw Error('INVALID_AUDIO');
  }
  if (offset !== data.length || !fmt || !samples?.length || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1
      || fmt.readUInt32LE(4) !== 24000 || fmt.readUInt16LE(14) !== 16
      || fmt.readUInt16LE(12) !== 2 || fmt.readUInt32LE(8) !== 48000
      || samples.length % 2 || samples.length > 240 * 48000) throw Error('INVALID_AUDIO');
}
function runConversion(binary, args, input, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe','pipe','ignore'], windowsHide: true });
    let failure, size = 0; const chunks = [];
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const cancel = () => stop(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    child.once('error', () => { failure ||= Error('AUDIO_PROCESSOR_UNAVAILABLE'); });
    child.stdin.on('error', () => stop(Error('AUDIO_CONVERSION_FAILED')));
    child.stdout.on('data', data => { size += data.length; if (size > LIMIT) stop(Error('AUDIO_TOO_LARGE')); else chunks.push(data); });
    child.once('close', code => {
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0 || !size) reject(Error('AUDIO_CONVERSION_FAILED'));
      else resolve(Buffer.concat(chunks));
    });
    if (signal.aborted) cancel();
    child.stdin.end(input);
  });
}
async function convertAudio(input, audio, { signal, ffmpeg }) {
  validateWav(input);
  const mp3 = audio.format === 'mp3';
  const data = await runConversion(ffmpeg, ['-nostdin','-v','error','-xerror','-threads','1',
    '-protocol_whitelist','pipe','-f','wav','-i','pipe:0','-map','0:a:0','-vn','-sn','-dn',
    '-map_metadata','-1','-filter_threads','1','-threads','1','-ac','1','-ar',String(audio.sampleRate),
    ...(mp3 ? ['-c:a','libmp3lame','-b:a',String(audio.bitrate),'-f','mp3'] : ['-c:a','pcm_s16le','-f','s16le']), 'pipe:1'], input, signal);
  signal.throwIfAborted();
  if (audio.format !== 'wav') return data;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(data.length + 36,4); header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(audio.sampleRate,24); header.writeUInt32LE(audio.sampleRate * 2,28);
  header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(data.length,40);
  return Buffer.concat([header,data]);
}
module.exports = { validateWav, convertAudio, runConversion };
