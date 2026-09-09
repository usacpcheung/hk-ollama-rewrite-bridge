const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { normalizeAudio, validateMedia, runMedia } = require('../lib/transcription-media');
const { TranscriptionError } = require('../lib/transcription-errors');

const ffmpeg = process.env.TEST_FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.TEST_FFPROBE_PATH || 'ffprobe';
const available = !spawnSync(ffmpeg, ['-version'], { windowsHide: true }).error &&
  !spawnSync(ffprobe, ['-version'], { windowsHide: true }).error;
const signal = () => new AbortController().signal;

test('media validation rejects video, multiple audio streams, unsupported codecs and channels', () => {
  const audio = { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' };
  validateMedia({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [audio] });
  for (const streams of [[], [audio, audio], [audio, { codec_type: 'video' }],
    [{ ...audio, channels: 8 }], [{ ...audio, codec_name: 'alac' }]]) {
    assert.throws(() => validateMedia({ format: { format_name: 'mov' }, streams }), { code: 'UNSUPPORTED_AUDIO' });
  }
});

test('decoded sample count enforces duration even if container duration claims otherwise', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-media-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let encoded = false;
  const fakeRun = async (binary, args) => {
    if (binary === 'probe') return JSON.stringify({ format: { format_name: 'wav', duration: '1' },
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '16000' }] });
    if (args.includes('pcm_s16le')) await fs.writeFile(args.at(-1), Buffer.alloc(61 * 32000));
    else encoded = true;
    return '';
  };
  await assert.rejects(normalizeAudio('untrusted', directory, { ffmpeg: 'convert', ffprobe: 'probe', maxSeconds: 60, conversionMs: 1000 }, signal(), fakeRun), { code: 'AUDIO_TOO_LONG' });
  assert.equal(encoded, false);
});

test('media subprocesses have deadlines and respond to cancellation', async () => {
  await assert.rejects(runMedia(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: signal(), timeoutMs: 40 }), { code: 'AUDIO_PROCESSING_TIMEOUT' });
  const controller = new AbortController();
  const operation = runMedia(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 1000 });
  controller.abort(new TranscriptionError(408, 'CANCELLED', 'cancelled'));
  await assert.rejects(operation, { code: 'CANCELLED' });
  await assert.rejects(runMedia('missing-bridge-binary', [], { signal: signal(), timeoutMs: 1000 }), { code: 'AUDIO_PROCESSOR_UNAVAILABLE' });
});

test('real FFmpeg normalizes browser formats and rejects invalid or overlong recordings', { skip: !available && 'Install FFmpeg/FFprobe or set TEST_FFMPEG_PATH and TEST_FFPROBE_PATH' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-real-media-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { ffmpeg, ffprobe, maxSeconds: 60, conversionMs: 15000 };
  for (const [name, codec, container] of [['test.webm', 'libopus', 'webm'], ['test.ogg', 'libopus', 'ogg'],
    ['test.m4a', 'aac', 'ipod'], ['test.wav', 'pcm_s16le', 'wav'], ['test.flac', 'flac', 'flac'], ['test.mp3', 'libmp3lame', 'mp3']]) {
    const job = await fs.mkdtemp(path.join(root, 'job-'));
    const input = path.join(job, name);
    await runMedia(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '2', '-c:a', codec, '-f', container, input], { signal: signal(), timeoutMs: 15000 });
    const result = await normalizeAudio(input, job, config, signal());
    assert.equal(result.content.subarray(0, 4).toString(), 'fLaC');
    assert.ok(result.durationSeconds >= 0.9 && result.durationSeconds < 1.2);
    const metadata = JSON.parse(await runMedia(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(job, 'normalized.flac')], { signal: signal(), timeoutMs: 15000 }));
    assert.equal(metadata.streams[0].channels, 1);
    assert.equal(metadata.streams[0].sample_rate, '16000');
  }
  for (const seconds of [60, 61]) {
    const job = await fs.mkdtemp(path.join(root, 'duration-'));
    const input = path.join(job, 'audio.wav');
    await runMedia(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '16000', '-ac', '1', input], { signal: signal(), timeoutMs: 15000 });
    if (seconds === 60) assert.equal((await normalizeAudio(input, job, config, signal())).durationSeconds, 60);
    else await assert.rejects(normalizeAudio(input, job, config, signal()), { code: 'AUDIO_TOO_LONG' });
  }
  const invalid = path.join(root, 'invalid');
  await fs.writeFile(invalid, 'not audio');
  await assert.rejects(normalizeAudio(invalid, root, config, signal()), { code: 'INVALID_AUDIO' });
});
