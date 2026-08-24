---
title: 'Story 3.3: Task ledger with verify-only completion'
type: 'feature'
created: '2026-08-24'
status: 'done'
baseline_commit: '8eda625f4ed7b0ed9f11d9f01cd1cbd2e193331e'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing yet stops a task's `linked_commit`/`status: done`/`verified_by_gate` from being hand-edited — an agent could self-report completion with no mechanical check.

**Approach:** Implement `waypoint verify <spec-id> <task-id>`: runs `check_command` in the working tree, and only on success writes those three fields as one atomic update, commits *only* the ledger file, and stores a per-task integrity hash (`.waypoint/.gate-state/<spec-id>.json`, gitignored) that flags any later hand-edit as corrupted rather than trusting it.

## Boundaries & Constraints

**Always:**
- `runCheck(input: { checkCommand: string }): { ok: boolean }` runs `checkCommand` via `execSync(checkCommand, { cwd: repoRoot, stdio: 'inherit' })` (shell semantics needed — `check_command` can be a pipeline, e.g. `npm test && npm run lint`) in the current working tree, live output visible (matches "blocks the same way running the suite manually would"). A thrown/non-zero exit → `{ ok: false }`; success → `{ ok: true }`. Read `check_command` from `.waypoint/config.yaml`; if the file is missing/empty/unparseable or `check_command` isn't a non-empty string, that is its own clear error (distinct from a failing check) naming `.waypoint/config.yaml`.
- Resolve the ledger at `tasks/<spec-id>.ledger.yaml`; if it doesn't exist, or `<task-id>` isn't among its `tasks`, error naming the missing target — never silently no-op.
- Resolve current `HEAD` via `git rev-parse HEAD` *before* anything else; if it fails (no commits yet), error clearly — never write a null/invalid `linked_commit`.
- If the target task's `status` is already `'done'`: recompute `sha256(JSON.stringify({ id, status, verified_by_gate, linked_commit }, ['id', 'status', 'verified_by_gate', 'linked_commit']))` from the ledger's current values for that task and compare it to the stored hash in `.waypoint/.gate-state/<spec-id>.json`. Match → no-op (report already-verified, write nothing). Missing or mismatched → report `CORRUPTED` naming the task, write nothing, never silently re-verify or overwrite.
- Otherwise (not yet `done`): call `runCheck()`. Failure → report it, write nothing. Success → capture the ledger file's original raw content (for rollback), update the task's three fields in memory (`linked_commit` = the `HEAD` resolved above, `status: 'done'`, `verified_by_gate: true`), serialize and write the updated ledger, `git add <ledgerPath>`, then `git commit --only <ledgerPath> -m 'chore(waypoint): verify <task-id>'` — `git add` first is required even for an already-tracked file: `--only` alone fails outright ("pathspec did not match any file(s) known to git") for a ledger that was never committed before, confirmed by direct testing; `add` then `--only` handles both the never-committed and already-tracked-and-modified cases identically, and still leaves any other already-staged file's own staged changes completely untouched (also confirmed by direct testing).
- On any failure from the ledger write through the commit step: restore the ledger file to its captured original content, best-effort `git reset -- <ledgerPath>` to undo the `add` (never let a stray staged diff survive a failed verify), and report the failure. The gate-state hash is computed and merge-written *only after* the commit succeeds — never before, so a crash between the two steps can't leave an orphaned hash for a commit that never landed.
- `.waypoint/.gate-state/<spec-id>.json` writes are per-task merges (read existing file if present, merge in this task's new hash, write the whole merged object back) — never a whole-file replace that would erase another task's stored hash. Guard every read-merge-write with an exclusive lock (export and reuse `scaffold.ts`'s existing `acquireLock`/`releaseLock` mkdir-based helpers, called against a distinct lock path so it never contends with `waypoint install`'s own lock) so concurrent `verify` calls against the same or sibling tasks in one spec serialize instead of corrupting the file.
- CLI: `waypoint verify <spec-id> <task-id>`, registered in `program.ts` alongside the other subcommands. Map each outcome to a clear `waypoint verify: ...` message and the right exit code (`0` for verified or already-verified, `1` for every other outcome — check-failed, commit-failed-and-rolled-back, not-found, no-`HEAD`, corrupted).

**Ask First:** none anticipated — the mechanism is fully specified above; the `git add`-then-`--only` git-mechanics finding was resolved by direct empirical testing during planning, not a judgment call.

**Never:**
- Add a `--no-verify` bypass to `verify`'s own commit — it must pass the same pre-commit hook every other commit does, relying on `tasks/**`'s existing patch-tier classification (Story 1.1) to never be blocked by Story 3.2's gate.
- Implement CI's ancestor-check ("done-claim correctness") — Story 3.5's job, reusing this ledger schema unchanged.
- Implement `waypoint status` or any repo-wide ledger view — Epic 5's job; this story's corruption detection surfaces only through `waypoint verify`'s own output for the task it targets.
- Re-derive `.waypoint/config.yaml` loading from scratch for `check_command` — write a small, self-contained reader (this story only needs one field, not `gate-classify.ts`'s four-distinct-message `tiers.patch` validation) rather than importing/coupling to that unrelated function.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Successful verify | Task pending/in-progress, `check_command` passes | Ledger updated + committed (isolated staging), hash stored, exit 0 | N/A |
| Check fails | `check_command` exits non-zero | Reports failure, writes nothing, exit 1 | N/A |
| Commit step fails | Ledger write succeeds but the commit fails for any reason | Ledger content and git index rolled back to original, `.gate-state` untouched, exit 1 | N/A |
| No commits yet | `git rev-parse HEAD` fails | Errors clearly, writes nothing | N/A |
| Unknown spec-id or task-id | Ledger or task not found | Errors naming the missing target | N/A |
| Already done, valid hash | `status: done`, stored hash matches | No-op, reports already-verified, exit 0 | N/A |
| Already done, missing/mismatched hash | `status: done`, no stored hash or hash mismatch | Reports `CORRUPTED` naming the task, writes nothing, exit 1 | N/A |
| Concurrent verify, same/sibling tasks | Two `verify` calls race on one spec's ledger + gate-state | Serialized via lock — neither corrupts either file | N/A |
| Multiple tasks' hashes | A spec with several previously-verified tasks | Writing a new task's hash preserves every other task's stored hash | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/scaffold.ts` -- export `acquireLock`/`releaseLock` (currently private, ~lines 161-195) for reuse with a distinct lock path
- `packages/core/src/config-defaults.ts` -- `WaypointConfig.check_command` (line 15) is the field to read; no changes needed here
- `packages/core/src/templates/feature-ledger.ts` / `system-ledger.ts` -- existing `FeatureLedgerTask`/`SystemLedgerTask` shapes (both carry `id`, `status`, `linked_commit`, `verified_by_gate`; System additionally carries `phase`) — read/write generically against `{ spec_id: string; tasks: Record<string, unknown>[] }` so this module works for both without needing to know about `phase`
- `packages/core/src/new-spec.ts` -- `rollbackSpecFile` (~line 211) is the best-effort, swallow-your-own-failure rollback pattern to mirror for restoring the ledger's original content on a failed commit
- `packages/core/src/verify.ts` (new) -- `runCheck`, the hash helper, the lock-guarded gate-state merge-write, and `verifyTask(repoRoot, specId, taskId): Promise<VerifyResult>` (a discriminated union: `verified` / `already-verified` / `check-failed` / `commit-failed` / `not-found` / `no-head` / `corrupted`)
- `packages/core/src/index.ts` -- export `verifyTask` and its result type, following the existing barrel pattern
- `packages/core/src/verify.test.ts` (new) -- unit-test all nine I/O matrix rows against real temp-dir + real git fixtures (this mechanism is git-native end to end, unlike Story 3.1/3.2's pure functions — no meaningful way to test it without a real repo)
- `packages/cli/src/commands/verify.ts` (new) -- thin CLI wrapper: parse `<spec-id> <task-id>`, call `verifyTask`, map the result to a message + exit code
- `packages/cli/src/program.ts` -- register `verify <spec-id> <task-id>`
- `packages/cli/src/verify.test.ts` (new) -- CLI wiring/exit-code tests

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/scaffold.ts` -- export `acquireLock`/`releaseLock` -- lets `verify` reuse the established lock mechanism instead of a second implementation
- [x] `packages/core/src/verify.ts` -- implement `runCheck`, the hash helper, the lock-guarded gate-state merge-write, and `verifyTask` -- the core mechanism
- [x] `packages/core/src/index.ts` -- export `verifyTask` and its types
- [x] `packages/core/src/verify.test.ts` -- unit-test all nine I/O matrix rows against real git fixtures
- [x] `packages/cli/src/commands/verify.ts` -- implement the CLI wrapper
- [x] `packages/cli/src/program.ts` -- register the `verify` subcommand
- [x] `packages/cli/src/verify.test.ts` -- CLI wiring/exit-code tests

**Acceptance Criteria:**
- Given a real git repo with an installed ledger and a passing `check_command`, when `waypoint verify <spec-id> <task-id>` runs end to end (not a mocked check), then a real commit lands containing only the ledger file, and re-running the same command is a genuine no-op
- Given the known limitation that `check_command` is global (not scoped per task), when a task is verified while the suite happens to pass for unrelated reasons, then `verifyTask` does not attempt to detect or prevent this — accepted for MVP per epics.md, not a defect to fix here

## Spec Change Log

- 2026-08-24: Implemented per spec. All seven tasks complete; `npm test` (266/266 at first pass, including 12 new `verify.test.ts` core cases and 9 new CLI cases) and `npm run build` both passed. Before dispatching to review, I independently added and verified a permanent end-to-end test the implementer's own manual check never covered: `verify.test.ts`'s "end-to-end through the real installed Story 3.2 gate hook" describe block, which uses the real `scaffold()` (writing the real pre-commit/pre-merge-commit hooks) instead of a hand-written fixture, and confirms `verifyTask`'s own commit genuinely passes through that real hook with no bypass — proving `tasks/**`'s patch-tier classification actually prevents the self-blocking bootstrap problem architecture.md describes, not just that the design intends it to. Also independently re-ran my own from-scratch manual script confirming the same thing before adding the permanent test.

- 2026-08-24: Patch round after 3-lens review (blind-hunter, edge-case-hunter, verification-gap) run against the diff. All three lenses converged strongly on the same core issues:
  - **Critical — tamper-detection bypass via type coercion, confirmed by two lenses with the identical concrete example and independently verified by me (`Boolean("false") === true` in JavaScript).** `hashableFieldsOf` coerced fields with `Boolean(...)`/`String(...)` before hashing, so a hand-edit changing `verified_by_gate` from the boolean `true` to the STRING `"false"` silently reproduced the original stored hash and evaded corruption detection entirely — defeating this story's whole purpose. Fixed by hashing the raw, uncoerced values (added a manual before/after reproduction confirming the old code's hash collided and the new code's doesn't, mirroring the CONFIG_RELATIVE_PATH verification pattern from Story 3.2).
  - **Torn-read race: the "already done" fast path read `.gate-state` outside the lock (all three lenses).** Restructured `verifyTask` into three phases (locked pre-check → unlocked `check_command` → locked write, re-reading fresh) so every read of shared ledger/gate-state is lock-protected, closing the race where a sibling task's write could produce a false `CORRUPTED` read.
  - **Missing regression test for concurrent verify on the *identical* task-id (verification-gap), not just sibling task-ids.** The existing concurrency test never exercised the in-lock "already done" re-check branch. Added a dedicated test and independently re-ran it 5 times myself directly against the built module (outside the automated suite) to build extra confidence in a genuine race condition, not just a single lucky pass — all 5 trials resolved exactly one `verified`/one `already-verified`.
  - **Unguarded `.gate-state` hash write after a successful commit (all three lenses).** A failure here previously escaped uncaught, and — worse — would cause every future verify of that legitimately-completed task to falsely report `CORRUPTED` (no stored hash). Fixed by catching it and returning `verified` with a non-fatal `hashWriteWarning`, since the real verification (check passed, commit landed) did succeed.
  - **Path-traversal guard added** for `specId`/`taskId` (two lenses), matching `new-spec.ts`'s existing `isValidName` precedent — independently confirmed working against the rebuilt module for both argument positions.
  - **CLI switch exhaustiveness guard** added (cheap TypeScript hygiene, one lens).
  - Three lower-severity findings were deferred to `deferred-work.md`: no atomic (temp-file+rename) writes for the ledger/gate-state (matches this codebase's existing non-atomic-write convention everywhere else, not a story-specific gap); duplicate task ids in a ledger not detected (very low likelihood, machine-generated ids); `commit-failed` not distinguishing a `writeFile` failure from a real git failure (low value). One finding was rejected as intentional design, not a defect: `check_command` running unbounded/without a timeout (this story's own architecture explicitly wants synchronous, unbounded blocking here, unlike git plumbing calls, since `check_command` can legitimately be a long-running test suite).
  - Re-verified after every fix: `npm test` (270/270), `npm run build` (clean), plus my own additional manual verification of all three critical fixes (hash-coercion bypass, 5x same-task-id concurrency race, path-traversal guard) directly against the rebuilt module, independent of the automated suite.

- 2026-08-24: Post-PR CI fix. The `windows-latest` leg of PR #10's CI run failed with 4 assertion mismatches, all the same root cause as the `CONFIG_RELATIVE_PATH` fix from Story 3.2: `verify.ts`'s `ledgerRelativePath()` and `loadCheckCommand()`'s `configRelPath` were built via `path.join(...)`, which resolves to a backslash-separated string on Windows — but `git show --name-only`'s own path reporting is always forward-slash-normalized regardless of host OS, and the config-error message text embedded the same backslash. Fixed by making both forward-slash literals (safe on every platform for the actual file read/write, since `path.join` still resolves a forward-slash segment correctly), and by having the git-facing `relLedgerPath` reuse `ledgerRelativePath(specId)` directly instead of re-deriving it via `path.relative(repoRoot, ledgerAbsPath)` (which would have reintroduced a Windows backslash even after the literal fix). Also fixed three test assertions that compared `git show` output against a `path.join`-constructed expectation. Swept the rest of the codebase for the same latent pattern — confirmed no other instance exists: `scaffold.ts`'s own hook/scaffold paths are compared consistently against another `path.join` call on both sides (never against git's forward-slash-only output), so they were never at risk. Re-ran the full suite locally (270/270, macOS) and pushed; will confirm the `windows-latest` CI leg goes green on the next run.

## Design Notes

The `git add <path>` then `git commit --only <path>` sequence (rather than bare `--only`) was discovered by direct testing during planning, not assumed from `docs/architecture.md`'s prose: bare `--only` on a ledger that was never committed before (a very plausible real scenario — nothing forces a user to commit right after `new-feature`/`new-system` scaffolds it) fails outright with a git-internal pathspec error. `add`-then-`--only` handles both the never-committed and already-tracked-and-modified cases identically, confirmed empirically, and still correctly isolates from anything else already staged.

This story's core mechanism is inherently git-native (`runCheck` shells to the project's own check command; `verifyTask` shells to `git rev-parse`/`add`/`commit`) — unlike Story 3.1/3.2's pure-function-first split, there's no meaningful "primitive vs. CLI wiring" seam here worth carving out, since the git operations are intrinsic to what "verify" means, not an optional caller convenience. Both the core module and its CLI wrapper are covered in this one spec.

## Suggested Review Order

**The core mechanism**

- `verifyTask` — entry point; the three-phase locked/unlocked/locked structure is the load-bearing design that closes the torn-read and same-task-id races.
  [`verify.ts:465`](../../packages/core/src/verify.ts#L465)

- Phase 1's locked pre-check — every read of shared ledger/gate-state state now happens under the lock, including the "already done" resolution.
  [`verify.ts:485`](../../packages/core/src/verify.ts#L485)

- Phase 3's locked write, re-reading fresh — where the deliberate `add`-then-`--only` sequence, the rollback-on-failure, and the non-fatal `hashWriteWarning` all live.
  [`verify.ts:527`](../../packages/core/src/verify.ts#L527)

**Tamper detection (the most safety-critical fix in this round)**

- `computeLedgerTaskHash` — deliberately hashes raw, uncoerced values; the doc comment explains exactly why coercion would have defeated the whole mechanism.
  [`verify.ts:239`](../../packages/core/src/verify.ts#L239)

- The regression test proving the fix: hand-edits `verified_by_gate` to the string `"false"` and confirms it's now caught.
  [`verify.test.ts:352`](../../packages/core/src/verify.test.ts#L352)

**Concurrency regression coverage**

- The identical-task-id race test verification-gap's review identified as missing.
  [`verify.test.ts:401`](../../packages/core/src/verify.test.ts#L401)

- The end-to-end proof that verify's own commit passes the real Story 3.2 gate hook, added before this diff ever reached review.
  [`verify.test.ts:524`](../../packages/core/src/verify.test.ts#L524)

**Peripherals**

- The path-traversal guard, mirroring `new-spec.ts`'s existing precedent.
  [`verify.ts:397`](../../packages/core/src/verify.ts#L397)

## Verification

**Commands:**
- `npm test` -- expected: all new `verify.test.ts` cases (core + CLI) pass, covering all nine I/O matrix rows
- `npm run build` -- expected: clean

**Manual checks (if no CLI):**
- In a real scratch git repo: `waypoint install`, `waypoint new-feature demo`, stage+commit the scaffold, then `waypoint verify feat-<date>-demo t1` — confirm a real commit lands with only the ledger file changed, `.waypoint/.gate-state/feat-<date>-demo.json` is created, and re-running the same command reports already-verified with no further write
