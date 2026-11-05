# Gemini TTS integration

## Opt-in Gemini TTS (stacked trial)

MiniMax remains the default. Gemini TTS is separate from Gemini rewrite selection.
Set `T2A_PROVIDER=google-gemini`, `T2A_GOOGLE_PROJECT=your-project`,
`T2A_GOOGLE_LOCATION=global`, and `T2A_GOOGLE_MODEL=gemini-3.8-flash-tts`.
Use existing `GOOGLE_APPLICATION_CREDENTIALS`; never put credentials in requests.
`T2A_FFMPEG_PATH` defaults to `/usr/bin/ffmpeg`. The service user must be able to
execute it, with libmp3lame support. The adapter requires FFmpeg even for WAV/PCM.
Unset `GOOGLE_SDK_NODE_LOGGING` to prevent SDK diagnostic disclosure.

Both TTS routes and binary/base64_json response fields remain unchanged. Gemini
supports `voice_choice` or omitted voice selection (faster Kore Cantonese narrator).
It rejects presence of `voice_id`, `language_boost`, `speed`, `volume`, or `pitch`
with 400 INVALID_INPUT; MiniMax retains legacy control support. Audit callers before
switching. No custom voices or caller-provided style prompts are introduced.

Output defaults remain mono MP3, 32000 Hz, 128000 bits/s. The adapter validates
Google's 24000 Hz mono PCM16 WAV and converts it into requested MP3/WAV/raw PCM16LE.
WAV/PCM support integer sample rates 8000–48000. MP3 rates are 8000, 11025, 12000,
16000, 22050, 24000, 32000, 44100, 48000; bitrate must be a supported MPEG bitrate
(32,40,48,56,64,80,96,112,128,160,192,224,256,320 kbps). Rates below 32000 Hz
allow at most 160 kbps; rates at least 32000 exclude 40/56 kbps. Unsupported
combinations fail before synthesis. Bitrate has no effect on uncompressed WAV/PCM.

Default TTS deadline is still 30000 ms, covering credentials, synthesis and conversion
once admitted; queue waiting has its existing separate budget. For the trial an
administrator may explicitly set `T2A_INVOKE_TIMEOUT_MS=60000`. Text limits remain
200 Unicode characters by default, configurable up to 1000. TTS streaming remains
unsupported. No automatic inference retries or fallback. Google responses are
bounded to 20 MiB; decoded source audio is limited to 240 seconds, and conversion
output to 24 MiB. Excess/invalid audio is rejected, never silently truncated.

Errors are sanitized: Google permission/authentication failures return 503
GEMINI_AUTH_ERROR; quota returns 429 GEMINI_QUOTA_EXCEEDED; deadline returns 504
MODEL_TIMEOUT; unavailable converter returns 503 AUDIO_PROCESSOR_UNAVAILABLE;
other synthesis/conversion failures return 502 GEMINI_TTS_ERROR.
Gemini rewrite and TTS share `GOOGLE_GEMINI_*` admission limits and global capacity.

Approved Cantonese presets (exact style strings live in providers/google-tts-voices.js):

| voice_choice | Native voice | Delivery |
| --- | --- | --- |
| cantonese_male_1 | Enceladus | Gentle, relaxed, lightly breathy |
| cantonese_male_2 | Iapetus | Crisp, direct, slightly brisk |
| cantonese_male_3 | Algenib | Mature, resonant, measured, gravelly |
| cantonese_female_1 | Leda | Bright, youthful, lively, slightly brisk |
| cantonese_female_2 | Achernar | Soft, reassuring, moderate |
| cantonese_female_3 | Gacrux | Mature, assured, firm articulation |
| cantonese_narrator_female | Kore | Clear classroom narration, slightly brisk, shorter pauses |
| mandarin_narrator_female | Erinome | Clear Mandarin narration; listening acceptance pending |
| english_narrator_female | Callirrhoe | Clear English narration; listening acceptance pending |

Style is an instruction, not a guaranteed numeric pitch or speed. All Cantonese
presets preserve the exact operator-approved standalone style, including lexical
tones, exact text and consistent speaker identity. Distinct IDs are not a guarantee
of perceptually distinct voices in every utterance.

Keep this PR stacked on #147 (`codex/gemini-call-alignment`) and unmerged pending
review and VPS acceptance. First test the candidate with MiniMax unchanged, then
switch only TTS to Gemini under maintenance. Check both aliases, formats/modes,
all nine voices, near-limit text, simultaneous rewrite/TTS, authentication,
timeout/cancellation and worksheet playback. Verify rollback to MiniMax by restoring
the saved environment and restarting. Preserve Google rewrite and transcription
settings throughout. Successful standalone voice tests do not replace bridge VPS
acceptance. No production changes are performed by this PR.
