function readConfiguration({ env = process.env } = {}) {
  if (env.GOOGLE_SDK_NODE_LOGGING) throw new Error('Disable GOOGLE_SDK_NODE_LOGGING before enabling transcription');
  const project = env.TRANSCRIPTION_GOOGLE_PROJECT || '';
  const location = env.TRANSCRIPTION_GOOGLE_LOCATION || 'us';
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_PROJECT');
  if (!['us', 'eu'].includes(location)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_LOCATION');
  const timeoutMs = env.TRANSCRIPTION_GOOGLE_TIMEOUT_MS === undefined ? 60000 : Number(env.TRANSCRIPTION_GOOGLE_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('Invalid TRANSCRIPTION_GOOGLE_TIMEOUT_MS');
  const model = env.TRANSCRIPTION_GOOGLE_MODEL || 'chirp_3';
  const language = env.TRANSCRIPTION_GOOGLE_LANGUAGE || 'yue-Hant-HK';
  if (!/^[a-zA-Z0-9_.-]+$/.test(model)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_MODEL');
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_LANGUAGE');
  return { runtime: { project, location, model, language, timeoutMs } };
}
module.exports = { readConfiguration };
