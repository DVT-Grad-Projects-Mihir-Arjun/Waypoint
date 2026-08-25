---
title: 'Story 5.1: waypoint status'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_commit: '50805645882ca463e0bf4f33a6f8126d3ee703a4'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-5-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There's no single place to see the state of every open spec — a developer has to hunt across `specs/`, `tasks/*.ledger.yaml`, and `.waypoint/.gate-state/` by hand to answer "what's in progress, what's waiting on approval, what's actually done."

**Approach:** Implement `waypoint status`: a read-only command that enumerates every spec across all three tiers, computes each Feature/System spec's approval and task-completion state (reusing `verify.ts`'s existing tamper-detection hash to distinguish a genuinely `done` task from a `CORRUPTED` one), filters out specs that have fully closed (approved and 100% genuinely done), and prints the rest in a plain-text, terminal-readable list grouped by tier with counts.

## Boundaries & Constraints

**Always:**
- `computeStatus(cwd): Promise<StatusResult>` (new, in `packages/core/src/status.ts`) is the pure, read-only core: it discovers every spec, computes each one's display state, and returns a structured result — it never writes to the ledger, `.gate-state`, or anywhere else, and it never touches git. `packages/cli/src/commands/status.ts` (new) is the thin wrapper that calls it and renders the terminal output.
- Spec discovery reuses the same three-tier directory walk `update-spec.ts`'s `findSpecById` already performs (`specs/patches/*.md`, `specs/features/*.md`, `specs/systems/*/prd.md`), generalized to return every successfully-parsed spec instead of filtering to one id — exported as a new `findAllSpecs(cwd): Promise<FoundSpec[]>` alongside `findSpecById` in `update-spec.ts`, sharing its existing private directory-walk/frontmatter-parsing helpers rather than a second, independently-drifting implementation. A spec file that fails to parse (missing/malformed frontmatter, an invalid `tier`) is silently skipped, exactly as `findSpecById` already tolerates.
- For each Feature/System spec found, `status.ts` reads its matching `tasks/<id>.ledger.yaml` and `.waypoint/.gate-state/<id>.json` itself (a self-contained reader, matching `approve.ts`'s/`done-claim.ts`'s own precedent of not reaching into another module's unexported internals) — but reuses `verify.ts`'s already-exported `computeLedgerTaskHash` for the hash comparison itself, since that's the exact function that wrote the stored hash in the first place.
- Per-task display state is one of `pending`, `in-progress`, `done`, or `CORRUPTED`: a task whose ledger `status` is `'done'` is displayed as `CORRUPTED` (never plain `done`) if its `.gate-state` entry is missing or doesn't match a hash recomputed from its current `{id, status, verified_by_gate, linked_commit}` fields — the identical detection `waypoint verify` itself already performs on an already-`done` task. A ledger that fails to read/parse for a spec that was otherwise found is reported as its own explicit `[LEDGER ERROR]` state for that spec's row, never a crash of the whole command.
- A spec's frontmatter `status` field is the sole "approved" signal, for both Feature and System tier alike (System tier's own `status` already only flips to `'approved'` once every ledger phase is approved, per Story 3.4 — no separate `phase_approvals` inspection needed here).
- **Closing criterion**: a Feature/System spec is excluded from the printed list exactly when its `status` is `'approved'` AND every one of its ledger tasks is displayed as `done` (a `CORRUPTED` task never counts as done for this purpose, even though its raw ledger `status` field may say `'done'`). A Patch-tier spec has no closing criterion at all — every Patch-tier spec found is always included in the list, since patch tier defines no approval or completion concept to close on.
- A Patch-tier row's approval and task-completion fields render as an explicit "not applicable" marker — never a blank space, never an error.
- A Feature/System row whose `status` isn't `'approved'` and has at least one task displayed as `in-progress` gets an explicit flag distinct from an ordinary open row (e.g. a bracketed tag) — this is additive to, not a replacement for, its normal approval/task-completion fields.
- Zero specs to print (either none exist, or every one that exists has closed) prints one explicit, human-readable empty-state line — never blank output.
- Output includes a count by tier (how many open specs of each tier are being shown) in addition to the per-spec list itself.
- No new npm dependency for formatting — plain text only (list format, hand-aligned where useful), matching this codebase's established zero-added-dependency convention. `waypoint status` makes no network call and writes nothing, matching the existing vendor-neutrality test suite's scope (it should be added to that suite's read-only command list).

**Ask First:** none anticipated — the closing criterion, the four-state task display, and the plain-list output shape are each a single coherent reading of the acceptance criteria together, not a multi-way fork.

**Never:**
- Write to a ledger, `.gate-state`, a spec file, or git — `status` is purely a reporter, exactly like `check-drift` and CI's own `gate --ci` checks.
- Treat a `CORRUPTED` task as `done` for any purpose, including the closing criterion.
- Require network access or contact any remote (no `git fetch`/`git pull` to check for others' unpushed work) — this command reflects only what's on disk locally, per its own frozen intent.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Several open specs across tiers | A mix of Patch/Feature/System specs, none fully closed | Each printed with its tier, approval state, and task completion; a tier-count summary is included | N/A |
| Zero open specs | No specs exist, or every one has closed | One explicit empty-state message, never blank output | N/A |
| Patch-tier spec | Any Patch-tier spec | Approval and task-completion fields explicitly "not applicable"; always included (no closing criterion) | N/A |
| Unapproved Feature/System spec with an in-progress task | `status` not `'approved'`, at least one task `in-progress` | Explicitly flagged, distinct from an ordinary open row | N/A |
| A `CORRUPTED` task | A `done`-claimed task whose stored hash is missing or mismatched | Shown with its own distinct indicator, never `done` or `pending` | N/A |
| Fully closed Feature/System spec | `status: approved` and every task genuinely `done` (no `CORRUPTED`) | Excluded from the printed list entirely | N/A |
| A `CORRUPTED` task in an otherwise-`approved`, all-`done`-claiming spec | `status: approved`, every ledger row says `status: done`, one task's hash doesn't match | Spec stays in the open list (the closing criterion isn't met), with that task shown as `CORRUPTED` | N/A |
| Missing/unparseable ledger for a found Feature/System spec | The spec file exists and parses; its ledger doesn't | That spec's row shows an explicit `[LEDGER ERROR]` state; every other spec is still reported normally | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/update-spec.ts` -- add `findAllSpecs(cwd): Promise<FoundSpec[]>`, sharing the existing private directory-walk/frontmatter helpers `findSpecById` already uses
- `packages/core/src/status.ts` (new) -- `computeStatus(cwd): Promise<StatusResult>` and its types; the self-contained ledger/gate-state reader; the closing-criterion filter
- `packages/core/src/index.ts` -- export `findAllSpecs`, `computeStatus`, and `StatusResult`'s public types
- `packages/cli/src/commands/status.ts` (new) -- thin wrapper: calls `computeStatus`, renders the terminal list/counts/empty-state
- `packages/cli/src/program.ts` -- register the `status` command
- `packages/core/src/status.test.ts` (new) -- unit-test every I/O matrix row against `computeStatus`'s structured result
- `packages/cli/src/status.test.ts` (new) -- CLI rendering tests (empty-state message, N/A fields, the explicit flag, tier counts) against real fixtures
- `packages/cli/src/vendor-neutrality.test.ts` (or wherever that suite's read-only command list lives) -- add `status` to its scope, matching `check-drift`'s own precedent

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/update-spec.ts` -- add `findAllSpecs`, reusing existing helpers
- [ ] `packages/core/src/status.ts` -- implement `computeStatus` and its types -- the core mechanism
- [ ] `packages/core/src/index.ts` -- export the new symbols
- [ ] `packages/core/src/status.test.ts` -- unit-test every I/O matrix row
- [ ] `packages/cli/src/commands/status.ts` -- implement the CLI wrapper and terminal rendering
- [ ] `packages/cli/src/program.ts` -- register the `status` command
- [ ] `packages/cli/src/status.test.ts` -- CLI rendering tests
- [ ] `packages/cli/src/vendor-neutrality.test.ts` -- extend its scope to cover `status`

**Acceptance Criteria:**
- Given open specs across the repo, when I run `waypoint status`, then output is readable in a terminal (table or list format) and includes counts by tier
- Given zero open specs, when I run `waypoint status`, then it prints an explicit empty-state message rather than blank output
- Given a Patch-tier spec listed alongside Feature/System specs, when `waypoint status` renders it, then its row shows approval/task-completion fields as not applicable, rather than blank or erroring
- Given a Feature/System spec with unapproved status and in-progress tasks, when I run `waypoint status`, then it flags that spec explicitly
- Given a task flagged `CORRUPTED` per Story 3.3, when I run `waypoint status`, then that task is shown with a distinct corruption indicator, never displayed as plain `done` or `pending`
- Given a Feature/System spec that is fully approved with every task `done`, when I run `waypoint status`, then it is excluded from the "open specs" list -- a spec closes (leaves the open list) exactly when approved and 100% done
- Given `status` reads the local ledger, when it runs, then it reflects only what's on disk locally, with no remote-awareness of anyone else's unpushed `waypoint verify` commits

## Spec Change Log

- 2026-08-25: Implemented per spec. All eight tasks complete; `npm test` (358/358 including 16 new `status.test.ts` core cases and 5 new CLI cases) and `npm run build` both passed. `computeLedgerTaskHash` is reused directly from `verify.ts` with its raw, uncoerced field values — the exact discipline Story 3.3's own review established to avoid a `Boolean("false") === true`-style tamper-detection bypass — and `findAllSpecs` was added alongside `findSpecById` in `update-spec.ts`, reusing its existing private directory-walk/frontmatter helpers rather than a third independently-drifting implementation.

- 2026-08-25: Patch round after 3-lens review (adversarial, edge-case-hunter, verification-gap) run against the diff. Two lenses independently converged on the same path-traversal gap; the rest were confirmed real one by one. Nine findings patched:
  - **Path-traversal risk, confirmed by two lenses: `spec.id` (read straight from a spec file's own frontmatter, with no shape validation) was interpolated directly into the ledger and `.gate-state` path template strings.** Added `isPathUnsafeId` (mirroring `verify.ts`'s own `validatePathSafeIds` rule), checked *before* either path is ever built; a path-unsafe id is now reported as `[LEDGER ERROR]` instead. Added a test that doesn't just check the guard's return value but actually proves the traversal would have worked absent the fix — placing a real, valid decoy ledger at the resolved-outside-`cwd` path the unguarded code would have read, then confirming the fixed code never reads it.
  - **Crash risk: a `null`/non-object task row in a ledger threw a `TypeError` that crashed the entire `computeStatus()` call**, losing every other spec's status too. Fixed by guarding the per-task loop against non-object entries (reported as an honest, minimal placeholder rather than dereferenced) and a missing/non-string task `id` (falls back to `'?'` rather than the confusing literal `"undefined"`).
  - **An approved spec with a zero-task ledger was vacuously treated as fully closed and silently excluded from the report** — the one anomaly-detection tool this story exists to provide would have missed exactly the kind of corruption (every task hand-deleted) it should catch. Fixed the closing criterion to require at least one task, matching how a `[LEDGER ERROR]` spec is already never closeable.
  - **`statusCommand`'s own doc comment claimed a try/catch pattern that didn't actually exist in the code.** Added the real try/catch, matching `check-drift.ts`'s established shape, so the doc comment is now accurate.
  - **No exit-code signal when the result contains a `CORRUPTED` task or a `[LEDGER ERROR]` spec** — any CI/script use of `waypoint status` to gate on integrity would always see exit 0 regardless of tampering. Added `process.exitCode = 1` specifically for those two anomaly cases; an ordinary open/unapproved spec (expected, everyday state) still leaves the exit code untouched.
  - **Entry order was whatever the filesystem's `readdir` happened to return, not deterministic.** `computeStatus` now sorts `entries` by `id` before returning.
  - **The single most safety-relevant signal (`CORRUPTED`) had no distinct visual marker, unlike the existing `[UNAPPROVED, IN PROGRESS]` flag** — buried as plain text inside an ordinary-looking count. Added a parallel `[CORRUPTED]` bracketed tag.
  - **Verification-gap, confirmed: no test exercised the real Commander/argv-parsing wiring for `status`**, unlike every other command in this codebase. Added a `createProgram()` + `parseAsync(['status'], ...)` test.
  - **Verification-gap, confirmed: the CLI's `CORRUPTED`-count and `[LEDGER ERROR]` renderings were both untested at the `statusCommand` boundary** — `status.ts`'s own data was well-tested, but a regression in how the CLI actually renders either case would have shipped undetected. Added both.
  - Deferred to `deferred-work.md`: `findAllSpecs` having no duplicate-id detection (matches Story 3.3's own already-accepted precedent for the identical concern); redundant per-task `.gate-state` re-reads and no batching across `computeStatus`'s reads (no AC-mandated perf budget, negligible at MVP scale); `SpecStatusEntry` not being a true discriminated union (a speculative type-purity improvement with no demonstrated bug, and this is the final MVP story).
  - Rejected: cross-checking `approved_by`/`approved_at`/`phase_approvals` against a hand-edited `status: approved` — would add zero real defense, since all three live in the same hand-editable YAML with no cryptographic backing the way `.gate-state`'s hash has for task completion. Matches the identical reasoning already applied this session to reject a parallel finding on Story 3.5's `checkDoneClaims`.
  - Re-verified after every fix: `npm test` (23 test files, 391 tests, 0 failures), `npm run build` (clean). I independently read every changed file against each of the nine patches, and specifically confirmed the path-traversal test genuinely proves the vulnerability rather than just exercising the guard function in isolation, before accepting the implementation.

## Design Notes

This is the last story in the entire MVP roadmap (`epics.md`'s Epic List ends at Epic 5) — no future story depends on anything this one introduces, so nothing here is deliberately left half-built for a later pass.

`findAllSpecs` was added to `update-spec.ts` (rather than duplicating a third directory-walk in `status.ts`) specifically because `findSpecById`'s walk is already the exact enumeration this story needs, just unfiltered — the same reasoning `approve.ts`/`done-claim.ts` used to justify writing their *own* self-contained ledger readers doesn't apply here, since spec discovery (unlike ledger reading) has no meaningfully different shape between callers.

The closing criterion treats a `CORRUPTED` task as never counting toward "done," even when hand-editing a spec to `status: approved` with every ledger row already claiming `status: done` would otherwise make it look closed — this is deliberate: the whole point of the corruption signal (Story 3.3) is that a ledger's own claim of doneness can't always be trusted, and a status report that let a corrupted spec quietly disappear from view would be the one place that guarantee actually matters for a human glancing at the list.

## Suggested Review Order

**The core mechanism**

- `computeStatus` — entry point; the closing criterion (line ~356) is the load-bearing safety property this whole story exists to get right.
  [`status.ts:266`](../../packages/core/src/status.ts#L266)

- `computeTaskDisplayState` — the CORRUPTED-detection reuse of `verify.ts`'s hashing function with raw, uncoerced field values.
  [`status.ts:209`](../../packages/core/src/status.ts#L209)

**The load-bearing fix from this round's review**

- `isPathUnsafeId` and its call site — the path-traversal guard, checked before either the ledger or `.gate-state` path is ever built.
  [`status.ts:108`](../../packages/core/src/status.ts#L108)

- The test that proves the traversal would have worked absent the fix, not just that the guard function returns the right boolean.
  [`status.test.ts:348`](../../packages/core/src/status.test.ts#L348)

**CLI wiring and this round's other fixes**

- `statusCommand`'s try/catch and `hasAnomaly`'s exit-code logic.
  [`status.ts:22`](../../packages/cli/src/commands/status.ts#L22) / [`status.ts:69`](../../packages/cli/src/commands/status.ts#L69)

- `renderEntryLine`'s new `[CORRUPTED]` marker.
  [`status.ts:98`](../../packages/cli/src/commands/status.ts#L98)

- The malformed-task-row crash-prevention tests, and the real Commander wiring test closing verification-gap's finding.
  [`status.test.ts:401`](../../packages/core/src/status.test.ts#L401) (core) / [`status.test.ts:253`](../../packages/cli/src/status.test.ts#L253) (CLI wiring)

## Verification

**Commands:**
- `npm test` -- expected: all new `status.test.ts` cases (core + CLI) pass, covering every I/O matrix row
- `npm run build` -- expected: clean

**Manual checks (if no CLI):**
- In a real scratch repo: `waypoint install`, create one spec at each tier, run `waypoint status` -- confirm all three appear with correct N/A/approval/task fields and tier counts. Approve and fully verify a Feature spec's only task, run `waypoint status` again -- confirm it disappears from the list. Hand-edit a `done` task's `linked_commit` on a different spec, run `waypoint status` -- confirm that task shows as `CORRUPTED` and the spec stays listed even if its `status` says `approved`.
