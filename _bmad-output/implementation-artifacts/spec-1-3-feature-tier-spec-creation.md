---
title: 'Story 1.3: Feature-tier spec creation'
type: 'feature'
created: '2026-08-20'
status: 'done'
baseline_commit: '4061c1c9f1d22816ce62d83ed3ea0b70ee8d4021'
review_loop_iteration: 1
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Waypoint can only create patch-tier specs (Story 1.2). Feature-tier changes need heavier ceremony — requirements/design/task-list sections plus a task ledger `waypoint verify` will later write to — and there is no `new-feature` command to scaffold that.

**Approach:** Implement `waypoint new-feature <name>`, reusing Story 1.2's name-validation and install-check logic: write `specs/features/<name>.md` (requirements/design/task-list, one placeholder task) plus a matching `tasks/<id>.ledger.yaml` (keyed by the spec's full frontmatter `id`, matching `docs/architecture.md`'s documented ledger-path convention) with that one task `pending`. `waypoint new-system <name>` (a materially different multi-file spec-set) is deferred to its own spec — see `deferred-work.md`.

## Boundaries & Constraints

**Always:**
- Error clearly, before touching the filesystem, if `.waypoint/config.yaml` doesn't exist or isn't a file — reuse `WaypointNotInstalledError`.
- Validate `<name>` with the same rule as `new-patch` — reuse `isValidName`'s pattern/length check and `InvalidSpecNameError`.
- Check `<name>` for collision against all three tiers' spec paths (`specs/{patches,features,systems}/<name>.md`) **and** against `tasks/<id>.ledger.yaml` (`id` = `feat-<date>-<name>`) — if any already exists, error without writing either new file.
- Write exactly two files: `specs/features/<name>.md` (frontmatter `id: feat-<date>-<name>`, `tier: feature`, `status: draft`, `approved_by: null`, `approved_at: null`, `created_at`; body sections `## Requirements`, `## Design`, `## Task List` with exactly one placeholder task) and `tasks/<id>.ledger.yaml` — keyed by the spec's full `id`, not the bare `<name>`, matching `docs/architecture.md`'s documented `tasks/<spec-id>.ledger.yaml` convention (its own worked example: `tasks/feat-2026-08-19-auth-refresh.ledger.yaml`) so Epic 3's `waypoint verify <spec-id> <task-id>` can locate it directly (`spec_id` matching the spec's `id`; one task entry mirroring the placeholder, `status: pending`, `linked_commit: null`, `verified_by_gate: false`). Use exclusive-create (`'wx'`) for both writes, same TOCTOU protection as `new-patch`.
- No network calls, no confirmation prompts.

**Ask First:** none anticipated — reuses already-approved validation/install-check rules; new design surface is scoped by the Always bullets above.

**Never:**
- Parse or sync an arbitrary, human-edited task list into ledger rows — that's `waypoint update`'s delta-sync scope (Epic 2 Story 2.1). `new-feature` writes exactly one placeholder task/ledger-row pair, nothing more.
- Implement `waypoint new-system` — deferred (see `deferred-work.md`).
- Touch `waypoint verify`/`approve`, gate/hook logic, or CI (Epic 3's scope).
- Modify `new-patch`'s own behavior — only reuse its exported helpers/types.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Not installed | `.waypoint/config.yaml` missing | Errors, tells user to run `waypoint install` first | Clear message, no filesystem write |
| Happy path | Installed repo, valid unused `<name>` | Both `specs/features/<name>.md` and `tasks/<id>.ledger.yaml` created, ledger's one task is `pending` and its `spec_id` matches the spec's `id` | N/A |
| Spec-name collision | `<name>` already exists as a spec at any tier | Errors, no overwrite, neither file written | Clear message naming the colliding spec path |
| Ledger-name collision | `<name>`'s spec path is free but `tasks/<id>.ledger.yaml` already exists | Errors, no overwrite, neither file written | Clear message naming the colliding ledger path |
| Invalid name | `<name>` empty, missing, too long, or has path-traversal/invalid characters | Errors before any filesystem check | Clear validation message |

</frozen-after-approval>

## Code Map

- `packages/core/src/new-spec.ts` (extend) -- add `createFeatureSpec(cwd, name)`, reusing `isValidName`/`todayIsoDate`/`SPEC_TIERS` and the existing `WaypointNotInstalledError`/`InvalidSpecNameError`/`SpecNameCollisionError` types (`packages/core/src/new-spec.ts:16-158`) — same check order as `createPatchSpec`, plus the ledger-path collision check and the second write
- `packages/core/src/templates/feature.ts` (new) -- `renderFeatureSpec(name, createdAt)` returning frontmatter + Requirements/Design/Task List body with one placeholder task; mirrors `renderPatchSpec`'s pattern (`packages/core/src/templates/patch.ts:11`)
- `packages/core/src/templates/feature-ledger.ts` (new) -- `renderFeatureLedgerYaml(specId, taskDescription)` using `yaml`'s `stringify()`, same approach as `renderConfigYaml()` (`packages/core/src/config-defaults.ts:46`) rather than hand-formatted YAML text
- `packages/core/src/index.ts` -- export `createFeatureSpec`, `renderFeatureSpec`, `renderFeatureLedgerYaml` alongside the existing patch exports (`packages/core/src/index.ts:14-22`)
- `packages/cli/src/commands/new-feature.ts` (new) -- thin handler mirroring `new-patch.ts`'s try/catch → clean exit-code + command-agnostic-error-framing pattern (`packages/cli/src/commands/new-patch.ts:19`)
- `packages/cli/src/program.ts` -- replace the `new-feature` stub registration (`packages/cli/src/program.ts:38`) with a real command; `new-system` remains a stub
- `packages/core/src/new-spec.test.ts` (extend) -- unit-test all five I/O matrix rows for `createFeatureSpec`
- `packages/cli/src/install.test.ts` (extend) -- add the `new-feature` exit-code contract alongside the existing `new-patch`/stub-command tests

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/templates/feature.ts` -- write `renderFeatureSpec(name, createdAt)` -- single source of truth for the feature spec's frontmatter + body shape
- [x] `packages/core/src/templates/feature-ledger.ts` -- write `renderFeatureLedgerYaml(specId, taskDescription)` -- single source of truth for the matching ledger's shape
- [x] `packages/core/src/new-spec.ts` -- implement `createFeatureSpec`: install-check, name validation, spec+ledger collision checks, both writes -- the actual behavior under test in the I/O matrix
- [x] `packages/core/src/index.ts` -- export `createFeatureSpec` and the two new template functions
- [x] `packages/cli/src/commands/new-feature.ts` + `packages/cli/src/program.ts` -- wire `waypoint new-feature <name>` to `createFeatureSpec`, replacing the existing stub
- [x] `packages/core/src/new-spec.test.ts` -- unit-test all five I/O matrix rows
- [x] `packages/cli/src/install.test.ts` -- extend with the exit-code contract for `new-feature`'s error paths

**Acceptance Criteria:**
- Given the created feature spec, when its frontmatter is inspected, then `status` is `draft` and `tier` is `feature`
- Given the matching ledger file, when it is inspected, then its `spec_id` matches the spec's frontmatter `id` and its one task's `status` is `pending`

## Spec Change Log

- 2026-08-21: Implemented per spec. All seven tasks complete; `npm test` (64/64) and the manual scratch-dir CLI run both pass. All five I/O matrix rows and both acceptance criteria independently re-verified (not-installed, happy path with correct spec+ledger content, spec-name collision, ledger-only collision leaving the spec unwritten, invalid/path-traversal name). `new-patch` and the `new-system` stub both regression-checked and unaffected. One addition beyond the letter of the spec: a `LedgerNameCollisionError` type (distinct from `SpecNameCollisionError`, whose message text is specific to a spec-path collision) and a rollback of the just-written spec file if the ledger write loses a TOCTOU race after the spec write already succeeded — both are minimal, natural extensions of the spec's own "no overwrite"/"neither file written" invariant, not scope creep. No other boundary/constraint deviations.

- 2026-08-21: Review (blind-hunter) found the ledger filename (`tasks/<name>.ledger.yaml`) deviates from `docs/architecture.md`'s documented `tasks/<spec-id>.ledger.yaml` convention, which Epic 3's `waypoint verify <spec-id> <task-id>` will need for direct lookup. Human renegotiated the frozen intent: amended the two `<frozen-after-approval>` Always bullets and the I/O matrix's Happy-path/Ledger-name-collision rows to key the ledger filename by the spec's full `id` instead of the bare `<name>`. KEEP: everything else about the check order, error types, and TOCTOU protection is unchanged and must survive re-derivation. Re-implementing this rename, plus 9 additional patch-level findings from the same review round, next.
- 2026-08-21: All 10 findings from the review round fixed: ledger now keyed by full `id` (`tasks/feat-<date>-<name>.ledger.yaml`); `createFeatureSpec`'s ledger-write failure path now rolls back the just-written spec file on *any* failure, not just `EEXIST` (closing a gap that could have permanently orphaned a spec name with no repair route); the rollback's own `rm()` call is best-effort and swallows its own errors; a new `isInstalled()` helper guards `statSync` against non-ENOENT failures on both `createPatchSpec` and `createFeatureSpec`; added a real `createProgram()` + `parseAsync(['new-feature', ...])` CLI-wiring test; added the generic-error-fallback test and the blocked-`tasks/`-directory test for `new-feature`, mirroring `new-patch`'s existing coverage; `LedgerNameCollisionError`'s doc comment now covers both the simple and TOCTOU-rollback cases. `npm test` now 67/67; `npm run build` and the manual scratch-dir CLI run (happy path with id-keyed ledger content, spec-name collision, and a forced ledger-write failure confirming the spec-file rollback) re-verified independently, all pass. 4 lower-priority findings (cross-command concurrency lock, duplicated id-string construction, missing `approve` stub/help-text mismatch, case-insensitive collisions extending to the two-file surface) logged to `deferred-work.md`. `epics.md` annotated with a build note about the Story 1.3 split.

## Design Notes

`id` uses `feat-<date>-<name>` (the literal abbreviation from `docs/architecture.md`'s own example), not `feature-<date>-<name>` — resolves the ambiguity flagged during Story 1.2's review. The task list/ledger both start with exactly one placeholder task (e.g. `t1`, description "Describe the first implementation task here") rather than zero — this makes "ledger created with all tasks pending" concretely true without needing task-list-parsing logic, which stays out of scope per the Never section above.

## Verification

**Commands:**
- `npm test` -- expected: all extended `new-spec.test.ts` cases and CLI tests pass, covering all five I/O matrix rows
- `npm run build && node packages/cli/dist/index.js new-feature demo-feature` (run inside an installed scratch temp directory) -- expected: `specs/features/demo-feature.md` and `tasks/feat-<date>-demo-feature.ledger.yaml` both created, command exits 0

**Manual checks (if no CLI):**
- Inspect the generated ledger by eye to confirm `spec_id` matches the spec's `id` and the one task is `pending` with `linked_commit: null`, `verified_by_gate: false`

## Suggested Review Order

**Feature-spec creation logic**

- Entry point: validation → install check → spec-collision → id-keyed ledger-path collision → spec write → ledger write.
  [`new-spec.ts:251`](../../packages/core/src/new-spec.ts#L251)

- Ledger keyed by the full `id`, matching `docs/architecture.md`'s documented convention.
  [`new-spec.ts:276`](../../packages/core/src/new-spec.ts#L276)

- Any ledger-write failure rolls back the just-written spec file, closing the "orphaned spec, no repair route" gap.
  [`new-spec.ts:300`](../../packages/core/src/new-spec.ts#L300)

- Rollback itself is best-effort so a cleanup failure can never mask the original error.
  [`new-spec.ts:165`](../../packages/core/src/new-spec.ts#L165)

- `isInstalled()` guards `statSync` against non-`ENOENT` failures, shared by both `createPatchSpec` and `createFeatureSpec`.
  [`new-spec.ts:150`](../../packages/core/src/new-spec.ts#L150)

**Templates**

- Feature spec: frontmatter + Requirements/Design/Task List body with one placeholder task.
  [`templates/feature.ts:28`](../../packages/core/src/templates/feature.ts#L28)

- Matching ledger, built via `yaml`'s `stringify()` over a typed object rather than hand-formatted text.
  [`templates/feature-ledger.ts:31`](../../packages/core/src/templates/feature-ledger.ts#L31)

**CLI wiring**

- Thin handler; owns the `waypoint new-feature:` message framing.
  [`new-feature.ts:19`](../../packages/cli/src/commands/new-feature.ts#L19)

- Real command replaces the former stub; `new-system` remains a stub.
  [`program.ts:36`](../../packages/cli/src/program.ts#L36)

**Tests**

- All five I/O matrix rows, the concurrency/TOCTOU case, and the ledger-write-failure rollback test.
  [`new-spec.test.ts:1`](../../packages/core/src/new-spec.test.ts#L1)

- CLI exit-code contract, including the real `createProgram()`/`parseAsync` wiring test and the generic-error fallback.
  [`install.test.ts:1`](../../packages/cli/src/install.test.ts#L1)

**Planning artifacts**

- `epics.md` annotated to record the Story 1.3 split (`new-system` deferred).
  [`epics.md:151`](../planning-artifacts/epics.md#L151)
