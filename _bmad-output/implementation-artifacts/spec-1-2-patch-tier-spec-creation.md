---
title: 'Story 1.2: Patch-tier spec creation'
type: 'feature'
created: '2026-08-20'
status: 'done'
baseline_commit: 'cb714e126a3a853b464555cf164a78f6b870759a'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Waypoint can scaffold a repo (Story 1.1) but has no way yet to record a trivial change as a spec — there is no `new-patch` command, so the lowest-ceremony tier has nowhere to leave a lightweight record before committing.

**Approach:** Implement `waypoint new-patch <name>`: validate the name, confirm the repo is installed and `<name>` doesn't collide with an existing spec at any tier, then write a single minimal markdown file under `specs/patches/` with YAML frontmatter and no task-ledger or approval fields.

## Boundaries & Constraints

**Always:**
- Error clearly, before touching the filesystem, if `.waypoint/config.yaml` doesn't exist (repo not installed) — tell the user to run `waypoint install` first.
- Validate `<name>`: reject empty/missing, and reject any value containing `/`, `\`, `..`, or characters outside `[a-zA-Z0-9_-]` — with a clear validation message, before any filesystem check or write.
- Check `<name>` for collision against all three tiers (`specs/patches/<name>.md`, `specs/features/<name>.md`, `specs/systems/<name>.md`) — if any already exists, error without overwriting.
- Write exactly one file, `specs/patches/<name>.md`, with YAML frontmatter (`id`, `tier: patch`, `status: draft`, `created_at`) and no `approved_by`/`approved_at`/ledger reference — patch tier has no approval step.
- Complete in well under the ~30s budget (NFR2) — no network calls, no confirmation prompts.

**Ask First:** none anticipated — naming/validation rules are fully specified above.

**Never:**
- Create or touch a task ledger file (`tasks/*.ledger.yaml`) — patch tier has none (that's Story 1.3's `new-feature`/`new-system` scope).
- Touch `waypoint approve`, gate/hook logic, or CI (Epic 3's scope).
- Implement `new-feature`/`new-system` (Story 1.3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Not installed | `.waypoint/config.yaml` missing | Errors, tells user to run `waypoint install` first | Clear message, no filesystem write |
| Happy path | Installed repo, valid unused `<name>` | `specs/patches/<name>.md` created with patch frontmatter, no ledger/approval fields | N/A |
| Name collision | `<name>` already exists at any tier | Errors, no overwrite | Clear message naming the colliding path |
| Invalid name | `<name>` empty, missing, or has path-traversal/invalid characters | Errors before any filesystem check | Clear validation message |

</frozen-after-approval>

## Code Map

- `packages/core/src/templates/patch.ts` (new) -- `renderPatchSpec(name, createdAt)` returning frontmatter + minimal body, same embedded-string pattern as `renderConfigYaml()` in `packages/core/src/config-defaults.ts:1` — avoids npm-packaging a separate `templates/patch.md` file
- `packages/core/src/new-spec.ts` (new) -- validate name, check the install marker (`.waypoint/config.yaml`) and cross-tier collision, write the patch spec file; exported as `createPatchSpec(cwd, name)`
- `packages/core/src/index.ts` -- export `createPatchSpec` and its error type(s), alongside the existing `scaffold`/`ensureGitignoreEntry` exports (`packages/core/src/index.ts:1`)
- `packages/cli/src/commands/new-patch.ts` (new) -- thin command handler mirroring `install.ts`'s try/catch → clean exit-code pattern (`packages/cli/src/commands/install.ts:8`)
- `packages/cli/src/program.ts` -- replace the `new-patch` stub registration (`packages/cli/src/program.ts:30`) with a real command taking `<name>`
- `packages/core/src/new-spec.test.ts` (new) -- unit-test all four I/O matrix rows against a temp-dir fixture, same `mkdtempSync`/`afterEach rmSync` pattern as `scaffold.test.ts:9`
- `packages/cli/src/install.test.ts` (extend) -- add the `new-patch` exit-code contract alongside the existing `install`/stub-command tests

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/templates/patch.ts` -- write `renderPatchSpec(name, createdAt)` -- single source of truth for the patch frontmatter + body shape
- [x] `packages/core/src/new-spec.ts` -- implement install-check, name validation, cross-tier collision check, and the write -- the actual behavior under test in the I/O matrix
- [x] `packages/core/src/index.ts` -- export `createPatchSpec` and its error type(s)
- [x] `packages/cli/src/commands/new-patch.ts` + `packages/cli/src/program.ts` -- wire `waypoint new-patch <name>` to `createPatchSpec`, replacing the existing stub
- [x] `packages/core/src/new-spec.test.ts` -- unit-test all four I/O matrix rows
- [x] `packages/cli/src/install.test.ts` -- extend with the exit-code contract for `new-patch`'s error paths

**Acceptance Criteria:**
- Given the created patch spec, when it is inspected, then no task-ledger file exists for it and no ledger reference appears in its frontmatter
- Given the command completes on a reference machine, when its runtime is measured, then it finishes in well under 30 seconds

## Spec Change Log

- 2026-08-20: Implemented per spec. All six tasks complete; `npm test` (33/33, including 16 new `new-spec.test.ts` cases and 4 new CLI cases in `install.test.ts`) and the manual scratch-dir CLI run both pass. All four I/O matrix rows and both acceptance criteria independently re-verified (not-installed, happy path, cross-tier collision, invalid/path-traversal name; no ledger file created; 0.175s runtime, well under the 30s NFR2 budget). No boundary/constraint deviations.
- 2026-08-20: Code review (blind-hunter, edge-case-hunter, verification-gap) found 9 patch-level issues, all fixed: closed a TOCTOU race between the cross-tier collision check and the write (exclusive-create `'wx'` flag, with `EEXIST` mapped to `SpecNameCollisionError`); made `@waypoint/core`'s three error messages command-agnostic (no more hardcoded `waypoint new-patch:`, now framed at the CLI layer) so they're safely reusable by Story 1.3; added a 100-character max-length check on `<name>`; switched `created_at`/`id` date computation from UTC to local calendar date; the CLI success message now logs a `cwd`-relative path instead of absolute; a directory sitting at `.waypoint/config.yaml`'s path is now treated the same as "not installed"; strengthened collision/invalid-name test assertions to check message content, not just error type; added a test for the CLI's generic (non-domain) error path; added a test asserting the success-path console output content. `npm test` now 39/39; `npm run build` and the manual scratch-dir CLI run (happy path with relative-path output, concurrent same-name race, over-length name, directory-at-config-path) re-verified independently, all pass. 2 lower-priority findings (case-insensitive filesystem collisions, Windows-reserved device names) logged to `deferred-work.md` rather than fixed now, since both need a deliberate naming-policy decision rather than a mechanical fix.

## Design Notes

`id` follows `docs/architecture.md`'s `<tier>-<date>-<name>` convention (e.g. `patch-2026-08-20-fix-typo`), computed at write time from the real system clock — normal runtime behavior, distinct from this BMAD workflow's own restriction on `Date.now()`/`new Date()` in workflow scripts. Name validation regex: `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` — rejects empty, path separators, `..`, dotfiles, and anything else likely to escape `specs/patches/`.

## Verification

**Commands:**
- `npm test` -- expected: all `new-spec.test.ts` cases and the extended CLI tests pass, covering all four I/O matrix rows
- `npm run build && node packages/cli/dist/index.js new-patch demo-change` (run inside an installed scratch temp directory) -- expected: `specs/patches/demo-change.md` created with patch frontmatter, command exits 0

**Manual checks (if no CLI):**
- Inspect the generated `specs/patches/<name>.md` by eye to confirm no `approved_by`/`approved_at`/ledger reference appear

## Suggested Review Order

**Patch-spec creation logic**

- Entry point: validation → install check → cross-tier collision check → exclusive-create write, in that order.
  [`new-spec.ts:118`](../../packages/core/src/new-spec.ts#L118)

- Exclusive-create (`'wx'`) write closes the TOCTOU race between the collision check and the write itself.
  [`new-spec.ts:146`](../../packages/core/src/new-spec.ts#L146)

- Name validation: regex plus a length cap, rejecting before any filesystem access.
  [`new-spec.ts:80`](../../packages/core/src/new-spec.ts#L80)

- Local-calendar-date computation, deliberately not UTC, for `created_at`/`id`.
  [`new-spec.ts:94`](../../packages/core/src/new-spec.ts#L94)

- Install check also rejects a directory sitting at `.waypoint/config.yaml`'s path.
  [`new-spec.ts:126`](../../packages/core/src/new-spec.ts#L126)

- Error types are deliberately command-agnostic so Story 1.3 can reuse them.
  [`new-spec.ts:16`](../../packages/core/src/new-spec.ts#L16)

**Template**

- Single source of truth for patch frontmatter + body; no approval/ledger fields.
  [`templates/patch.ts:11`](../../packages/core/src/templates/patch.ts#L11)

**CLI wiring**

- Thin handler; owns the `waypoint new-patch:` message framing and reports a `cwd`-relative path.
  [`new-patch.ts:19`](../../packages/cli/src/commands/new-patch.ts#L19)

- Real command replaces the former stub registration.
  [`program.ts:29`](../../packages/cli/src/program.ts#L29)

**Tests**

- All four I/O matrix rows plus the TOCTOU race, length cap, and directory-at-config-path edge cases.
  [`new-spec.test.ts:1`](../../packages/core/src/new-spec.test.ts#L1)

- CLI exit-code contract, including the generic non-domain error path and success-output content.
  [`install.test.ts:1`](../../packages/cli/src/install.test.ts#L1)
