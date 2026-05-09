const { failureResult } = require('./bridge-contract');

function createUnsupportedServiceError({ provider, serviceId, mode }) {
  return failureResult({
    code: 'UNSUPPORTED_PROVIDER_SERVICE',
    message: `Provider \"${provider}\" does not support ${mode} ${serviceId} requests`,
    status: 501
  });
}

function createProviderAdapter(provider) {
  const providerName = provider.getInfo?.().provider || provider.name || 'unknown';

  const resolveServiceHandler = ({ serviceId, mode }) => {
    const serviceHandlers = provider.services && provider.services[serviceId];
    const handler = serviceHandlers && serviceHandlers[mode];

    if (typeof handler === 'function') {
      return handler;
    }

    if (serviceId === 'rewrite') {
      if (mode === 'sync' && typeof provider.rewrite === 'function') {
        return provider.rewrite;
      }

      if (mode === 'stream' && typeof provider.rewriteStream === 'function') {
        return provider.rewriteStream;
      }
    }

    return null;
  };

  const hasSyncHandler = ({ serviceId }) => Boolean(resolveServiceHandler({ serviceId, mode: 'sync' }));
  const hasStreamHandler = ({ serviceId }) => Boolean(resolveServiceHandler({ serviceId, mode: 'stream' }));

  const invokeSync = ({ serviceId, requestId, payload = {}, timeoutMs }) => {
    const handler = resolveServiceHandler({ serviceId, mode: 'sync' });
    if (!handler) {
      return serviceId === 'rewrite'
        ? null
        : createUnsupportedServiceError({ provider: providerName, serviceId, mode: 'sync' });
    }

    return handler({ requestId, timeoutMs, ...payload });
  };

  const invokeStream = ({ serviceId, requestId, payload = {}, timeoutMs, onChunk }) => {
    const handler = resolveServiceHandler({ serviceId, mode: 'stream' });
    if (!handler) {
      return serviceId === 'rewrite'
        ? null
        : createUnsupportedServiceError({ provider: providerName, serviceId, mode: 'stream' });
    }

    return handler({ requestId, timeoutMs, onChunk, ...payload });
  };

  const legacyRewrite = ({ requestId, prompt, systemPrompt, userContent, timeoutMs }) =>
    invokeSync({
      serviceId: 'rewrite',
      requestId,
      payload: { prompt, systemPrompt, userContent },
      timeoutMs
    });

  const legacyRewriteStream = hasStreamHandler({ serviceId: 'rewrite' })
    ? ({ requestId, prompt, systemPrompt, userContent, timeoutMs, onChunk }) =>
      invokeStream({
        serviceId: 'rewrite',
        requestId,
        payload: { prompt, systemPrompt, userContent },
        timeoutMs,
        onChunk
      })
    : null;

  return {
    getInfo: () => (provider.getInfo ? provider.getInfo() : {}),
    mapError: (error) => provider.mapError(error),
    checkReadiness: ({ timeoutMs }) => provider.checkReadiness({ timeoutMs }),
    triggerWarmup: ({ timeoutMs }) => provider.triggerWarmup({ timeoutMs }),
    invokeSync,
    invokeStream,
    hasSyncHandler,
    hasStreamHandler,
    // Deprecated legacy shim: use invokeSync({ serviceId: 'rewrite', ... }) instead.
    rewrite: legacyRewrite,
    // Deprecated legacy shim: use invokeStream({ serviceId: 'rewrite', ... }) instead.
    // Preserves backward-compatible nullability for legacy call-sites.
    rewriteStream: legacyRewriteStream
  };
}

module.exports = {
  createProviderAdapter
};
