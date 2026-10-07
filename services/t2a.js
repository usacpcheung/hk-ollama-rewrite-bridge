const { validateVoiceChoice } = require('../lib/t2a-voice-choices');
function parseResponseMode(value) {
  if (value == null || value === '') {
    return 'binary';
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'binary' || normalized === 'default') {
    return 'binary';
  }

  if (normalized === 'base64_json' || normalized === 'base64-json') {
    return 'base64_json';
  }

  return null;
}

function parseOptionalBoundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') {
    return undefined;
  }

  let parsed;
  try { parsed = Number(value); } catch { return null; }
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

function parseOptionalEnum(value, allowedValues = []) {
  if (value == null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return allowedValues.includes(normalized) ? normalized : null;
}

function createT2AServiceDefinition({ config: resolvedConfig, requestPolicy }) {
  const maxTextLength = resolvedConfig.maxTextLength;
  const audioDefaults = { sampleRate: 32000, bitrate: 128000, format: 'mp3', channel: 1 };

  return {
    id: 't2a',
    routes: {
      legacyPath: '/t2a',
      futureApiPath: '/api/t2a'
    },
    provider: {
      selected: resolvedConfig.provider,
      supported: resolvedConfig.providerSupported,
      unsupportedError: resolvedConfig.providerSupported
        ? null
        : {
          status: 501,
          code: 'UNSUPPORTED_PROVIDER',
          message: `Provider "${resolvedConfig.provider}" is not supported for t2a`
        },
      runtime: resolvedConfig.providers[resolvedConfig.provider] || {},
      runtimeByProvider: resolvedConfig.providers,
      sources: resolvedConfig.sources
    },
    capabilities: {
      streaming: false,
      byProvider: Object.fromEntries(Object.entries(resolvedConfig.providers).map(([id, value]) => [id, value.capabilities]))
    },
    limits: {
      maxTextLength
    },
    timeouts: {
      invokeMs: resolvedConfig.timeouts.invokeMs
    },
    buildRequest: ({ trimmedText, voiceSelection, audio }) => ({ text: trimmedText, voiceSelection, audio }),
    validateRequest: ({ body }) => {
      const {
        text,
        stream,
        response_mode: rawResponseMode,
        sample_rate: sampleRate,
        bitrate,
        format
      } = body || {};

      const streamRequested = stream === true || stream === 'true' || stream === 1 || stream === '1';
      if (streamRequested) {
        return {
          ok: false,
          status: 501,
          code: 'STREAMING_UNSUPPORTED',
          message: 'stream is not supported for t2a v1'
        };
      }

      if (typeof text !== 'string') {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'text is required' };
      }

      const trimmedText = text.trim();
      const inputCharCount = [...trimmedText].length;
      if (!trimmedText) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'text is required' };
      }

      if (inputCharCount > maxTextLength) {
        return { ok: false, status: 413, code: 'TOO_LONG', message: `Max ${maxTextLength} characters` };
      }

      const controls = requestPolicy.validateControls(body);
      if (!controls.ok) return controls;

      const responseMode = parseResponseMode(rawResponseMode);
      if (!responseMode) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'response_mode must be binary/default or base64_json' };
      }

      const parsedSampleRate = parseOptionalBoundedInteger(sampleRate, { min: 8000, max: 48000 });
      if (parsedSampleRate === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'sample_rate must be an integer between 8000 and 48000' };
      }

      const parsedBitrate = parseOptionalBoundedInteger(bitrate, { min: 32000, max: 320000 });
      if (parsedBitrate === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'bitrate must be an integer between 32000 and 320000' };
      }

      const parsedFormat = parseOptionalEnum(format, ['mp3', 'wav', 'pcm']);
      if (parsedFormat === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'format must be one of mp3, wav, or pcm' };
      }

      let selectedChoice = null;
      if (Object.hasOwn(body || {}, 'voice_choice')) {
        const conflictingField = requestPolicy.legacyFields
          .find((field) => Object.hasOwn(body, field));
        if (conflictingField) {
          return {
            ok: false,
            status: 400,
            code: 'INVALID_INPUT',
            message: 'voice_choice cannot be combined with ' + conflictingField
          };
        }
        const choiceResult = validateVoiceChoice(body.voice_choice);
        if (!choiceResult.ok) return choiceResult;
        if (!requestPolicy.supportsVoiceChoice(choiceResult.value.id)) {
          return { ok: false, status: resolvedConfig.providerSupported ? 422 : 501,
            code: resolvedConfig.providerSupported ? 'VOICE_CHOICE_UNSUPPORTED' : 'UNSUPPORTED_PROVIDER',
            message: resolvedConfig.providerSupported ? 'voice_choice is not supported by the selected t2a provider'
              : 'Provider "' + resolvedConfig.provider + '" is not supported for t2a' };
        }
        selectedChoice = choiceResult.value;
      }

      return {
        ok: true,
        value: {
          trimmedText,
          inputCharCount,
          streamRequested: false,
          responseMode,
          voiceSelection: selectedChoice ? { kind: 'preset', id: selectedChoice.id }
            : Object.keys(controls.value).length ? { kind: 'legacy', controls: controls.value } : { kind: 'default' },
          audio: {
            sampleRate: parsedSampleRate === undefined ? audioDefaults.sampleRate : parsedSampleRate,
            bitrate: parsedBitrate === undefined ? audioDefaults.bitrate : parsedBitrate,
            format: parsedFormat === undefined ? audioDefaults.format : parsedFormat,
            channel: audioDefaults.channel
          }
        }
      };
    }
  };
}

module.exports = { createT2AServiceDefinition };
