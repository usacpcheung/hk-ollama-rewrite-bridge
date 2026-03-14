function createProviderAdapter(provider) {
  return {
    getInfo: () => (provider.getInfo ? provider.getInfo() : {}),
    mapError: (error) => provider.mapError(error),
    checkReadiness: ({ timeoutMs }) => provider.checkReadiness({ timeoutMs }),
    triggerWarmup: ({ timeoutMs }) => provider.triggerWarmup({ timeoutMs }),
    rewrite: ({ requestId, prompt, systemPrompt, userContent, timeoutMs }) =>
      provider.rewrite({ requestId, prompt, systemPrompt, userContent, timeoutMs }),
    rewriteStream: provider.rewriteStream
      ? ({ requestId, prompt, systemPrompt, userContent, timeoutMs, onChunk }) =>
          provider.rewriteStream({ requestId, prompt, systemPrompt, userContent, timeoutMs, onChunk })
      : null
  };
}

module.exports = {
  createProviderAdapter
};
