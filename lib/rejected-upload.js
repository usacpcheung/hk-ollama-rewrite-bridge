const installed = Symbol('rejectedUploadCleanup');

// A response finishing locally does not mean an uploading client has received it.
// Discard a bounded tail instead of immediately resetting that client's socket.
// This is transport cleanup only: rejected bytes are never parsed or stored.
function installRejectedUploadCleanup(req, res) {
  if (res[installed]) return;
  res[installed] = true;
  res.once('finish', () => {
    if (req.complete || req.destroyed) return;
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', discard);
      req.removeListener('end', cleanup);
      req.removeListener('close', cleanup);
    };
    const stop = () => { cleanup(); req.destroy(); };
    const discard = chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
    };
    const timer = setTimeout(stop, 250);
    timer.unref();
    req.on('data', discard);
    req.once('end', cleanup);
    req.once('close', cleanup);
    req.resume();
  });
}
module.exports = { installRejectedUploadCleanup };
