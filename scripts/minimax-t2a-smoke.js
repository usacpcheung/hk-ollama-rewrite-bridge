#!/usr/bin/env node

/**
 * MiniMax text-to-audio smoke script.
 *
 * Sends a T2A request, prints the full JSON response, and writes returned hex audio to an MP3 file.
 *
 * Usage:
 *   MINIMAX_API_KEY=xxx node scripts/minimax-t2a-smoke.js "你好，歡迎使用" out.mp3
 *
 * Optional env vars:
 *   MINIMAX_T2A_URL            (default: https://api.minimaxi.chat/v1/t2a_v2)
 *   MINIMAX_T2A_MODEL          (default: speech-02-hd)
 *   MINIMAX_T2A_VOICE_ID       (default: female-tianmei)
 *   MINIMAX_T2A_SPEED          (default: 1)
 *   MINIMAX_T2A_VOLUME         (default: 1)
 *   MINIMAX_T2A_PITCH          (default: 0)
 */

const fs = require('fs');
const path = require('path');

const text = process.argv[2] || '你好，這是一段測試語音。';
const outputFile = process.argv[3] || 'minimax-output.mp3';

const apiKey = (process.env.MINIMAX_API_KEY || process.env.MINIMAX_GROUP_API_KEY || '').trim();
const t2aUrl = (process.env.MINIMAX_T2A_URL || 'https://api.minimaxi.chat/v1/t2a_v2').trim();
const model = (process.env.MINIMAX_T2A_MODEL || 'speech-02-hd').trim();
const voiceId = (process.env.MINIMAX_T2A_VOICE_ID || 'female-tianmei').trim();
const speed = toNumber(process.env.MINIMAX_T2A_SPEED, 1);
const volume = toNumber(process.env.MINIMAX_T2A_VOLUME, 1);
const pitch = toNumber(process.env.MINIMAX_T2A_PITCH, 0);

if (!apiKey) {
  console.error('Missing MINIMAX_API_KEY (or MINIMAX_GROUP_API_KEY).');
  console.error('Example: MINIMAX_API_KEY=xxx node scripts/minimax-t2a-smoke.js "你好" out.mp3');
  process.exit(1);
}

const requestBody = {
  model,
  text,
  voice_setting: {
    voice_id: voiceId,
    speed,
    vol: volume,
    pitch
  },
  audio_setting: {
    sample_rate: 32000,
    bitrate: 128000,
    format: 'mp3'
  }
};

(async () => {
  console.log('\n=== Request URL ===');
  console.log(t2aUrl);

  console.log('\n=== Request Body ===');
  console.log(JSON.stringify(requestBody, null, 2));

  let response;
  try {
    response = await fetch(t2aUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
  } catch (err) {
    console.error('\n=== Request Error ===');
    console.error(err?.stack || String(err));
    process.exit(2);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error('\n=== Response Parse Error ===');
    console.error(`HTTP ${response.status}`);
    console.error(err?.stack || String(err));
    process.exit(3);
  }

  console.log('\n=== JSON Response ===');
  console.log(JSON.stringify(data, null, 2));

  if (!response.ok) {
    console.error(`\nT2A request failed with HTTP ${response.status}.`);
    process.exit(4);
  }

  const hexAudio = findHexAudio(data);
  if (!hexAudio) {
    console.error('\nCould not find hex audio data in the response JSON.');
    process.exit(5);
  }

  const outputPath = path.resolve(process.cwd(), outputFile);
  try {
    fs.writeFileSync(outputPath, Buffer.from(hexAudio, 'hex'));
  } catch (err) {
    console.error('\nFailed writing MP3 file.');
    console.error(err?.stack || String(err));
    process.exit(6);
  }

  console.log(`\nSaved MP3 to: ${outputPath}`);
  console.log(`Hex length: ${hexAudio.length}`);
})();

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findHexAudio(payload) {
  const directCandidates = [
    payload?.audio,
    payload?.audio_hex,
    payload?.audioHex,
    payload?.data?.audio,
    payload?.data?.audio_hex,
    payload?.data?.audioHex,
    payload?.data?.audio_data,
    payload?.base_resp?.audio
  ];

  for (const candidate of directCandidates) {
    if (isLikelyHex(candidate)) {
      return candidate;
    }
  }

  return deepFindHex(payload);
}

function deepFindHex(node) {
  if (node == null) {
    return null;
  }

  if (typeof node === 'string' && isLikelyHex(node)) {
    return node;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindHex(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof node === 'object') {
    for (const value of Object.values(node)) {
      const found = deepFindHex(value);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function isLikelyHex(value) {
  return typeof value === 'string' && value.length > 64 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}
