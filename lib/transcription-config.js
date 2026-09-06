const path = require('node:path');
const os = require('node:os');

function readTranscriptionConfig(env = process.env) {
  const rawEnabled = String(env.TRANSCRIPTION_ENABLED || 'false').toLowerCase();
  if (!['true', 'false', '1', '0'].includes(rawEnabled)) throw new Error('Invalid TRANSCRIPTION_ENABLED');
  const enabled = ['true', '1'].includes(rawEnabled);
  // Disabled installations do not need credentials, binaries, or transcription settings.
  if (!enabled) return { enabled: false };
  if (env.GOOGLE_SDK_NODE_LOGGING) throw new Error('Disable GOOGLE_SDK_NODE_LOGGING before enabling transcription');
  function integer(name, fallback, min, max) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  const project = env.TRANSCRIPTION_GOOGLE_PROJECT || '';
  const location = env.TRANSCRIPTION_GOOGLE_LOCATION || 'us';
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_PROJECT');
  if (!['us', 'eu'].includes(location)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_LOCATION');
  const allowedOrigins = String(env.TRANSCRIPTION_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('Invalid TRANSCRIPTION_ALLOWED_ORIGINS'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('TRANSCRIPTION_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths');
    }
  }
  const directory = env.TRANSCRIPTION_TEMP_DIRECTORY || path.join(os.tmpdir(), 'rewrite-bridge-transcriptions');
  if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(path.resolve(directory)).root) {
    throw new Error('TRANSCRIPTION_TEMP_DIRECTORY must be an absolute dedicated directory');
  }
  return {
    enabled, project, location, allowedOrigins, directory: path.resolve(directory),
    model: 'chirp_3', language: 'yue-Hant-HK',
    maxBytes: integer('TRANSCRIPTION_MAX_UPLOAD_BYTES', 20 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    maxSeconds: integer('TRANSCRIPTION_MAX_AUDIO_SECONDS', 60, 1, 60),
    concurrency: integer('TRANSCRIPTION_MAX_CONCURRENCY', 10, 1, 20),
    conversions: integer('TRANSCRIPTION_CONVERSION_CONCURRENCY', 2, 1, 4),
    ratePerMinute: integer('TRANSCRIPTION_REQUESTS_PER_MINUTE', 6, 1, 60),
    uploadMs: integer('TRANSCRIPTION_UPLOAD_TIMEOUT_MS', 120000, 1000, 120000),
    conversionMs: integer('TRANSCRIPTION_CONVERSION_TIMEOUT_MS', 15000, 1000, 60000),
    googleMs: integer('TRANSCRIPTION_GOOGLE_TIMEOUT_MS', 60000, 1000, 120000),
    totalMs: integer('TRANSCRIPTION_TOTAL_TIMEOUT_MS', 180000, 1000, 300000),
    ffmpeg: env.TRANSCRIPTION_FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.TRANSCRIPTION_FFPROBE_PATH || 'ffprobe'
  };
}
module.exports = { readTranscriptionConfig };
