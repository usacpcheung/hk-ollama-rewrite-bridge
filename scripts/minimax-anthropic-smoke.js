#!/usr/bin/env node

/**
 * Simple MiniMax Anthropic-SDK smoke script.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx node scripts/minimax-anthropic-smoke.js "Hi, how are you?"
 *
 * Optional env vars:
 *   ANTHROPIC_BASE_URL     (default: https://api.minimax.io/anthropic)
 *   ANTHROPIC_MODEL        (default: MiniMax-M2.5)
 *   ANTHROPIC_SYSTEM       (default: You are a helpful assistant.)
 *   ANTHROPIC_MAX_TOKENS   (default: 512)
 */

const prompt = process.argv.slice(2).join(' ').trim() || 'Hi, how are you?';
const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.minimax.io/anthropic').replace(/\/+$/, '');
const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
const model = (process.env.ANTHROPIC_MODEL || 'MiniMax-M2.5').trim();
const system = process.env.ANTHROPIC_SYSTEM || 'You are a helpful assistant.';
const parsedMaxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 512);
const max_tokens = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 512;

if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY');
  console.error('Example: ANTHROPIC_API_KEY=xxx node scripts/minimax-anthropic-smoke.js "Hello"');
  process.exit(1);
}

const Anthropic = require('@anthropic-ai/sdk');

const requestBody = {
  model,
  max_tokens,
  system,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: prompt
        }
      ]
    }
  ]
};

(async () => {
  const client = new Anthropic({
    apiKey,
    baseURL
  });

  console.log('\n=== SDK Config ===');
  console.log(JSON.stringify({ baseURL, apiKey: '***redacted***' }, null, 2));

  console.log('\n=== messages.create request ===');
  console.log(JSON.stringify(requestBody, null, 2));

  let message;
  try {
    message = await client.messages.create(requestBody);
  } catch (err) {
    console.error('\n=== SDK Error ===');
    console.error(JSON.stringify({
      name: err?.name || null,
      message: err?.message || String(err),
      status: err?.status || null,
      request_id: err?.request_id || null,
      type: err?.error?.type || null,
      error: err?.error || null
    }, null, 2));
    process.exit(2);
  }

  console.log('\n=== SDK response ===');
  console.log(JSON.stringify(message, null, 2));

  if (Array.isArray(message?.content)) {
    console.log('\n=== Extracted content blocks ===');
    for (const block of message.content) {
      if (block?.type === 'thinking') {
        console.log(`\n[thinking]\n${block.thinking || ''}`);
      } else if (block?.type === 'text') {
        console.log(`\n[text]\n${block.text || ''}`);
      } else {
        console.log(`\n[${block?.type || 'unknown'}]`);
        console.log(JSON.stringify(block, null, 2));
      }
    }
  }
})();
