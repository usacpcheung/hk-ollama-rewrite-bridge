const { EventEmitter, once } = require('node:events');

// Share one pending initialization. When a caller leaves, detach its listeners
// immediately, even if the underlying SDK promise never settles.
function shareInFlight(start) {
  let pending;
  return async function wait(signal) {
    signal.throwIfAborted();
    if (!pending) {
      const waiters = new EventEmitter();
      waiters.setMaxListeners(0);
      pending = waiters;
      function finish(result) {
        pending = undefined;
        waiters.emit('settled', result);
      }
      Promise.resolve().then(start).then(
        value => finish({ value }), error => finish({ error })
      );
    }
    try {
      const [result] = await once(pending, 'settled', { signal });
      signal.throwIfAborted();
      if ('error' in result) throw result.error;
      return result.value;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  };
}
module.exports = { shareInFlight };
