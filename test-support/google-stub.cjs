const Module = require('module');
const orig = Module._load;
Module._load = function (name, ...args) {
  if (name === '@google-cloud/speech')
    return {
      v2: {
        SpeechClient: class {
          async initialize() {}
          async recognize(request, options) {
            if (
              request.content.subarray(0, 4).toString() !== 'fLaC' ||
              !options.timeout ||
              options.retry !== null
            )
              throw Error('invalid normalized request');
            if (process.env.REVIEW_GOOGLE_ERROR)
              throw Object.assign(Error('private secret details'), {
                code: Number(process.env.REVIEW_GOOGLE_ERROR),
              });
            return [{ results: [{ alternatives: [{ transcript: '广东话 unchanged' }] }] }];
          }
          async close() {}
        },
      },
    };
  return orig.call(this, name, ...args);
};
