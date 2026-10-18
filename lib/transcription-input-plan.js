// Step-3 contract prototype. The current transcription route is deliberately not
// migrated until step 4. Preparation stays service-owned and cannot relax limits.
function planTranscriptionInput({ requirements, limits }) {
  const { encoding, sampleRate, channels, delivery, cancellation } = requirements;
  if (!['flac', 'pcm_s16le', 'wav'].includes(encoding) ||
      !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      ![1, 2].includes(channels) || delivery !== 'inline' ||
      !['abortable', 'deadline-only'].includes(cancellation)) {
    throw new TypeError('Unsupported transcription input requirements');
  }
  const cap = field => {
    if (![limits[field], requirements[field]].every(value => Number.isFinite(value) && value > 0)) {
      throw new TypeError(`Invalid transcription ${field}`);
    }
    return Math.min(limits[field], requirements[field]);
  };
  return Object.freeze({ encoding, sampleRate, channels, delivery, cancellation,
    maxDurationSeconds: cap('maxDurationSeconds'), maxPreparedBytes: cap('maxPreparedBytes') });
}
module.exports = { planTranscriptionInput };
