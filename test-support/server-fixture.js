const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Exercise the actual server composition. Cloud endpoints and credentials are
// replaced here; no production exports or test hooks are needed.
const AUTH = {
  'X-Bridge-Auth': 'compatibility-test-secret',
  'X-Authenticated-Email': 'student@hs.edu.hk',
};
const AUDIO = Buffer.from('synthetic audio bytes for HTTP contract checks '.repeat(2));
const POST_ROUTES = [
  '/rewrite',
  '/api/rewrite',
  '/t2a',
  '/api/t2a',
  '/transcriptions',
  '/api/transcriptions',
];
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function fixture(t, { env = {}, handle } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-compatibility-'));
  const calls = [];
  let bridge;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, body });
      if (handle?.(req, res, body)) return;
      if (req.url === '/rewrite') return json(res, 200, { reply: '正式文字' });
      if (req.url === '/t2a')
        return json(res, 200, {
          data: { audio: AUDIO.toString('hex'), format: 'mp3', audio_length: AUDIO.length },
        });
      json(res, 404, {});
    });
  });
  // Register before listen/spawn so even a failed fixture is cleaned up.
  t.after(async () => {
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
      const exited = once(bridge, 'exit');
      bridge.kill('SIGTERM');
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const providerUrl = `http://127.0.0.1:${upstream.address().port}`;
  bridge = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    // Deliberately exclude inherited bridge/provider settings and credentials.
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH['X-Bridge-Auth'],
      WARMUP_ON_START: 'false',
      REWRITE_PROVIDER: 'minimax',
      REWRITE_STREAMING_ENABLED: 'true',
      REWRITE_MINIMAX_API_URL: `${providerUrl}/rewrite`,
      REWRITE_MINIMAX_ANTHROPIC_BASE_URL: `${providerUrl}/anthropic`,
      REWRITE_OLLAMA_URL: `${providerUrl}/generate`,
      REWRITE_OLLAMA_PS_URL: `${providerUrl}/ps`,
      T2A_MINIMAX_API_URL: `${providerUrl}/t2a`,
      MINIMAX_API_KEY: 'synthetic-test-key',
      TRANSCRIPTION_ENABLED: 'false',
      TRANSCRIPTION_GOOGLE_PROJECT: 'test-project',
      TRANSCRIPTION_TEMP_DIRECTORY: directory,
      RATE_LIMIT_GLOBAL_MAX_REQUESTS: '1000',
      RATE_LIMIT_REWRITE_IP_MAX_REQUESTS: '1000',
      RATE_LIMIT_T2A_IP_MAX_REQUESTS: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bridge startup timed out')), 10_000);
    let output = '';
    bridge.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('rewrite-bridge listening on http://127.0.0.1:3001')) {
        clearTimeout(timer);
        resolve();
      }
    });
    bridge.stderr.resume();
    bridge.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    bridge.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Bridge exited during startup: ${code}/${signal}`));
    });
  });
  const request = (route, { body = { text: '測試' }, headers = AUTH, raw, method = 'POST' } = {}) =>
    fetch(`http://127.0.0.1:3001${route}`, {
      method,
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(method === 'POST' ? { body: raw === undefined ? JSON.stringify(body) : raw } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  return { request, calls, bridge, directory };
}

module.exports = { fixture, AUTH, AUDIO, POST_ROUTES, json };
