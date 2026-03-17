const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdmissionController } = require('../lib/admission-controller');

test('uses global defaults and rejects when queue is full', async () => {
  const controller = createAdmissionController({
    globalLimits: {
      maxConcurrency: 1,
      maxQueueSize: 1,
      maxWaitMs: 5000
    }
  });

  const first = await controller.acquire({ providerName: 'ollama', requestId: 'r1' });
  const secondPromise = controller.acquire({ providerName: 'ollama', requestId: 'r2' });

  await assert.rejects(
    controller.acquire({ providerName: 'ollama', requestId: 'r3' }),
    (error) => error && error.code === 'ADMISSION_OVERLOADED' && error.reason === 'queue_full'
  );

  first.release();
  const second = await secondPromise;
  second.release();
});

test('provider-specific limits override global defaults when configured', async () => {
  const controller = createAdmissionController({
    globalLimits: {
      maxConcurrency: 2,
      maxQueueSize: 10,
      maxWaitMs: 100
    },
    providerOverridesByName: {
      minimax: {
        maxConcurrency: 1,
        maxQueueSize: 0,
        maxWaitMs: 100
      }
    }
  });

  const first = await controller.acquire({ providerName: 'minimax', requestId: 'r1' });

  await assert.rejects(
    controller.acquire({ providerName: 'minimax', requestId: 'r2' }),
    (error) => error && error.code === 'ADMISSION_OVERLOADED' && error.reason === 'queue_full'
  );

  first.release();
});
