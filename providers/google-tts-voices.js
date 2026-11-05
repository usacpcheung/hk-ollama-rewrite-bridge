const presets = {
  "cantonese_male_1": {
    "voice": "Enceladus",
    "style": "Speak in natural Hong Kong Cantonese. Read exactly the supplied text without adding or omitting words. Preserve lexical tones and clear pronunciation. Keep the selected voice identity consistent. Use a gentle, relaxed conversational delivery, lightly breathy, at a moderate pace. Do not whisper."
  },
  "cantonese_male_2": {
    "voice": "Iapetus",
    "style": "Speak in natural Hong Kong Cantonese. Read exactly the supplied text without adding or omitting words. Preserve lexical tones and clear pronunciation. Keep the selected voice identity consistent. Use crisp, direct articulation and a slightly brisk pace with short natural pauses. Do not rush."
  },
  "cantonese_male_3": {
    "voice": "Algenib",
    "style": "Speak in natural Hong Kong Cantonese. Read exactly the supplied text without adding or omitting words. Preserve lexical tones and clear pronunciation. Keep the selected voice identity consistent. Use a mature, grounded, resonant delivery with the voice's natural gravelly character, measured pacing and firm sentence endings. Do not exaggerate or strain."
  },
  "cantonese_female_1": {
    "voice": "Leda",
    "style": "Speak in natural Hong Kong Cantonese. Read exactly the supplied text without adding or omitting words. Preserve lexical tones and clear pronunciation. Keep the selected voice identity consistent. Use a bright, youthful, lively conversational delivery at a slightly brisk pace. Avoid exaggerated acting."
  },
  "cantonese_female_2": {
    "voice": "Achernar",
    "style": "Speak in natural Hong Kong Cantonese. Read exactly the supplied text without adding or omitting words. Preserve lexical tones and clear pronunciation. Keep the selected voice identity consistent. Use a soft, reassuring conversational delivery at a moderate pace with gentle phrasing. Do not whisper or draw out syllables."
  },
  "cantonese_female_3": {
    "voice": "Gacrux",
    "style": "Speak in natural Hong Kong Cantonese. Read exactly the supplied text without adding or omitting words. Preserve lexical tones and clear pronunciation. Keep the selected voice identity consistent. Use a mature, assured, composed delivery with firm articulation and measured but fluent pacing. Avoid a soft or breathy delivery."
  },
  "cantonese_narrator_female": {
    "voice": "Kore",
    "style": "Speak in natural Hong Kong Cantonese. Read exactly the supplied text without adding or omitting words. Preserve lexical tones and clear pronunciation. Keep the selected voice identity consistent. Use clear classroom narration at a slightly brisk pace, with shorter pauses between phrases. Keep every word intelligible, avoid rushing, and do not draw out syllables."
  },
  "mandarin_narrator_female": {
    "voice": "Erinome",
    "style": "Speak in natural Mandarin Chinese, clearly at a moderate classroom narration pace. Read exactly the supplied text without adding or omitting words. Keep the selected voice identity consistent."
  },
  "english_narrator_female": {
    "voice": "Callirrhoe",
    "style": "Speak in natural English, clearly at a moderate classroom narration pace. Read exactly the supplied text without adding or omitting words. Keep the selected voice identity consistent."
  }
};
for (const value of Object.values(presets)) Object.freeze(value);
module.exports = Object.freeze(presets);
