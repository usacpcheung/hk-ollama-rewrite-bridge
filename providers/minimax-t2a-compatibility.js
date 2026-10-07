const { resolveT2AVoiceChoice } = require('./minimax-voices');
function parseOptionalFiniteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

// This pure policy preserves public validation timing; it makes no provider calls.
const legacyFields = Object.freeze(['voice_id', 'language_boost', 'speed', 'volume', 'pitch']);
const minimaxT2APolicy = Object.freeze({
  legacyFields,
  supportsVoiceChoice: id => resolveT2AVoiceChoice({ choice: id, provider: 'minimax' }).ok,
  validateControls(body) {
    const { voice_id: voiceId, language_boost: languageBoost, speed, volume, pitch } = body || {};
    if (voiceId != null && (typeof voiceId !== 'string' || voiceId.trim() === '')) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'voice_id must be a non-empty string' };
    }

    if (languageBoost != null && (typeof languageBoost !== 'string' || languageBoost.trim() === '')) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'language_boost must be a non-empty string' };
    }

    const parsedSpeed = parseOptionalFiniteNumber(speed, { min: 0.5, max: 2 });
    if (parsedSpeed === null) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'speed must be a number between 0.5 and 2' };
    }

    const parsedVolume = parseOptionalFiniteNumber(volume, { min: 0, max: 10 });
    if (parsedVolume === null) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'volume must be a number between 0 and 10' };
    }

    const parsedPitch = parseOptionalFiniteNumber(pitch, { min: -12, max: 12 });
    if (parsedPitch === null) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'pitch must be a number between -12 and 12' };
    }

    return { ok: true, value: {
      ...(voiceId != null ? { voiceId: voiceId.trim() } : {}),
      ...(languageBoost != null ? { languageBoost: languageBoost.trim() } : {}),
      ...(parsedSpeed !== undefined ? { speed: parsedSpeed } : {}),
      ...(parsedVolume !== undefined ? { volume: parsedVolume } : {}),
      ...(parsedPitch !== undefined ? { pitch: parsedPitch } : {})
    } };
  }
});
function resolveMinimaxSpeechRequest({ voiceSelection, audio }, defaults) {
  if (!['preset', 'legacy', 'default'].includes(voiceSelection?.kind)) {
    throw new TypeError('Unsupported voice selection');
  }
  let voice, languageBoost, voiceModify;
  if (voiceSelection.kind === 'preset') {
    const choice = resolveT2AVoiceChoice({ choice: voiceSelection.id, provider: 'minimax' });
    if (!choice.ok) throw new TypeError('Unvalidated voice choice');
    ({ voice, languageBoost, voiceModify } = choice.value);
  } else {
    const raw = voiceSelection.kind === 'legacy' ? voiceSelection.controls : {};
    voice = { voiceId: raw.voiceId ?? defaults.voiceId, speed: raw.speed ?? defaults.speed,
      volume: raw.volume ?? defaults.volume, pitch: raw.pitch ?? defaults.pitch };
    languageBoost = raw.languageBoost ?? defaults.languageBoost;
    voiceModify = { ...defaults.voiceModify };
  }
  return { voice, languageBoost, voiceModify, audio: { ...defaults.audioSetting, ...audio }, outputFormat: defaults.outputFormat };
}
module.exports = { minimaxT2APolicy, resolveMinimaxSpeechRequest };
