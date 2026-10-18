// Availability hooks are synchronous local checks. A broken hook must not take
// down Express async handlers or expose native errors/credential details.
function readProviderAvailability(check) {
  const unavailable = () => ({ status: 503, code: 'PROVIDER_UNAVAILABLE',
    message: 'Provider is temporarily unavailable.' });
  try {
    const result = check?.();
    if (result == null) return null;
    if (typeof result.then === 'function') {
      // Reject asynchronous implementations, but observe a rejected promise too.
      void Promise.resolve(result).catch(() => {});
      return unavailable();
    }
    if (!Number.isInteger(result.status) || result.status < 400 || result.status > 599 ||
        typeof result.code !== 'string' || !result.code || typeof result.message !== 'string') {
      return unavailable();
    }
    return { status: result.status, code: result.code, message: result.message };
  } catch {
    return unavailable();
  }
}
module.exports = { readProviderAvailability };
