---
title: 'Story 1.3: System-tier spec scaffolding'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: '73228e6f174925119d59674f81b8ed12179efcb6'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.3 split `new-feature` (built) from `new-system` (deferred, per `deferred-work.md`) since System tier needs a materially different multi-file spec-set, not a single file plus a flat ledger.

**Approach:** Implement `waypoint new-system <name>`: write a spec set at `specs/systems/<name>/` (`prd.md`, `architecture.md`, `adr.md` — matching `docs/architecture.md`'s own `templates/system/` naming) plus a matching phased task ledger. Because System's own output is a directory, not a `<name>.md` file, the cross-tier collision check shared by `new-patch`/`new-feature` must become tier-shape-aware so a system-tier name is still correctly detected as colliding.

## Boundaries & Constraints

**Always:**
- Error clearly, before touching the filesystem, if `.waypoint/config.yaml` doesn't exist or isn't a file — reuse `WaypointNotInstalledError`.
- Validate `<name>` with the same rule as `new-patch`/`new-feature` — reuse `isValidName`.
- Refactor the shared cross-tier collision check into a tier-shape-aware helper: `patches`/`features` check `specs/<tier>/<name>.md` as a file (unchanged behavior); `systems` checks `specs/systems/<name>` as a directory-or-file. All three of `createPatchSpec`/`createFeatureSpec`/`createSystemSpec` use this one helper; `patch`/`feature`'s own observable collision behavior for their own tiers must not change.
- Also check `tasks/<id>.ledger.yaml` (`id` = `system-<date>-<name>`) for collision, same as `new-feature`.
- Write exactly four files, only after both collision checks pass: `specs/systems/<name>/prd.md` (frontmatter `id: system-<date>-<name>`, `tier: system`, `status: draft`, `approved_by: null`, `approved_at: null`, `created_at`; body has a `## Requirements` section plus two phase sections, `## Phase 1` and `## Phase 2`, each with exactly one placeholder task), `specs/systems/<name>/architecture.md` (architecture stub, no frontmatter), `specs/systems/<name>/adr.md` (one ADR stub, no frontmatter), and `tasks/<id>.ledger.yaml` (`spec_id` matching `prd.md`'s `id`; two task entries, one per phase, each `status: pending`, `linked_commit: null`, `verified_by_gate: false`).
- No partial writes survive any failure: if any of the four writes fails after an earlier one succeeded, roll back everything written by this call (the whole `specs/systems/<name>/` directory, and the ledger file if it was reached) before erroring — same "neither/none written" contract `new-feature` already guarantees for its two files.
- No network calls, no confirmation prompts.

**Ask First:** none anticipated — the file set, id prefix, and rollback contract are fully specified above.

**Never:**
- Change `createPatchSpec`'s or `createFeatureSpec`'s own write logic, error types, or file-shape behavior for their own tiers — only the shared collision-check helper's `systems`-tier branch is new.
- Parse or sync a human-edited task list into ledger rows, or implement any per-phase approval mechanism — `waypoint update`'s delta-sync and `waypoint approve`'s phase-approval design are both out of bounds here (Epics 2/3).
- Touch `waypoint verify`/`approve`, gate/hook logic, or CI (Epic 3's scope).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Not installed | `.waypoint/config.yaml` missing | Errors, tells user to run `waypoint install` first | Clear message, no filesystem write |
| Happy path | Installed repo, valid unused `<name>` | `specs/systems/<name>/{prd.md,architecture.md,adr.md}` and `tasks/<id>.ledger.yaml` (2 phased, pending tasks) all created | N/A |
| Spec-name collision (any tier) | `<name>` already exists at any tier (file for patch/feature, directory for system) | Errors, nothing written | Clear message naming the colliding path |
| Ledger-name collision | Spec-set path free but `tasks/<id>.ledger.yaml` already exists | Errors, nothing written (any already-written spec-set files rolled back) | Clear message naming the colliding ledger path |
| Invalid name | `<name>` empty, missing, too long, or has path-traversal/invalid characters | Errors before any filesystem check | Clear validation message |
| Mid-write failure | One of the four writes fails after an earlier one already succeeded | Nothing from this call survives — full rollback | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/new-spec.ts` (extend) -- refactor the inline `SPEC_TIERS` collision loop (`packages/core/src/new-spec.ts:265` in `createFeatureSpec`, mirrored in `createPatchSpec`) into a shared `specTierCollisionPath(cwd, tier, name)` helper; add `createSystemSpec(cwd, name)` reusing `isValidName`/`todayIsoDate`/`isInstalled`/`rollbackSpecFile`-style cleanup
- `packages/core/src/templates/system.ts` (new) -- `renderSystemPrd(name, createdAt)`, `renderSystemArchitectureStub()`, `renderSystemAdrStub()`; mirrors `templates/feature.ts`'s pattern
- `packages/core/src/templates/system-ledger.ts` (new) -- `renderSystemLedgerYaml(specId, phase1Task, phase2Task)` via `yaml`'s `stringify()`, mirrors `templates/feature-ledger.ts:31`
- `packages/core/src/index.ts` -- export `createSystemSpec` and the new template functions alongside the existing exports (`packages/core/src/index.ts:14`)
- `packages/cli/src/commands/new-system.ts` (new) -- thin handler mirroring `new-feature.ts`'s try/catch → clean exit-code pattern (`packages/cli/src/commands/new-feature.ts:19`)
- `packages/cli/src/program.ts` -- replace the `new-system` stub registration with a real command
- `packages/core/src/new-spec.test.ts` (extend) -- unit-test all six I/O matrix rows for `createSystemSpec`, plus a regression test confirming `createPatchSpec`/`createFeatureSpec`'s refactored collision check still behaves identically for their own tiers
- `packages/cli/src/install.test.ts` (extend) -- add the `new-system` exit-code contract

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/new-spec.ts` -- refactor the shared collision-check loop into `specTierCollisionPath` (no behavior change for patch/feature) -- prerequisite for correct system-tier collision detection
- [x] `packages/core/src/templates/system.ts` -- write the three render functions -- single source of truth for the spec-set's content
- [x] `packages/core/src/templates/system-ledger.ts` -- write the phased-ledger renderer -- single source of truth for the matching ledger's shape
- [x] `packages/core/src/new-spec.ts` -- implement `createSystemSpec`: install-check, name validation, spec-set + ledger collision checks, four-file write with full rollback on any failure -- the actual behavior under test
- [x] `packages/core/src/index.ts` -- export `createSystemSpec` and the new template functions
- [x] `packages/cli/src/commands/new-system.ts` + `packages/cli/src/program.ts` -- wire `waypoint new-system <name>` to `createSystemSpec`, replacing the existing stub
- [x] `packages/core/src/new-spec.test.ts` -- unit-test all six I/O matrix rows, plus the patch/feature collision-check regression test
- [x] `packages/cli/src/install.test.ts` -- extend with the exit-code contract for `new-system`'s error paths

**Acceptance Criteria:**
- Given the created system spec set, when `prd.md`'s frontmatter is inspected, then `status` is `draft` and `tier` is `system`
- Given the matching ledger file, when inspected, then its `spec_id` matches `prd.md`'s `id` and both tasks are `pending` with distinct phase numbers
- Given a `new-patch`/`new-feature` call using a name that collides with an existing system-tier spec directory, when it runs, then it errors the same way any other cross-tier collision does

## Spec Change Log

- 2026-08-21: Implemented per spec. All eight tasks complete; `npm test` (102/102, including the full `createSystemSpec` matrix and the patch/feature collision-check regression test) and the manual scratch-dir CLI run both pass. All six I/O matrix rows and all three acceptance criteria independently re-verified: not-installed, happy path (correct spec-set content and phased ledger), spec-name collision, ledger-name collision with full directory rollback, invalid/path-traversal name, and — critically — `new-patch`/`new-feature` both correctly detect a collision against an existing system-tier directory (confirming the shared `specTierCollisionPath` refactor works bidirectionally without changing patch/feature's own-tier file-based collision behavior, also independently regression-checked). No boundary/constraint deviations.
- 2026-08-21: Code review found 5 patch-level issues, all fixed: `architecture.md`/`adr.md` now write exclusive-create (`'wx'`) like `prd.md`/the ledger, closing a silent-overwrite gap; `prd.md`'s own write now rolls back the empty `specDir` on a non-`EEXIST` failure (previously left it orphaned, permanently blocking every retry of that name) — scoped to the non-`EEXIST` branch only, since the implementer caught that an unconditional rollback would delete a concurrent winner's just-written files and break the existing same-name-race test; two new tests inject a targeted `writeFile` failure (via a scoped passthrough mock) to exercise both rollback paths directly, since any real pre-seeded file at those paths is already caught by the earlier collision check before either write is reached; the CLI success message now names `prd.md`/`architecture.md`/`adr.md` individually instead of just the parent directory. `npm test` now 104/104; `npm run build`, the manual scratch-dir CLI run, and the concurrent-same-name race were all re-verified independently, all pass. 3 lower-priority findings (help-text overstating "phased approval" with no `approve` command yet, case-insensitive collisions extending to the directory-based system-tier check, and further consolidating the still-triplicated validate/install/collision-check sequence) logged to `deferred-work.md`.

## Design Notes

`id` uses the full tier word `system-<date>-<name>`, not an abbreviation — unlike `feat-`, `docs/architecture.md` gives no documented abbreviation for System tier, so inventing one risks the exact "which abbreviation" ambiguity Story 1.2's review flagged for `feat-`/`feature-`. File names (`prd.md`/`architecture.md`/`adr.md`, one `adr.md` not numbered stubs) match `docs/architecture.md`'s own `templates/system/` source-tree listing exactly. Two phases (not one) make "phased tasks" concretely distinguishable from Feature tier's single approval gate; the actual per-phase `waypoint approve` mechanism is Epic 3's scope, not this story's — `prd.md` gets the same single `approved_by`/`approved_at: null` pair as Feature tier, since nothing has been approved yet regardless of tier.

## Verification

**Commands:**
- `npm test` -- expected: all extended `new-spec.test.ts` cases and CLI tests pass, covering all six I/O matrix rows plus the patch/feature regression check
- `npm run build && node packages/cli/dist/index.js new-system demo-system` (installed scratch temp directory) -- expected: `specs/systems/demo-system/{prd.md,architecture.md,adr.md}` and `tasks/system-<date>-demo-system.ledger.yaml` all created, command exits 0

**Manual checks (if no CLI):**
- Inspect the generated ledger by eye to confirm two tasks, one per phase, both `pending`
- Run `waypoint new-patch demo-system` (or `new-feature`) against the same repo afterward and confirm it errors on the collision instead of ignoring the system-tier directory

## Suggested Review Order

**Shared collision-check refactor**

- The tier-shape-aware helper: file path for patch/feature, directory-or-file path for system.
  [`new-spec.ts:181`](../../packages/core/src/new-spec.ts#L181)

**System-tier creation logic**

- Entry point: validation → install check → cross-tier collision → ledger collision → four-file write, each step's rollback scoped to exactly the failure it must undo.
  [`new-spec.ts:411`](../../packages/core/src/new-spec.ts#L411)

- `prd.md`'s exclusive write is the real concurrency guard (not `mkdir`, which is idempotent); its rollback is deliberately scoped to non-`EEXIST` only so a race winner's files are never deleted.
  [`new-spec.ts:458`](../../packages/core/src/new-spec.ts#L458)

- `architecture.md`/`adr.md` now both exclusive-create, closing the silent-overwrite gap the review caught.
  [`new-spec.ts:473`](../../packages/core/src/new-spec.ts#L473)

- Best-effort whole-directory rollback, shared by every failure branch after `prd.md` succeeds.
  [`new-spec.ts:225`](../../packages/core/src/new-spec.ts#L225)

**Templates**

- Spec-set content: frontmatter, two phase sections, one placeholder task each.
  [`templates/system.ts:44`](../../packages/core/src/templates/system.ts#L44)

- Matching phased ledger, with the extra `phase` field feature-tier's ledger doesn't have.
  [`templates/system-ledger.ts:36`](../../packages/core/src/templates/system-ledger.ts#L36)

**CLI wiring**

- Thin handler; success message now names all three spec-set files individually.
  [`new-system.ts:19`](../../packages/cli/src/commands/new-system.ts#L19)

**Tests**

- Full `createSystemSpec` matrix plus the two targeted-mock rollback tests and the patch/feature regression check.
  [`new-spec.test.ts:1`](../../packages/core/src/new-spec.test.ts#L1)

- CLI exit-code contract and the real `createProgram()`/`parseAsync` wiring test.
  [`install.test.ts:1`](../../packages/cli/src/install.test.ts#L1)
