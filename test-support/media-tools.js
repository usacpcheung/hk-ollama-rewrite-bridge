const { spawnSync } = require('node:child_process');

const ffmpeg = process.env.TEST_FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.TEST_FFPROBE_PATH || 'ffprobe';
const isAvailable = (binary) => {
  const result = spawnSync(binary, ['-version'], {
    windowsHide: true,
    timeout: 3000,
    killSignal: 'SIGKILL',
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
};
const ffmpegAvailable = isAvailable(ffmpeg);
const ffprobeAvailable = isAvailable(ffprobe);

module.exports = {
  ffmpeg,
  ffprobe,
  ffprobeAvailable,
  available: ffmpegAvailable && ffprobeAvailable,
  skipReason: 'Install FFmpeg/FFprobe or set TEST_FFMPEG_PATH and TEST_FFPROBE_PATH',
};
