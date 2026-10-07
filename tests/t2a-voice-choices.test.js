const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveT2AVoiceChoice } = require('../providers/minimax-voices');

test('a valid voice choice without a provider mapping fails explicitly', () => {
  for (const provider of ['google', 'missing-provider', '__proto__', 'constructor']) {
    const result = resolveT2AVoiceChoice({ choice: 'cantonese_male_1', provider });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.code, 'VOICE_CHOICE_UNSUPPORTED');
  }
});

test('resolved voice settings cannot alter another request or the catalogue', () => {
  const first = resolveT2AVoiceChoice({ choice: ' cantonese_male_1 ', provider: 'minimax' });
  assert.equal(first.ok, true);
  first.value.voice.pitch = 12;
  first.value.voiceModify.timbre = 100;
  const next = resolveT2AVoiceChoice({ choice: 'cantonese_male_1', provider: 'minimax' });
  assert.equal(next.value.voice.pitch, -1);
  assert.equal(next.value.voiceModify.timbre, 0);
});
