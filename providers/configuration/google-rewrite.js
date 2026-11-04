function readConfiguration({ env = process.env } = {}) {
  return { runtime: {
    project: env.REWRITE_GOOGLE_PROJECT || '',
    location: env.REWRITE_GOOGLE_LOCATION || 'global',
    model: env.REWRITE_GOOGLE_MODEL || 'gemini-3.8-flash',
    credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS,
    sdkLogging: env.GOOGLE_SDK_NODE_LOGGING
  }, sources: {} };
}
module.exports = { readConfiguration };
