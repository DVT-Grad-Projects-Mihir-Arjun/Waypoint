---
title: 'Story 3.5: CI enforces the same gate, plus done-claim correctness'
type: 'feature'
created: '2026-08-24'
status: 'done'
baseline_commit: '40656bcadfe15e5a7ee75cdb030b14528eace518'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Enforcement so far only holds if a contributor's local pre-commit hook actually ran. A `git commit --no-verify`, a missing/uninstalled hook, or a hand-typed `status: done` with a fabricated `linked_commit` on a machine where `waypoint verify` never ran all currently slip through with nothing catching them at merge time.

**Approach:** Extend `waypoint gate` with a `--ci` mode (`npx waypoint gate --ci --base <ref>`) that runs two independent, read-only checks over the current checkout and fails the build if either finds a problem:
1. **Spec-delta enforcement**, re-run over the full PR diff (`git diff <base>...HEAD`, not just staged files) using `gate()` unchanged (Story 3.2's `mode: 'full-diff'` was already anticipated for exactly this).
2. **Done-claim correctness** (new): every task any ledger under `tasks/**` claims is `done` must have a `linked_commit` that both resolves to a real commit and is an ancestor of HEAD (`git merge-base --is-ancestor`) — catching a hand-typed `status: done` that never went through `waypoint verify`, on any machine, regardless of whether `.gate-state` exists locally.

## Boundaries & Constraints

**Always:**
- `--ci` is a new flag on the existing `waypoint gate` command (not a separate command) — same binary entry point CI invokes, consistent with `docs/architecture.md`'s `npx waypoint gate --ci` framing.
- `--ci` requires `--base <ref>` in the same invocation; there is no default base branch name, and no CI-provider-specific env var (e.g. `GITHUB_BASE_REF`) is ever read — Waypoint stays vendor-neutral by requiring the caller's own CI workflow file to supply the correct base ref for its own setup, exactly the same "config/caller-driven, never guessed" pattern already established for `check_command`. Passing `--base` without `--ci`, or `--ci` without `--base`, is a clear CLI usage error, not a silent fallback.
- The full-diff spec-delta check resolves `changedFiles` via `git diff <base>...HEAD --name-only -z` (triple-dot: diffs against the merge-base of `<base>` and `HEAD`, matching how GitHub/GitLab compute a PR's own diff — not a plain two-dot diff, which would also include unrelated commits `<base>` gained after the PR branched) and calls `gate({ mode: 'full-diff', changedFiles, repoRoot: cwd })` — `gate()` itself is unchanged; `mode` is metadata only, confirmed already true in the current implementation.
- Done-claim correctness is a new, self-contained core primitive: `checkDoneClaims(repoRoot): Promise<DoneClaimResult>`. It enumerates every `*.ledger.yaml` file under `tasks/` (recursive walk, not a full-repo scan — `tasks/**/*.ledger.yaml` is a fixed, non-configurable location, so a small hand-rolled recursive walk is enough; no new glob dependency), and for every task with `status: 'done'` in every ledger found:
  - a blank or entirely missing `linked_commit` is a violation, reported identically to an invalid one (never treated as a softer case)
  - otherwise, `git merge-base --is-ancestor <linked_commit> HEAD` (exit 0 = ancestor, confirmed real commit; nonzero = violation) is the sole check — never a re-run of `check_command` (that doesn't scale with completed-task count and can't reliably target an arbitrary historical commit under CI's checkout constraints, per `docs/architecture.md`'s own reasoning for this design)
  - a ledger file that fails to parse as YAML, or parses without a `tasks` array, is its own violation naming that file — checking continues over every other ledger found rather than aborting the whole run on the first bad file
- `checkDoneClaims` never writes to the ledger, `.gate-state`, or anywhere else — read-only, matching `gate()`'s own guarantee.
- `waypoint gate --ci`'s combined report covers both checks together: if either has violations, the command exits non-zero and prints every violation from both (spec-delta violations in the existing `waypoint gate: <file> - <reason>` style; done-claim violations naming the ledger file and task id) — never silently reporting only one check's result.
- The full-non-shallow-checkout requirement (an older `linked_commit` can't resolve its ancestry from a shallow clone) is a CI-configuration precondition, not something this code can fix — `checkDoneClaims` runs `git rev-parse --is-shallow-repository` once and, if the repo is shallow and at least one ancestor-check-based violation was found, appends one hint line to the result noting the checkout may be shallow, rather than trying to detect or paper over the condition itself.

**Ask First:** none anticipated.

**Never:**
- Change `gate()`'s own signature or behavior — `mode: 'full-diff'` already exists in `GateInput` precisely for this story; this story is purely a new caller.
- Re-run `check_command` inside `checkDoneClaims` — the done-claim check is exclusively the cheap `git merge-base --is-ancestor` plumbing check.
- Wire anything into this repository's (`Alt-Methodology`) own `.github/workflows/ci.yml` — that workflow tests Waypoint's own source against its own test suite; it is not a repo that runs `waypoint install`/has its own `.waypoint/config.yaml` or ledgers, so `waypoint gate --ci` has nothing of this repo's own to check. This story's CI-wiring guarantee is about what a *consuming* repo's pipeline would run, proven here via tests and the manual-check scratch-repo flow, not by editing this repo's own workflow file.
- Require any elevated permission, write access, or CI-provider-specific setup beyond a full (non-shallow) checkout.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full PR diff, missing spec delta | A Feature/System-tier file changed between `<base>` and `HEAD` with no spec delta | Build fails, naming the file (same message shape as the existing pre-commit path) | N/A |
| Full PR diff, clean | Every enforced-tier change between `<base>` and `HEAD` has a qualifying spec delta | Exits 0 silently | N/A |
| `--ci` without `--base` | CLI invocation | Clear usage error, no git calls attempted | N/A |
| Done-claim, valid | Every `done` task's `linked_commit` resolves and is an ancestor of HEAD | Exits 0 silently (for this check) | N/A |
| Done-claim, fabricated/unrelated commit | A `done` task's `linked_commit` doesn't resolve, or resolves but isn't an ancestor of HEAD | Build fails, naming the ledger and task | N/A |
| Done-claim, blank/missing `linked_commit` | A `done` task with `linked_commit: null`/absent | Build fails identically to the fabricated-commit case | N/A |
| Done-claim, malformed ledger | A `*.ledger.yaml` file that isn't parseable YAML, or lacks a `tasks` array | Build fails naming that specific ledger file; every other ledger is still checked | N/A |
| No `tasks/` directory at all | Fresh/uninstalled repo | Done-claim check trivially passes (nothing to check) | N/A |
| Both checks fail at once | A missing spec delta and a bad done-claim in the same run | Both sets of violations are printed; exit code still just non-zero | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/done-claim.ts` (new) -- `checkDoneClaims(repoRoot): Promise<DoneClaimResult>`, the small recursive `tasks/` walker, and the per-task ancestor check
- `packages/core/src/index.ts` -- export `checkDoneClaims`, `DoneClaimResult`, `DoneClaimViolation`
- `packages/cli/src/commands/gate.ts` -- add `--ci`/`--base` handling: resolve the full-diff changed-files list, call `gate({ mode: 'full-diff', ... })`, call `checkDoneClaims`, combine and report both
- `packages/cli/src/program.ts` -- register `--ci` and `--base <ref>` options on the existing `gate` command
- `packages/core/src/done-claim.test.ts` (new) -- unit-test all done-claim I/O matrix rows plus the perf budget (2,000 tracked files / 50 ledgers, under CI's 60s budget)
- `packages/cli/src/gate.test.ts` -- extend with `--ci`/`--base` wiring tests against a real two-branch git fixture (full-diff spec-delta check, combined-failure reporting, missing-`--base` usage error)

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/done-claim.ts` -- implement `checkDoneClaims` and its types -- the new done-claim-correctness primitive
- [ ] `packages/core/src/index.ts` -- export the new symbols
- [ ] `packages/core/src/done-claim.test.ts` -- unit-test every I/O matrix row for done-claim correctness, plus the perf budget
- [ ] `packages/cli/src/commands/gate.ts` -- implement `--ci`/`--base` handling, combining both checks' reports
- [ ] `packages/cli/src/program.ts` -- register the new options
- [ ] `packages/cli/src/gate.test.ts` -- CLI wiring tests for `--ci`/`--base`, including the combined-failure and missing-`--base` cases

**Acceptance Criteria:**
- Given a PR diff against a repo with up to 2,000 tracked files and 50 open specs, when `npx waypoint gate --ci --base <ref>` runs, then it completes within 60 seconds (verified by an automated timed test, not just an assumption)
- Given a task hand-edited directly to `status: done` with a fabricated or unrelated `linked_commit`, on a machine where `waypoint verify` never ran, when CI's done-claim check runs, then the build fails naming the specific task -- this is FR6's "an agent can't self-report completion" guarantee proven at the story level
- Given CI completes both checks, when it reports its result, then it has written nothing to the ledger, the gate-state file, or anywhere else

## Spec Change Log

- 2026-08-24: Implemented per spec. All six tasks complete; `npm test` (321/321, including 15 new `done-claim.test.ts` core cases and 6 new CLI cases) and `npm run build` both passed. `checkDoneClaims` was built as a small, self-contained recursive walker scoped only to `tasks/` (no reuse of `check-drift.ts`'s unexported full-repo walker, no new glob dependency), with a shallow-checkout hint (`git rev-parse --is-shallow-repository`) appended only when the checkout is shallow and an ancestor-check violation was actually found. The perf AC (2,000 tracked files / 50 ledgers under a 60s budget) was verified with an automated timed test mirroring `gate.test.ts`'s own existing perf-test pattern (fixture setup excluded from the timed window) — completed in ~4.5s, well under budget.

- 2026-08-24: Patch round after 3-lens review (adversarial, edge-case-hunter, verification-gap) run against the diff. Findings were extensive; seven were patched, several were deferred, and one — a genuine architecture-level risk, not an implementation bug — was escalated to the user rather than silently resolved:
  - **Git argument-injection risk in `isAncestorOfHead` (adversarial).** `linked_commit` is read straight from a hand-editable YAML file inside the very PR being checked, and was passed as a bare positional argument to `git merge-base --is-ancestor <commit> HEAD` with no `--` separator and no format validation — a value shaped like a git flag (e.g. `--upload-pack=/tmp/x`) would be interpreted as a flag by git itself. Fixed with two layers: a `COMMIT_HASH_PATTERN` pre-check (`/^[0-9a-f]{4,40}$/i` — the only shape `waypoint verify` ever writes) rejects anything else as its own violation *before* ever shelling out, and a `--` separator was added to the `execFileSync` call as defense-in-depth. Added a regression test proving a git-flag-shaped value is rejected as a violation, never passed through to git.
  - **Independently confirmed by two review lenses: if either check in `runCiGate` threw unexpectedly, the other check's result — computed or not — was silently lost**, contradicting the function's own doc-comment promise to report both checks together always. Fixed by wrapping `gate()` and `checkDoneClaims()` each in their own try/catch, gathering both outcomes fully independently before deciding the combined exit code. Added two tests, each mocking one check to throw and confirming the other's result (a real violation, or its own internal-error message) still gets printed.
  - **`String(task.id)` coercion (adversarial) silently turned a missing/non-string task `id` into the literal string `"undefined"`**, masking a distinct malformed-task problem as an ordinary done-claim violation. Fixed with a dedicated violation for a missing/non-string `id`, checked before any `linked_commit` logic runs. Added two tests (missing id, non-string id).
  - **No diagnostic when `--base` produces zero changed files (adversarial)** — e.g. `--base HEAD`, a realistic CI-workflow copy-paste mistake — silently passed with no signal the base might be misconfigured. Added a non-blocking informational note (never affects the exit code) when the full diff is empty. Added a test confirming the note appears and the command still exits cleanly.
  - **Help text ambiguity (adversarial):** `--ci`'s description didn't clarify that the done-claim half is a full, repo-wide sweep independent of `--base`'s diff scope, unlike the spec-delta half. Updated both the command's `.description()` and the `--ci` option's own help text to state this explicitly.
  - **Untrusted ledger-sourced strings interpolated raw into `console.error` (adversarial)** — a crafted `linked_commit`/task `id` could inject control/ANSI-escape characters into CI log output. Added a `sanitizeForLog` helper (strips C0 controls + DEL) applied to every field of a `DoneClaimViolation` before printing. Added a test proving a control character in `linked_commit` is sanitized in the printed output.
  - **Missing verification-gap (independently confirmed): no test exercised the real Commander-level `--ci`/`--base` argv wiring** — every existing test called `gateCommand` directly with a hand-built options object, bypassing `program.ts`'s actual `.option()` registrations entirely, unlike every other command in this codebase (`verify.test.ts`, `install.test.ts`, `update.test.ts`, `approve.test.ts`, `check-drift.test.ts` all use `createProgram()` + `parseAsync`). Added two tests using that same established pattern, proving real argv (`['gate', '--ci', '--base', 'main']`) reaches the underlying checks correctly.
  - **Escalated to the user, not patched:** the adversarial lens found that `checkDoneClaims`'s full, repo-wide ledger sweep (explicitly required by epics.md's own Story 3.5 AC — "every ledger file in the repo... from the repo root," not an implementer choice) is fundamentally incompatible with sustained squash-merge use: once one PR is squash-merged, its `linked_commit` is rewritten out of history, and every *subsequent* PR's `--ci` run then permanently fails that old task's ancestor check. The existing `docs/architecture.md` v0.5 "squash-merge is a non-issue" reasoning only addressed a task's own PR being checked pre-merge, not this cross-PR interaction with a full-repo sweep. User decided: document as a known limitation for now rather than fix in Story 3.5 (a real fix would mean either re-scoping the check, contradicting the explicit AC, or a different mechanism entirely, e.g. re-verifying against the PR branch's own recorded tip). Documented in `docs/architecture.md` (v0.8 Change Log entry plus a Core Workflows caveat) and logged to `deferred-work.md`.
  - **Rejected as intentional, already-accepted architecture-level design (adversarial):** checking `verified_by_gate` in `checkDoneClaims` was proposed as a mitigation for a fabricator who deliberately picks a real, already-merged, unrelated ancestor commit. Rejected: `docs/architecture.md`'s existing reasoning already explicitly accepts this residual gap ("without re-litigating whether that historical commit's tests still pass"), and checking `verified_by_gate` would add zero real defense in practice — that field is exactly as hand-forgeable as `status` itself in a committed ledger; the only thing that actually cryptographically ties `verified_by_gate` to something unforgeable is `.gate-state`'s local hash, which is gitignored and never reaches CI at all.
  - **Deferred, consistent with established precedent:** symlinked ledger files/directories being silently skipped by the `tasks/` walker (a third instance of a gap-class already logged twice for `check-drift.ts` and `scaffold.ts`'s own walkers); parallelizing the per-task ancestor-check git calls for scale beyond this story's actual required AC (the perf test already passes with a 13x margin at the AC's stated scale).
  - Re-verified after every fix: `npm test` (17 test files, 330 tests, 0 failures), `npm run build` (clean). I independently re-read the full diff of `done-claim.ts` and `gate.ts` line by line against each of the seven patches, and independently confirmed the two new argv-wiring tests genuinely exercise `createProgram()`/`parseAsync` (not just `gateCommand` directly) before accepting the report.

## Design Notes

Considered splitting this story the way Story 3.2 was split (a pure primitive vs. its CLI/consuming wiring), but rejected it: unlike 3.2's hook-installation-vs-`gate()`-function split (each half independently shippable and independently meaningful), spec-delta-full-diff and done-claim-correctness are two checks that only satisfy this story's AC set together, under the same `--ci` flag's combined report -- a `--ci` that ran only one of the two would not be a complete, independently valuable slice. Kept as one spec; scope is bounded to one new core module plus a thin CLI extension, with no unrelated cleanup.

`--base` is required (not defaulted or auto-detected from a provider-specific env var) to keep `waypoint gate --ci` working identically on any CI provider -- the same reasoning `docs/architecture.md` already applies to `check_command` itself: Waypoint never guesses something the caller's own pipeline configuration already knows precisely.

The full-non-shallow-checkout requirement is documented as a CI-configuration precondition (matching how `approve`'s "not agent-callable" guarantee is a documentation-layer convention, not a technical block) -- `checkDoneClaims` doesn't attempt to detect or work around a shallow clone beyond surfacing one hint line when it's shallow and a violation was found, since a shallow clone's missing history naturally fails the ancestor check (erring toward "unverifiable = fail," never a false pass) rather than needing bespoke handling.

## Suggested Review Order

**The core mechanism**

- `checkDoneClaims` — entry point; the empty-`tasks/`-directory trivial pass, the per-ledger continue-on-malformed loop, and the shallow-checkout hint are all here.
  [`done-claim.ts:183`](../../packages/core/src/done-claim.ts#L183)

- `COMMIT_HASH_PATTERN` / `isAncestorOfHead` — the load-bearing fix from this round's review: a `linked_commit` is validated as a plausible commit hash *before* ever being shelled out to git, and the `--` separator is a second defense-in-depth layer.
  [`done-claim.ts:108`](../../packages/core/src/done-claim.ts#L108) / [`done-claim.ts:122`](../../packages/core/src/done-claim.ts#L122)

- `collectLedgerFiles` — the self-contained `tasks/`-scoped recursive walker, forward-slash paths built incrementally rather than via `path.relative`.
  [`done-claim.ts:65`](../../packages/core/src/done-claim.ts#L65)

**CLI wiring**

- `runCiGate` — the `isLastPhase`-equivalent fix from this round: both checks are now wrapped in their own try/catch, gathered fully independently of each other's failure.
  [`gate.ts:108`](../../packages/cli/src/commands/gate.ts#L108)

- `sanitizeForLog` / `formatDoneClaimViolation` — the control-character sanitization added this round for ledger-sourced strings reaching CI logs.
  [`gate.ts:59`](../../packages/cli/src/commands/gate.ts#L59) / [`gate.ts:76`](../../packages/cli/src/commands/gate.ts#L76)

**Regression tests added in this round**

- The git-flag-injection rejection test — the scenario the `COMMIT_HASH_PATTERN` fix exists for.
  [`done-claim.test.ts:199`](../../packages/core/src/done-claim.test.ts#L199)

- The two independent-outcomes tests proving one check's throw no longer silently drops the other's result.
  [`gate.test.ts:495`](../../packages/cli/src/gate.test.ts#L495)

- The real-argv wiring tests closing verification-gap's finding — the only tests in this file that go through `createProgram()`/`parseAsync` rather than calling `gateCommand` directly.
  [`gate.test.ts:640`](../../packages/cli/src/gate.test.ts#L640)

**Documentation — the escalated architectural risk**

- `docs/architecture.md`'s v0.8 Change Log entry and the accompanying Core Workflows caveat, documenting the squash-merge/full-repo-sweep interaction as a known, user-confirmed limitation rather than a Story 3.5 code fix.

## Verification

**Commands:**
- `npm test` -- expected: all new `done-claim.test.ts` cases and the extended `gate.test.ts` `--ci` cases pass, covering every I/O matrix row and the perf budget
- `npm run build` -- expected: clean

**Manual checks (if no CLI):**
- In a real scratch repo with two branches (`main`/a feature branch): make a Feature-tier change with no spec delta on the feature branch, run `npx waypoint gate --ci --base main` from the feature branch tip -- confirm it fails naming the file; add a qualifying spec delta and confirm it now passes. Separately, hand-edit a ledger's task to `status: done` with a fabricated `linked_commit`, run the same command -- confirm it fails naming that task; fix it to a real ancestor commit and confirm it passes.

