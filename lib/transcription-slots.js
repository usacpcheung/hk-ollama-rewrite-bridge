const { checkAbort } = require('./transcription-errors');

// The service's total admission limit bounds this internal conversion waiting list.
function createConversionSlots(max) {
  let active = 0;
  const waiting = [];
  function drain() {
    while (active < max && waiting.length) {
      const entry = waiting.shift();
      entry.signal?.removeEventListener('abort', entry.cancel);
      active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    }
  }
  return function acquire(signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const entry = { resolve, signal, cancel: () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      } };
      signal?.addEventListener('abort', entry.cancel, { once: true });
      waiting.push(entry);
      drain();
    });
  };
}
module.exports = { createConversionSlots };
