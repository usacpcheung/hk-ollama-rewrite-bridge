function readGoogleSettings(env) {
  if (env.GOOGLE_SDK_NODE_LOGGING) throw new Error('Disable GOOGLE_SDK_NODE_LOGGING before enabling transcription');
  const project = env.TRANSCRIPTION_GOOGLE_PROJECT || '';
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_PROJECT');
  const timeoutMs = env.TRANSCRIPTION_GOOGLE_TIMEOUT_MS === undefined ? 60000 : Number(env.TRANSCRIPTION_GOOGLE_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('Invalid TRANSCRIPTION_GOOGLE_TIMEOUT_MS');
  return { project, timeoutMs };
}

function readConfiguration({ env = process.env } = {}) {
  const { project, timeoutMs } = readGoogleSettings(env);
  const location = env.TRANSCRIPTION_GOOGLE_LOCATION || 'us';
  if (!['us', 'eu'].includes(location)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_LOCATION');
  const model = env.TRANSCRIPTION_GOOGLE_MODEL || 'chirp_3';
  const language = env.TRANSCRIPTION_GOOGLE_LANGUAGE || 'yue-Hant-HK';
  if (!/^[a-zA-Z0-9_.-]+$/.test(model)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_MODEL');
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language)) throw new Error('Invalid TRANSCRIPTION_GOOGLE_LANGUAGE');
  return { runtime: { project, location, model, language, timeoutMs } };
}
function readGeminiConfiguration({ env = process.env } = {}) {
  const model = env.TRANSCRIPTION_GEMINI_MODEL ?? 'gemini-3.5-transcribe';
  if (!/^gemini-[a-z0-9.-]{1,80}-transcribe$/.test(model)) throw new Error('Invalid TRANSCRIPTION_GEMINI_MODEL');
  return { runtime: { ...readGoogleSettings(env), model, credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS } };
}
module.exports = { readConfiguration, readGeminiConfiguration };
