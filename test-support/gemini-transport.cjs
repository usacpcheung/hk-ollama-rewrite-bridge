// Only loaded by tests. Keep the real adapter/auth construction/HTTP stack;
// replace credentials and redirect Google requests to the fixture's loopback.
const google = require('google-auth-library');
google.GoogleAuth.prototype.getClient = async function () {
  return { getAccessToken: async () => ({ token: 'test-only-token' }) };
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (String(url).startsWith('https://aiplatform.googleapis.com/')) {
    const target = new URL(process.env.REWRITE_MINIMAX_API_URL);
    target.pathname = String(url).includes(':streamGenerateContent') ? '/gemini-stream' : '/gemini';
    return nativeFetch(target, options);
  }
  return nativeFetch(url, options);
};
