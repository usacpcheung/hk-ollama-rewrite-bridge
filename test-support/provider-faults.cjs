// Test-only fault injection around production registrations/transports.
const definitions = require('../providers/registrations');
const mode = process.env.TEST_PROVIDER_FAULT;
if (mode === 'availability' || mode === 'async-availability') {
  const registration = definitions.find(entry => entry.serviceId === 'transcription');
  registration.availability = mode === 'availability'
    ? () => { throw new Error('private provider details'); }
    : async () => { throw new Error('private provider details'); };
}
if (mode === 'readiness' || mode === 'warmup' || mode === 'invalid-readiness') {
  const registration = definitions.find(entry => entry.provider === 'ollama');
  const create = registration.create;
  registration.create = options => ({ ...create(options),
    checkReadiness: async () => {
      if (mode === 'readiness') throw new Error('private readiness details');
      return mode === 'invalid-readiness' ? undefined : { ready: false, error: null };
    },
    triggerWarmup: async () => { throw new Error('private warmup details'); }
  });
}
if (mode === 'slow-json') {
  const nativeFetch = global.fetch;
  global.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (['/rewrite', '/t2a', '/generate'].some(path => String(args[0]).endsWith(path))) {
      const json = response.json.bind(response);
      response.json = async () => {
        const result = await json();
        const until = performance.now() + Number(process.env.TEST_PARSE_BLOCK_MS);
        while (performance.now() < until) {} // Simulate CPU work while timers cannot run.
        return result;
      };
    }
    return response;
  };
}
if (mode === 'slow-stream') {
  const nativeFetch = global.fetch;
  global.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (['/rewrite', '/generate'].some(path => String(args[0]).endsWith(path)) && response.body) {
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (...options) => {
        const reader = getReader(...options); const read = reader.read.bind(reader);
        reader.read = async () => {
          const result = await read();
          const until = performance.now() + Number(process.env.TEST_PARSE_BLOCK_MS);
          while (performance.now() < until) {}
          return result;
        };
        return reader;
      };
    }
    return response;
  };
}
