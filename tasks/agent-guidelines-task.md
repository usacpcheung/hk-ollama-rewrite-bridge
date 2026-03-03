# Agent Guidelines Task

## Objective
Define clear agent constraints and contribution requirements for the repository.

## Deliverables
- `AGENTS.md` is published at repository root.
- The guidance has been reviewed for completeness and applicability.

## Acceptance Criteria
- Policy sections are complete (purpose/scope, safety, change rules, testing, docs sync, review checklist).
- Referenced paths are correct (`AGENTS.md`, `README.md`, `docs/api-reference.md`).
- Final guideline content is reviewed by a maintainer.

## Maintainer Follow-up Validation
- Validation scope: verify nested `AGENTS.md` files are introduced only when stricter local rules are required.
- Current repository check: only root `AGENTS.md` is present.
- Maintainer action: confirm any future nested `AGENTS.md` additions include explicit stricter-scope rationale in the same PR.
