# Documentation review against main — 2026-10-06

## Scope and baseline

Reviewed all tracked standalone repository documents: 12 Markdown files and `LICENSE` (13 original documents). `git ls-files` showed no other standalone document formats. Source comments, scripts, configuration examples, tests, package files and workflow files were read as evidence and were not changed. No external consumer repository, live deployment or external document was reviewed.

Baseline: main `2a453d040506b909ada41842eed3f7b2347dbf82` (merge of the stable T2A voice-choice implementation). GitHub's main ref and a refreshed `origin/main` agreed. The documentation branch starts from that commit.

The review followed current code from middleware to validation, service/runtime/provider invocation and response writing. A plan was not classified by its wording or age alone. “Amend” means retain as active guidance while correcting claims/navigation; “archive” means preserve a completed plan as historical context; “keep” means no change needed.

## Complete original-document decisions

Paths in the first column are original repository paths. Destinations link to the current documents.

| Original document | Decision / destination | Evidence and reason |
|---|---|---|
| `README.md` | Amend; [keep at root](../../README.md) | `server.js`, `services/*`, output writer, proxy and unit examples establish three implemented services, aliases, rewrite-only readiness, actual auth and static-hosting behavior. Removed public rewrite artifacts claim and aligned navigation/examples. |
| `AGENTS.md` | Amend; [keep at root](../../AGENTS.md) | Its root instruction role still applies. Added implemented opt-in transcription to scope and updated moved reference paths; preserved compatibility, safety and testing requirements. |
| `LICENSE` | Keep; [root license](../../LICENSE) | MIT notice and attribution remain the repository's legal document, not a runtime plan. No code-dependent correction or relocation warranted. File unchanged. |
| `docs/api-reference.md` | Amend; [reference/api-reference.md](../reference/api-reference.md) | `server.js`, service validators, header auth, rate/admission middleware and output writers define the actual public response fields, ordering, formats and errors. Corrected misleading artifacts/stream aliases, proxy trust, admission and parser/audio behavior. Nine-choice catalogue and transcription limits match their modules and remain active. |
| `docs/env-reference.md` | Amend; [reference/env-reference.md](../reference/env-reference.md) | `services/rewrite.js`, `services/t2a.js`, `lib/env-config.js`, `lib/transcription-config.js`, `server.js`, limiter and admission code confirm defaults. Added precedence, validation/ranges, privacy limits of debug logging and script-only settings. |
| `docs/rewrite-t2a-api-calling-reference.md` | Amend; [guides/rewrite-t2a-api-calling-reference.md](../guides/rewrite-t2a-api-calling-reference.md) | Validators and `providers/minimax.js` confirm the voice choices and raw controls. Corrected auth description, parser-size outcome and the assertion that accepted WAV/PCM output is necessarily MP3 bytes. Fixed binary download commands that included response headers. |
| `docs/deployment-guide.md` | Amend; [guides/deployment-guide.md](../guides/deployment-guide.md) | `package.json`, CI, `systemd/rewrite-bridge.service`, `apache/proxy-snippet.conf`, runtime and readiness handlers establish supported Node versions, actual template paths, omitted T2A mapping and rewrite-only readiness. Transcription already exists, so link its operational runbook instead of treating Google as a future implementation. |
| `docs/transcription-deployment.md` | Amend; [runbooks/transcription-deployment.md](../runbooks/transcription-deployment.md) | Transcription service, config/media/upload/files modules, Google provider and smoke helper match most of this guide. Retain active checkpoints; replace PR-specific and unprovable live Whisper/VPS claims, clarify credential exports, cleanup failures and commit-dependent rollback compatibility. |
| `docs/runbooks/auth-matrix-manual-cli-checklist.md` | Amend; [retain in runbooks](../runbooks/auth-matrix-manual-cli-checklist.md) | All six POST aliases use shared header auth, including disabled transcription. Extend matrix accordingly, use an auth-only transcription body, account for limiter ordering and distinguish OIDC cookie sessions from independently configured bearer-token gateways. |
| `public/rewrite-widget/README_rewrite_widget.md` | Amend/move; [guides/rewrite-widget.md](../guides/rewrite-widget.md) | `rewrite-widget.js` has asynchronous `mount`, default max 100 UTF-16 code units, shared periodic polling and rewrite-only API calls. `server.js` has no static routes. Replace nonworking backend asset proxy/example with frontend static hosting; complete header hygiene and fix docs location. JS/HTML assets stay in place. |
| `docs/adr/0001-internal-bridge-contract.md` | Amend/move; [architecture/adr/0001-internal-bridge-contract.md](../architecture/adr/0001-internal-bridge-contract.md) | `lib/bridge-contract.js` now includes `output` and text-event `payload` alongside compatibility aliases. Contract helpers shape data; they do not themselves enforce stream ordering. Public writers define HTTP fields. Keep the accepted architecture active. |
| `docs/adr/0002-service-provider-runtime-boundary.md` | Amend/move; [architecture/adr/0002-service-provider-runtime-boundary.md](../architecture/adr/0002-service-provider-runtime-boundary.md) | Runtime, invoker, lifecycle and output-writer modules implement the rewrite/T2A boundary. `server.js` still has provider-specific orchestration, and transcription bypasses the registry. Replace “Proposed” with the implemented scope and remaining limits; remove the implication of committed image-service work. |
| `docs/t2a-voice-choice-pr-plan.md` | Archive; [past/plans/t2a-voice-choice-pr-plan.md](../past/plans/t2a-voice-choice-pr-plan.md) | `lib/t2a-voice-choices.js`, T2A validator and route tests prove all nine choices/mappings and strict conflicts are implemented on main. Preserve the entire original plan body/validation record and add an archive notice linking to active contracts. Branch/PR instructions and external-consumer observations are historical, not current authorization. |

Totals: **11 amended active documents, 1 archived completed plan, 1 unchanged license**. Nine original files moved: eight active documents and one archived plan. No original document was discarded. Both ADRs remain active because the architecture they describe still exists.

## New navigation and current-flow documents

- [Documentation index](../README.md): entry point and folder responsibilities, replacing scattered flat links.
- [Current runtime](../architecture/runtime.md): source-backed startup, middleware, rewrite/T2A and independent transcription flows, plus present deployment/widget boundaries.
- [Past index](../past/README.md): archive rationale and current replacement links.
- This review record: complete inventory, decisions, evidence and validation snapshot.

Folder structure:

```text
README.md
AGENTS.md
LICENSE
docs/
  README.md
  reference/
    api-reference.md
    env-reference.md
  guides/
    deployment-guide.md
    rewrite-t2a-api-calling-reference.md
    rewrite-widget.md
  runbooks/
    auth-matrix-manual-cli-checklist.md
    transcription-deployment.md
  architecture/
    runtime.md
    adr/
      0001-internal-bridge-contract.md
      0002-service-provider-runtime-boundary.md
  past/
    README.md
    plans/
      t2a-voice-choice-pr-plan.md
  reviews/
    2026-10-06-documentation-review.md
public/rewrite-widget/       # existing JS and HTML only; assets unchanged
```

## Material corrections and their code basis

### Public API versus internal output

`lib/bridge-contract.js` supports structured output/artifacts, but `writeRewriteJsonSuccess` serializes only `ok`, `result` and optional `usage`. `writeRewriteStreamText` emits `response`, not `result`; the widget's ability to accept `result` is client compatibility behavior. Updated README/API/ADR wording and the API success example accordingly. Existing HTTP contract tests explicitly assert these public keys.

### Authentication and identity are different checks

`auth/header-auth.js` checks secret/email content; it does not consult trusted addresses or validate full email syntax. `auth/client-identity.js` separately uses socket-address trust and the secret to select a user limiter key. Documentation previously conflated those checks. Updated active guidance without changing auth code, network binding or policy.

Global/service limiter ordering can cause 429 before rewrite/T2A auth. Transcription's service limiter follows auth. The manual matrix now covers both aliases of all three services and deliberately rejects transcription media before a Google call. The Apache sample's `AuthType openid-connect` provides interactive OIDC session protection; a bearer-token mode cannot be inferred from it.

### Limits and precedence

`lib/admission-controller.js` tracks capacity per provider, so MiniMax rewrite/T2A share one pool while Ollama has its own. `ADMISSION_*` are pool defaults, not an aggregate ceiling. The baseline request limiter likewise counts per identity; “global” describes route coverage.

`services/rewrite.js` and `services/t2a.js` choose the first non-empty preferred key, then try a legacy value/default if that selected value is invalid. Bridge aliases use a separate reader. Streaming preference is ordered, not the OR of three toggles. Added these rules and actual numeric bounds. Preserved the 200-character defaults, 4,000 rewrite ceiling, 1,000 T2A ceiling and all nine preset mappings that already matched code.

### Audio response metadata and downloads

MiniMax forwards `audio_setting.format` and returns extracted bytes without transcoding. Its output `format` is currently hardcoded to `mp3`; MIME metadata can reflect upstream WAV/PCM content. Corrected the claim that all returned bytes can be treated as MP3 and documented the current metadata limitation. Removed `curl -i` from examples saving binary audio, because it writes HTTP headers into the audio output file. Defaults and output-writer code are unchanged.

### Actual deployment examples

The checked-in systemd unit uses `hsadmin` and `/workspace` paths, whereas the guide installs under `/opt`. The guide now requires editing the installed template to the real account/path before starting it. The checked-in Apache snippet omits T2A and comments out transcription; active docs explain the required deployed mappings instead of implying the snippet exposes every implemented service. `/readyz` checks rewrite only. No unit/proxy file was modified.

The Google backend is already implemented. Its runbook remains active, with release-neutral instructions and code-specific cleanup/deadline behavior. Removed unsupported assertions about live VPS experiments and the state of an independent Whisper service. Rollback settings must be checked against the target commit; current main already accepts 2,000 rewrite characters. Existing external provider reference links are retained without claiming this repo-only review rechecked their content.

### Widget behavior

`mount()` returns a Promise; consumers must await it to call instance methods. The widget uses a default 100 UTF-16-code-unit budget, independent of the backend's Unicode-code-point limit. `pollModelStatus=false` skips only an extra initial poll, not shared subscription polling. `server.js` does not serve static assets, so the guide now hosts them through the frontend web server. Neither widget source nor its example HTML was changed.

### Completed work versus current design

The archived voice plan is implemented; its remaining live listening review is not evidence that the API implementation is pending. The ADRs describe live architectural boundaries, so they were updated rather than archived. ADR 0002 accurately records the implemented runtime and remaining server/provider branches, with transcription's separate lifecycle and no claimed image-generation service.

## Validation and limits

- Full existing `npm test` suite: **203 passed, 0 failed, 0 skipped**, Node **24.19.0**, including real FFmpeg/FFprobe normalization and mocked-provider HTTP contracts. The first sandboxed attempt lacked localhost socket permission; the successful rerun enabled access for local test servers. No repository change was made to accommodate that environment restriction.
- All **119 local Markdown file/heading links** passed after moves; historical old path literals in the preserved plan are intentional.
- All **32 active Bash command examples** passed `bash -n` without being executed. Environment-file blocks are labeled `env` and the voice ID containing parentheses is quoted in the deployment example.
- Archived original plan body compared with its baseline copy; unchanged below the new notice.
- `git diff --check` and a documentation-only path/content check confirm no JS, HTML, tests, package/lock files, workflow, unit, Apache configuration or license changes.

This review does not establish active production settings, downstream UI adoption, Google billing/quota/language availability or live voice accuracy. Tests used local mocks/synthetic media and made no live paid cloud requests. Those deployment/listening checks remain operator activities in the active runbooks; they do not authorize new code work or deployment through this documentation PR.
