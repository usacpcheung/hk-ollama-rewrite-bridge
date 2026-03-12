#!/usr/bin/env node

/**
 * MiniMax Anthropic-SDK streaming smoke script.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx node scripts/minimax-anthropic-stream-smoke.js "Hi, how are you?"
 *
 * Optional env vars:
 *   ANTHROPIC_BASE_URL     (default: https://api.minimax.io/anthropic)
 *   ANTHROPIC_MODEL        (default: MiniMax-M2.5)
 *   ANTHROPIC_SYSTEM       (default: You are a helpful assistant.)
 *   ANTHROPIC_MAX_TOKENS   (default: 1000)
 */

const Anthropic = require('@anthropic-ai/sdk');

const prompt = process.argv.slice(2).join(' ').trim() || 'Hi, how are you?';
const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.minimax.io/anthropic').replace(/\/+$/, '');
const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
const model = (process.env.ANTHROPIC_MODEL || 'MiniMax-M2.5').trim();
const system = process.env.ANTHROPIC_SYSTEM || 'You are a helpful assistant.';
const parsedMaxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 1000);
const max_tokens = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 1000;

if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY');
  console.error('Example: ANTHROPIC_API_KEY=xxx node scripts/minimax-anthropic-stream-smoke.js "Hello"');
  process.exit(1);
}

const requestBody = {
  model,
  max_tokens,
  system,
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: prompt }]
    }
  ],
  stream: true
};

(async () => {
  const client = new Anthropic({ apiKey, baseURL });

  console.log('\n=== SDK Config ===');
  console.log(JSON.stringify({ baseURL, apiKey: '***redacted***' }, null, 2));

  console.log('\n=== messages.create stream request ===');
  console.log(JSON.stringify(requestBody, null, 2));

  console.log('\nStarting stream response...\n');
  console.log('='.repeat(60));
  console.log('Thinking Process:');
  console.log('='.repeat(60));

  let stream;
  try {
    stream = await client.messages.create(requestBody);
  } catch (err) {
    console.error('\n=== SDK Error (request setup) ===');
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

  let reasoningBuffer = '';
  let textBuffer = '';
  let printedTextHeader = false;

  try {
    for await (const chunk of stream) {
      if (chunk?.type === 'content_block_start') {
        if (chunk?.content_block?.type === 'text' && !printedTextHeader) {
          printedTextHeader = true;
          process.stdout.write(`\n${'='.repeat(60)}\nResponse Content:\n${'='.repeat(60)}\n`);
        }
      } else if (chunk?.type === 'content_block_delta') {
        if (chunk?.delta?.type === 'thinking_delta') {
          const newThinking = chunk.delta.thinking || '';
          if (newThinking) {
            process.stdout.write(newThinking);
            reasoningBuffer += newThinking;
          }
        } else if (chunk?.delta?.type === 'text_delta') {
          const newText = chunk.delta.text || '';
          if (newText) {
            process.stdout.write(newText);
            textBuffer += newText;
          }
        }
      }
    }
  } catch (err) {
    console.error('\n\n=== SDK Error (stream consumption) ===');
    console.error(JSON.stringify({
      name: err?.name || null,
      message: err?.message || String(err),
      status: err?.status || null,
      request_id: err?.request_id || null,
      type: err?.error?.type || null,
      error: err?.error || null
    }, null, 2));
    process.exit(3);
  }

  console.log('\n');
  console.log('='.repeat(60));
  console.log('Final Buffers (for copy/check)');
  console.log('='.repeat(60));
  console.log('\n[reasoning_buffer]\n' + reasoningBuffer);
  console.log('\n[text_buffer]\n' + textBuffer);
})();
