function readConfiguration({ env = process.env } = {}) {
  return { runtime: {
    project: env.T2A_GOOGLE_PROJECT || '',
    location: env.T2A_GOOGLE_LOCATION ?? 'global',
    model: env.T2A_GOOGLE_MODEL ?? 'gemini-3.8-flash-tts',
    ffmpeg: env.T2A_FFMPEG_PATH ?? '/usr/bin/ffmpeg',
    credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS,
    sdkLogging: env.GOOGLE_SDK_NODE_LOGGING
  }, sources: {} };
}
module.exports = { readConfiguration };
