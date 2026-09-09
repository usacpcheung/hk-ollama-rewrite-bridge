// Explicit, paid smoke test against the local bridge. Never logs auth or audio.
const fs = require('node:fs/promises');

async function main() {
  const audioPath = process.argv[2];
  const secret = process.env.BRIDGE_INTERNAL_AUTH_SECRET;
  const email = process.env.TRANSCRIPTION_TEST_EMAIL;
  if (!audioPath || !secret || !email) throw new Error('Provide an audio path, BRIDGE_INTERNAL_AUTH_SECRET and TRANSCRIPTION_TEST_EMAIL.');
  const stat = await fs.stat(audioPath);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Use an audio file no larger than 20 MiB.');
  const form = new FormData();
  form.append('audio', new Blob([await fs.readFile(audioPath)]), 'test-audio');
  const response = await fetch('http://127.0.0.1:3001/transcriptions', {
    method: 'POST', body: form, signal: AbortSignal.timeout(240000),
    headers: { 'X-Bridge-Auth': secret, 'X-Authenticated-Email': email }
  });
  const result = await response.json();
  console.log(JSON.stringify({ status: response.status, ok: result.ok,
    code: result.error?.code, requestId: result.requestId, durationSeconds: result.durationSeconds,
    timings: result.timings, characters: typeof result.result === 'string' ? [...result.result].length : undefined }));
  if (process.argv.includes('--show-transcript') && result.ok) console.log(result.result);
  if (!response.ok || !result.ok) process.exitCode = 1;
}
main().catch(() => { console.error('Transcription smoke test failed; check local configuration and service status.'); process.exitCode = 1; });
