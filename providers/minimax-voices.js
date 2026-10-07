const { T2A_VOICE_CHOICES } = require('../lib/t2a-voice-choices');
function minimaxVoice(voiceId, speed, pitch, languageBoost = 'Chinese,Yue') {
  return Object.freeze({
    voice: Object.freeze({ voiceId, speed, volume: 1, pitch }),
    languageBoost,
    voiceModify: Object.freeze({ pitch: 0, intensity: 0, timbre: 0 })
  });
}

// Stable choices describe the intended sound; each provider owns its native tuning.
const PROVIDER_VOICE_CHOICES = Object.freeze({
  minimax: Object.freeze({
    cantonese_male_1: minimaxVoice('Cantonese_PlayfulMan', 1.1, -1),
    cantonese_male_2: minimaxVoice('Cantonese_PlayfulMan', 1.1, 3),
    cantonese_male_3: minimaxVoice('Cantonese_ProfessionalHost（M)', 1.1, 1),
    cantonese_female_1: minimaxVoice('Cantonese_CuteGirl', 1.1, 2),
    cantonese_female_2: minimaxVoice('Cantonese_GentleLady', 1.1, 0),
    cantonese_female_3: minimaxVoice('Cantonese_KindWoman', 1.1, 1),
    cantonese_narrator_female: minimaxVoice('Cantonese_ProfessionalHost（F)', 1, 0),
    mandarin_narrator_female: minimaxVoice('Chinese (Mandarin)_News_Anchor', 1, 0, 'Chinese'),
    english_narrator_female: minimaxVoice('English_compelling_lady1', 0.85, 0, 'English')
  })
});

function resolveT2AVoiceChoice({ choice, provider }) {
  if (typeof choice !== 'string' || !choice.trim()) {
    return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'voice_choice must be a non-empty string' };
  }
  const choiceId = choice.trim();
  if (!T2A_VOICE_CHOICES.includes(choiceId)) {
    return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'voice_choice must be a known voice choice' };
  }

  const mappings = Object.hasOwn(PROVIDER_VOICE_CHOICES, provider) ? PROVIDER_VOICE_CHOICES[provider] : null;
  const mapping = mappings && Object.hasOwn(mappings, choiceId) ? mappings[choiceId] : null;
  if (!mapping) {
    return {
      ok: false,
      status: 422,
      code: 'VOICE_CHOICE_UNSUPPORTED',
      message: 'voice_choice is not supported by the selected t2a provider'
    };
  }

  return {
    ok: true,
    value: {
      voice: { ...mapping.voice },
      languageBoost: mapping.languageBoost,
      voiceModify: { ...mapping.voiceModify }
    }
  };
}

module.exports = { resolveT2AVoiceChoice };
