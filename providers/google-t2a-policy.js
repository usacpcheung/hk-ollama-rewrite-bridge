const presets = require('./google-tts-voices');
const legacyFields = Object.freeze(['voice_id', 'language_boost', 'speed', 'volume', 'pitch']);
const policy = {
  legacyFields,
  supportsVoiceChoice: id => Object.hasOwn(presets, id),
  validateControls(body = {}) {
    if (legacyFields.some(key => Object.hasOwn(body, key))) return { ok: false, status: 400,
      code: 'INVALID_INPUT', message: 'Gemini TTS requires voice_choice or the default voice; legacy voice controls are unsupported.' };
    return { ok: true, value: {} };
  },
  validateAudio(audio) {
    // MP3 codecs accept discrete rates, unlike PCM resampling.
    if (audio.format === 'mp3' && (![8000,11025,12000,16000,22050,24000,32000,44100,48000].includes(audio.sampleRate)
      || ![32000,40000,48000,56000,64000,80000,96000,112000,128000,160000,192000,224000,256000,320000].includes(audio.bitrate)
      || (audio.sampleRate < 16000 && audio.bitrate > 64000)
      || (audio.sampleRate < 32000 && audio.bitrate > 160000)
      || (audio.sampleRate >= 32000 && [40000,56000].includes(audio.bitrate)))) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Unsupported MP3 sample_rate/bitrate combination for Gemini TTS.' };
    }
    return { ok: true };
  }
};
module.exports = { googleT2APolicy: Object.freeze(policy) };
