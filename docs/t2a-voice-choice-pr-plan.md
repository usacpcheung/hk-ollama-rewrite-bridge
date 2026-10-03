# PR plan: abstract T2A voice choices

Status: implementation and PR publication authorized on 2026-09-29, limited to this repository. Deployment is outside scope. The rules below record the implementation contract.

## Problem and intended outcome

The worksheet editor and RolePlayScene currently send MiniMax voice IDs and numeric delivery settings to the bridge. Changing speech providers would require changing those consumers, and RolePlayScene's Professional Female selection currently relies on the bridge's configurable defaults rather than an explicit voice identity.

Introduce a stable `voice_choice` request field. Each choice represents a language, voice character and delivery style. The bridge owns the mapping to provider-specific voice IDs, speed, pitch, volume and supported effects. Consumers continue to receive the same audio response through the same endpoints.

Keep the current MiniMax provider and configured speech model. A Google integration or Speech 2.8 upgrade is a separate decision and PR. Do not implement speculative Google mappings in this work.

## Repository scope and branch

This planning checkout uses `codex/t2a-voice-choice-plan`, created from refreshed `origin/main` at `5ade72716b471dd4cf424256222c1afcfe2b4f2d` on 2026-09-29. Local `main` was older, so the remote main ref was refreshed before creating the checkout. The original checkout is preserved.

The implementation branch remains based on main. Refresh main before final validation and integrate any newer base changes if needed.

One PR in `hk-ollama-rewrite-bridge`: **Add stable T2A voice choices with MiniMax mappings**. Add the contract, mappings, validation, compatibility tests and documentation only in this repository.

The web worksheet launcher is an external consumer used as a read-only reference. This PR does not change its code, UI, API client, presets, tests, saved content, deployment or branch. Consumer migration is outside this plan. Existing consumers continue to send their existing requests; adding `voice_choice` does not automatically migrate them.

The authorized work includes implementation, validation, pushing the branch and creating the PR. Merging and deployment remain outside scope.

## Reviewed mappings

The seven Cantonese choices provide three male character sounds, three female character sounds and one dedicated female narrator. Add Putonghua and English narration corresponding to the worksheet editor's existing settings. These are bridge capabilities; the mapping table does not instruct changes to the consumer.

| Intended use (reference only) | Stable `voice_choice` | Suggested label | MiniMax `voice_id` | Speed | Pitch | `language_boost` |
| --- | --- | --- | --- | ---: | ---: | --- |
| RolePlayScene | `cantonese_male_1` | 男聲一：活潑、較低音 | `Cantonese_PlayfulMan` | 1.1 | -1 | `Chinese,Yue` |
| RolePlayScene | `cantonese_male_2` | 男聲二：活潑、較高音 | `Cantonese_PlayfulMan` | 1.1 | 3 | `Chinese,Yue` |
| RolePlayScene | `cantonese_male_3` | 男聲三：穩重、清晰 | `Cantonese_ProfessionalHost（M)` | 1.1 | 1 | `Chinese,Yue` |
| RolePlayScene | `cantonese_female_1` | 女聲一：可愛、明亮 | `Cantonese_CuteGirl` | 1.1 | 2 | `Chinese,Yue` |
| RolePlayScene | `cantonese_female_2` | 女聲二：溫柔、平靜 | `Cantonese_GentleLady` | 1.1 | 0 | `Chinese,Yue` |
| RolePlayScene | `cantonese_female_3` | 女聲三：親切、自然 | `Cantonese_KindWoman` | 1.1 | 1 | `Chinese,Yue` |
| RolePlayScene and editor Cantonese | `cantonese_narrator_female` | 旁白：專業女聲 | `Cantonese_ProfessionalHost（F)` | 1.0 | 0 | `Chinese,Yue` |
| Editor Putonghua | `mandarin_narrator_female` | 普通話：專業女聲 | `Chinese (Mandarin)_News_Anchor` | 1.0 | 0 | `Chinese` |
| Editor English | `english_narrator_female` | English: clear female narrator | `English_compelling_lady1` | 0.85 | 0 | `English` |

All mappings use volume 1 and additional `voice_modify` pitch/intensity/timbre of 0. Preserve the unusual full-width opening parenthesis and ASCII closing parenthesis in the two ProfessionalHost IDs exactly as returned in the supplied voice-list snapshot.

The snapshot contains only two native Cantonese male IDs. Male 1 and Male 2 therefore share the Playful Man identity with different pitch settings. These are three male sound presets, not three independent base speakers. Listening review remains an optional pre-deployment check; no real synthesis is included in the automated test results.

The catalogue descriptions and prior launcher settings inform these proposals; no new samples have been generated. The new professional male and kind female tuning comes from the user's requested speed 1.1 and pitch +1.

## Public API contract

Add optional `voice_choice` to both `/t2a` and `/api/t2a`. Existing endpoint aliases and external proxy URLs remain unchanged. Existing requests do not need to adopt the field.

Example:

```json
{
  "text": "你好，今日過得點呀？",
  "voice_choice": "cantonese_male_2",
  "format": "mp3",
  "response_mode": "binary"
}
```

Rules implemented:

- When `voice_choice` is absent, preserve the complete existing request path, raw `voice_id` support, validation, environment precedence and default behaviour.
- When present, require a non-empty string matching a known, case-sensitive stable ID after trimming. Reject null, empty strings, objects, arrays, numbers and unknown IDs with HTTP 400 / `INVALID_INPUT` before a provider call. Never fall back to another choice for an unknown ID.
- A choice is a complete preset. For the initial release, reject requests combining it with explicit `voice_id`, `language_boost`, `speed`, `volume` or `pitch`, including null values for those conflicting fields, with HTTP 400 / `INVALID_INPUT`. This avoids silently ignored fields and provider-specific override semantics.
- Keep output controls such as `format`, `sample_rate`, `bitrate` and `response_mode` independent, with existing validation and defaults.
- A named choice uses its explicit mapped voice controls and language instead of generic environment voice defaults. API key, endpoint, configured model, output defaults, limits and timeouts retain their existing configuration.
- A future configured provider lacking a mapping for a valid choice must return a controlled unsupported-choice error. Use HTTP 422 / `VOICE_CHOICE_UNSUPPORTED`; do not silently substitute a voice or another provider. Existing unsupported-provider/service errors retain their current behaviour.
- Preserve existing validation ordering for legacy requests. In particular, streaming rejection and existing text-length checks remain unchanged.

Do not change binary audio bytes, Content-Type, Content-Disposition, default response mode or base64 JSON fields (`ok`, `audio`, `format`, `mime`, `contentType`, `size`, `provider`). Do not add a required discovery call, change rewrite responses, or change auth, trusted headers, readiness, warmup, admission control or localhost binding.

A public voice-catalogue endpoint and adjustable controls for named presets can be considered later if there is a demonstrated consumer need. No new environment variables are needed for the initial explicit mapping table.

## Bridge implementation approach

Add a small catalogue/resolver module, for example `lib/t2a-voice-choices.js`, with stable choice metadata separated from provider mappings. Initially only MiniMax mappings are populated. Numeric pitch values belong to provider mappings, not the public definition of a character.

Resolve a choice through the selected service provider in `services/t2a.js`, after existing input checks and before producing the internal invocation payload. Return the existing normalized voice, language and effects shape so the existing MiniMax request adapter continues to work.

Avoid separating or refactoring the wider provider/service runtime. Limit changes to the additive choice resolution. The MiniMax HTTP request must not contain `voice_choice`; it receives only its native mapped fields.

Inspect the implementation baseline before editing. Preserve HTTP-level contract coverage before changing route dispatch or response handling; such changes should be unnecessary for this design.

Update `README.md` and `docs/api-reference.md` in the same implementation PR. Update `docs/rewrite-t2a-api-calling-reference.md` with named-choice examples and backward-compatibility guidance. Explain the distinction between named presets and legacy raw settings. Update environment documentation only if review changes the plan to introduce new configuration.

## Existing consumer requests as compatibility fixtures

Read-only inspection of the worksheet editor and RolePlayScene established the settings below. Represent these requests in this repository's HTTP contract tests; do not edit or run tests in the external project.

- Editor Cantonese: explicit `Cantonese_ProfessionalHost（F)` and `Chinese,Yue`, with speed, pitch and volume omitted.
- Editor Putonghua: explicit `Chinese (Mandarin)_News_Anchor` and `Chinese`, with speed, pitch and volume omitted.
- Editor English: explicit `English_compelling_lady1`, `English` and speed 0.85, with pitch and volume omitted.
- RolePlayScene Professional Female: no voice controls or language setting; uses existing bridge defaults.
- RolePlayScene Playful Man: explicit `Cantonese_PlayfulMan`, speed 1.1, volume 1 and pitch -1, with language omitted.
- RolePlayScene Playful Man (high pitch): the same raw voice and controls with pitch 3.
- RolePlayScene Cute Girl: explicit `Cantonese_CuteGirl`, speed 1.1, volume 1 and pitch 2, with language omitted.
- RolePlayScene Gentle Lady: explicit `Cantonese_GentleLady`, speed 1.1, volume 1 and pitch 0, with language omitted.

Preserve these requests exactly when `voice_choice` is absent, including environment-based defaults for omitted fields. Do not reinterpret native voice IDs as abstract choices, silently retune existing callers, or change the default voice. The two new character mappings are available to explicit API callers; this PR does not add them to any external menu.

## Validation plan

### Bridge automated and manual checks

- Run the existing baseline `npm test`, then the full suite after implementation as required by AGENTS.md.
- Exercise all nine choices through the existing routes against a local MiniMax mock. Assert exact outgoing native voice ID, language, speed, pitch, volume and zero additional effects. Assert that the abstract ID is not forwarded to MiniMax.
- Exercise both route aliases, default binary response and explicit base64 JSON response; verify response headers and existing JSON field shapes.
- Prove explicit choice mappings stay stable when generic environment voice defaults differ. Prove legacy requests still use those overrides with existing precedence.
- Cover invalid and conflicting choice inputs, no provider invocation on rejected input, and resolver behaviour when a provider mapping is missing.
- Retain regression coverage for rewrite, auth/identity gatekeeping, existing error codes, streaming rejection, text budgets, timeout and missing API key behaviour.
- Perform manual HTTP smoke checks against an isolated localhost test instance for successful audio responses and representative validation/auth failures. Use mocks for automatic tests; no billable provider calls in CI.

### Consumer compatibility checked inside this repository

- Submit all reference requests above to the bridge's local HTTP test instance and mock provider.
- Assert unchanged normalized provider payloads, inherited defaults, status codes and audio response contracts.
- Include cases with non-default environment voice settings to prove that omitted legacy fields still inherit them, while explicit named choices use their reviewed mappings.
- Include text-only requests to preserve older consumer flows without adding consumer migration work.

### Listening review

After separate authorization for real provider calls, generate a short common Cantonese passage using the current model for all seven Cantonese choices, including dialogue, numbers and punctuation. Include English and Putonghua narration samples. Compare clarity, character distinction and comfortable reading speed; adjust only the mapping table if needed.

Check the live bridge's effective voice, pitch, speed and volume configuration before claiming exact preservation of narrator/editor defaults. The inspected code defaults are 1.0/0/1, but deployment overrides were not inspected.

## Bridge release and rollback considerations

This PR prepares a backward-compatible bridge release. Deployment is a later authorized operation, not a task in the current planning step.

1. Confirm the reviewed mappings and API contract in the PR.
2. Implement and validate this repository's additive API support on main-based code.
3. Record automated tests, local HTTP smoke checks and any authorized listening results in the PR.
4. If deployment is later requested, use the normal bridge service update procedure and verify both named-choice and legacy requests after the update. Do not modify the worksheet launcher deployment.

An isolated localhost bridge instance and mocked provider are sufficient for mapping and HTTP contract tests. No production worksheet generation shutdown or separate production-sized test server is required for these tests. A later bridge process restart may still cause a brief interruption; additive API compatibility alone does not guarantee zero downtime.

The unchanged launcher continues using legacy requests, so reverting this bridge addition does not require launcher changes. If another consumer later adopts `voice_choice`, coordinate a rollback before removing the API capability it uses. No saved audio or consumer records need migration, deletion or regeneration in this PR.

## Acceptance criteria and remaining listening review

The implementation uses the `voice_choice` IDs and mappings above, including speed 1.1 and pitch +1 for the professional male and kind female, strict mixed-field rejection and the controlled unsupported-choice error. Real audio quality and distinction between the two playful male variants remain unverified until a listening review.

The implementation is complete only when all nine mappings match the reviewed settings, existing consumer request fixtures and public API contracts pass unchanged, documentation is synchronized, and validation evidence is recorded. Only this repository may be changed by the PR. External consumers are not required to send abstract choices for this PR to be complete. Once a consumer independently adopts the stable choices, a future provider should require bridge-side mapping and adapter work rather than changes to those choice IDs in the consumer.

## Implementation validation record

Validated on 2026-09-29 with Node 24.12.0:

- Baseline `npm test`: 191 passed, 1 skipped.
- Focused voice-choice, T2A validation and HTTP route tests: 28 passed.
- Final `npm test`: 202 passed, 1 skipped; the existing real-FFmpeg test is skipped because FFmpeg/FFprobe is unavailable locally.
- Manual `curl.exe` against an isolated localhost bridge and MiniMax mock: named binary and base64 JSON responses, English mapping, legacy environment defaults, unknown/conflicting choices (400), missing auth (401), overlong text (413) and unsupported streaming (501) passed. Rejections made no provider calls.
- No real MiniMax synthesis or live-server listening checks were performed. The worksheet launcher was not changed.
