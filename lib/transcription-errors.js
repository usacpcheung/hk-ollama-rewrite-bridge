class TranscriptionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const aborted = () => new TranscriptionError(408, 'TRANSCRIPTION_CANCELLED', 'Transcription cancelled.');
function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || aborted();
}
module.exports = { TranscriptionError, aborted, checkAbort };
