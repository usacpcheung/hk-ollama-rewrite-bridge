# Repository documentation

Active guidance was reviewed against main commit `31ce143878ef0f41627b95e8511ac268b67adba5` on 2026-10-06. The implementation, not an old plan's status, determined each document's disposition. See the [review record](reviews/2026-10-06-documentation-review.md) for the complete original-file inventory, code evidence and changes.

## Find the right document

| Folder / document | Purpose |
|---|---|
| [Project README](../README.md) | Service overview and quick start |
| [API reference](reference/api-reference.md) | Current endpoints, fields, response shapes and errors |
| [Environment reference](reference/env-reference.md) | Runtime defaults, aliases, precedence and diagnostic-script settings |
| [Caller guide](guides/rewrite-t2a-api-calling-reference.md) | Rewrite/T2A integration examples |
| [Deployment guide](guides/deployment-guide.md) | Install, systemd and protected proxy setup |
| [Widget guide](guides/rewrite-widget.md) | Static hosting, asynchronous widget API and UI behavior |
| [Auth runbook](runbooks/auth-matrix-manual-cli-checklist.md) | Local auth/alias matrix and deployment gateway checks |
| [Transcription runbook](runbooks/transcription-deployment.md) | Opt-in Google/media setup, validation, rollback and cleanup |
| [Compatibility baseline](architecture/compatibility-baseline.md) | Code/test-backed contracts, legacy support, corrected defects and remaining coverage gaps |
| [Runtime architecture](architecture/runtime.md) | Current request flows and actual service/provider boundaries |
| [ADR 0001](architecture/adr/0001-internal-bridge-contract.md) | Accepted internal result/event contract |
| [ADR 0002](architecture/adr/0002-service-provider-runtime-boundary.md) | Implemented rewrite/T2A boundary and remaining limits |
| [Past documents](past/README.md) | Completed/superseded plans preserved as history |
| [Review record](reviews/2026-10-06-documentation-review.md) | File-by-file decisions and validation evidence |

`README.md`, `AGENTS.md` and `LICENSE` remain at the repository root for their conventional roles. Browser code and its runnable example remain under `public/rewrite-widget/`; their documentation now lives with the other guides.

## Maintaining this structure

- Put exact contracts/defaults in `reference/`, task guidance in `guides/`, operational checks in `runbooks/`, and current design/decisions in `architecture/`.
- A completed plan belongs in `past/`, with its original content preserved and a notice linking to the implemented capability's active documentation.
- Keep accepted architectural decisions active when their boundary still exists; amend them when the code evolves. Do not archive a valid design solely because it is old.
- Record review scope and code evidence in `reviews/`. A dated review is a snapshot, not a guarantee about later commits.
- When changing API/env behavior, update the active references and root README as required by `AGENTS.md`. Keep navigation and relative links working after moves.

This review inspected repository files only. Public proxy URLs, service-account names and deployment paths are examples to adapt; the repository cannot prove the live server configuration, external consumers, Google access/quota or voice quality.
