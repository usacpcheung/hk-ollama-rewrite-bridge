const T2A_VOICE_CHOICES = Object.freeze([
  'cantonese_male_1',
  'cantonese_male_2',
  'cantonese_male_3',
  'cantonese_female_1',
  'cantonese_female_2',
  'cantonese_female_3',
  'cantonese_narrator_female',
  'mandarin_narrator_female',
  'english_narrator_female'
]);

// Intent is a public service contract; native realization belongs to an adapter.
const VOICE_INTENTS = Object.freeze(Object.fromEntries(T2A_VOICE_CHOICES.map(id => [id, Object.freeze({
  id, language: id.startsWith('mandarin_') ? 'cmn' : id.startsWith('english_') ? 'en' : 'yue',
  sex: id.includes('female') ? 'female' : 'male'
})])));
function validateVoiceChoice(choice) {
  if (typeof choice !== 'string' || !choice.trim()) return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'voice_choice must be a non-empty string' };
  const id = choice.trim();
  if (!Object.hasOwn(VOICE_INTENTS, id)) return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'voice_choice must be a known voice choice' };
  return { ok: true, value: VOICE_INTENTS[id] };
}
module.exports = { T2A_VOICE_CHOICES, VOICE_INTENTS, validateVoiceChoice };
