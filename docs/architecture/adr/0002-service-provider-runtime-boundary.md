# ADR 0002: Service and Provider Runtime Boundary

- Status: Provider boundaries implemented for rewrite/T2A/transcription; registered configuration/availability/lifecycle selection implemented in Step 5
- Date: 2026-05-07
- Implementation updated: step-5 branch stacked on PR #134

## Context

The original proposal called for routes to use a service runtime instead of assembling provider adapters and lifecycle details themselves. The refactor branch supplies that runtime, invocation helpers and output writers. Step 5 removes provider-name selection/key decisions from shared routes; service-specific orchestration remains explicit.

## Decision implemented

[`lib/service-runtime.js`](../../../lib/service-runtime.js) constructs the following for each service in [`services/index.js`](../../../services/index.js):

```js
{
  service,
  providerName,
  adapter,
  capabilities,
  timeouts,
  lifecycle,
  getAvailability
}
```

Rewrite and T2A select providers independently. [`providers/index.js`](../../../providers/index.js) uses registered service/provider factories from service-scoped runtime configuration, and [`lib/provider-adapter.js`](../../../lib/provider-adapter.js) dispatches `services[serviceId].sync` / `.stream`, retaining rewrite compatibility shims.

[`lib/service-invoker.js`](../../../lib/service-invoker.js) wraps invocation with admission and lifecycle success/failure recording. [`providers/lifecycle.js`](../../../providers/lifecycle.js) owns active Ollama readiness/warmup, passive MiniMax rewrite readiness/recovery and the no-op lifecycle used by T2A. [`lib/service-output-writer.js`](../../../lib/service-output-writer.js) translates internal output into the public rewrite and audio responses.

The [provider registry](../provider-registry.md) supplies per-service capabilities
and validates factory handler declarations. Runtime capabilities combine that
descriptor with existing configured service capabilities. Lifecycle descriptors now select mode-driven policy; provider-owned hooks supply
settings, availability and compatibility errors.

Service-owned requests now carry rewrite intent or T2A voice selection/audio options;
provider-owned translation applies native prompts, presets and legacy defaults.
Service readers live in `configuration/`; native readers live in
`providers/configuration/` and are selected by registration. See [step 3](../provider-abstraction-step-3.md)
for request contracts and [step 4](../provider-abstraction-step-4.md) for production transcription integration.

## Current limits of the boundary

- `server.js` owns rewrite startup state, readiness gates and timeout selection. Provider availability/cooldown policy and native prompt assembly come from registration/adapters.
- T2A checks support and registered availability without native key/name branches. Only MiniMax T2A ships as a live integration; provider selection does not imply automatic fallback.
- Admission is shared per provider key, not an aggregate limit across all services/providers.
- [`services/transcription.js`](../../../services/transcription.js) is created independently of the rewrite/T2A registry. Its composition now uses the common provider factory/registry, dispatch and result contract, while the service owns upload, input planning, media conversion, neutral recognition deadlines, cleanup and separate capacity limits. Google request/configuration details stay behind composition and its adapter.
- Model status and `/readyz` describe rewrite. They do not establish T2A or Google readiness.
- Image generation and automatic discovery of new services are not implemented. Further generalization is a future design choice, not a committed implementation step.

## Compatibility requirements

Preserve the public contracts in the [API reference](../../reference/api-reference.md): rewrite JSON/NDJSON, T2A binary/base64 JSON, aliases, auth behavior and validation/error codes. Runtime refactors affecting those surfaces require HTTP contract coverage before changing the boundary.

Evidence: [`tests/service-runtime.test.js`](../../../tests/service-runtime.test.js), [`tests/service-invoker.test.js`](../../../tests/service-invoker.test.js), [`tests/provider-lifecycle.test.js`](../../../tests/provider-lifecycle.test.js), [`tests/api-contract.test.js`](../../../tests/api-contract.test.js), and [`tests/t2a-routes.test.js`](../../../tests/t2a-routes.test.js).

## Consequences

The existing boundary supports independent rewrite/T2A provider configuration and centralized invocation/output handling. Future service work can build on it, but must account for remaining server orchestration and transcription's separate lifecycle rather than assuming every service already follows one generic path.

See [Step 5](../provider-abstraction-step-5.md) and the
[provider author guide](../../guides/adding-a-provider.md) for current extension and retirement.
