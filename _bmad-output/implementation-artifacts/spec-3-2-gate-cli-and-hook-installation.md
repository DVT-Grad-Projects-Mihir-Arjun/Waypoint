---
title: 'Story 3.2 (part 2): waypoint gate CLI command and hook installation'
type: 'feature'
created: '2026-08-24'
status: 'done'
baseline_commit: 'df27b063c526a0c0030c95f8a44f6fec65ada5ea'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 3.2's `gate()` primitive has no caller yet — nothing resolves a real changed-file list for it, and nothing installs it as an actual git hook, so FR7 still doesn't block anything in practice.

**Approach:** Add a `waypoint gate` CLI command that resolves staged files via `git diff --cached --name-only` and calls `gate()`, exiting non-zero with a clear message on violation. Extend `waypoint install` to write two executable hook scripts (`.git/hooks/pre-commit` and `.git/hooks/pre-merge-commit`) that both invoke it.

## Boundaries & Constraints

**Always:**
- `gateCommand(cwd = process.cwd())` (`packages/cli/src/commands/gate.ts`) resolves `changedFiles` via `execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' })` (array args, never shell-interpolated), trims/splits on `\n`, filters empty entries, and calls `gate({ mode: 'staged', changedFiles, repoRoot: cwd })`. On violation: `console.error('waypoint gate: ' + v.file + ' - ' + v.reason)` per violation, `process.exitCode = 1`. On pass: no output (standard git hook convention — silence means success). If the `git diff` call itself throws (not a git repo, git unavailable), catch it and print `waypoint gate: unable to resolve staged changes (is this a git repository?): <message>`, `process.exitCode = 1` — never let a raw exception escape.
- Register `gate` in `packages/cli/src/program.ts` alongside the other six subcommands, no arguments, same `action(async () => { await gateCommand(); })` shape.
- Both hook files are POSIX shell scripts: `#!/bin/sh\n# Installed by waypoint install — do not edit directly.\nexec npx waypoint gate\n`, written executable (`chmod 0o755`) — the marker comment line is also the idempotency signal (see below).
- Extend `packages/core/src/scaffold.ts` to write both hook files as part of `scaffold()`, after the existing `ensureGitignoreEntry` call, still inside the lock-guarded block: for each hook path, if `.git` doesn't exist at all under `targetDir`, skip hook installation entirely (add one entry to a new `ScaffoldResult.warnings: string[]` field explaining why, do not abort the rest of the install — the scaffold itself has no git dependency); if `.git` exists but isn't a plain directory (a worktree/submodule `.git` file), skip the same way with its own warning rather than attempting to resolve the real hooks path; otherwise, if the hook file doesn't exist, write it and push its relative path to `createdPaths`; if it exists and contains the marker comment, treat it as already installed (push to `preservedPaths`, no-op); if it exists without the marker (a foreign, pre-existing hook), never overwrite it — push to `preservedPaths` too, but also add a `warnings` entry naming the file and stating Waypoint's gate was not installed there because of it.
- `installCommand` prints each `result.warnings` entry (if any) after the created/preserved lines, so a skipped or foreign-hook case is visible, not silent.

**Ask First:** none anticipated — all open design questions for this scope were already resolved in Story 3.2 part 1's planning (see Design Notes).

**Never:**
- Re-derive the amend/first-commit/merge diff-base handling — already settled: always `git diff --cached --name-only` against `HEAD` (or the empty tree when absent), identically for every commit type, including `--amend` (a documented, accepted limitation, not a bug — see `docs/architecture.md` v0.7).
- Add a `child_process`-shelling dependency (`simple-git`, etc.) — use `node:child_process` directly.
- Implement CI's `--ci`/`full-diff` mode or the done-claim ancestor check — Story 3.5's job.
- Attempt to resolve a worktree/submodule's real `.git`-file-pointed hooks directory — skip with a warning instead (see Boundaries above).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Real commit blocked | Real repo, staged enforced-tier file, no delta, hook installed | `git commit` is actually rejected by git; the printed message names the file and reason | N/A |
| Real commit allowed | Same, but a qualifying delta is also staged | `git commit` succeeds normally, hook prints nothing | N/A |
| Patch-tier only | Staged change matches only `tiers.patch` globs | Hook exits 0 silently | N/A |
| Not a git repo (defensive) | `gateCommand` invoked directly against a non-git `cwd` | Clear `waypoint gate:` message, non-zero exit, no crash/stack trace | Caught, never a raw exception |
| Fresh install, `.git` present | `waypoint install` in a real git repo with no existing hooks | Both hook files created, executable, and listed under `created` | N/A |
| Re-install, hooks already ours | `waypoint install` run again | Both hook files listed under `kept` (marker recognized), untouched | N/A |
| Foreign pre-existing hook | A `.git/hooks/pre-commit` already exists with unrelated content | Left untouched, listed under `kept`, plus a warning naming it | N/A |
| No `.git` at all | `waypoint install` run before `git init` | Rest of the scaffold still completes; a warning explains hooks were skipped | N/A |

</frozen-after-approval>

## Code Map

- `packages/cli/src/commands/gate.ts` (new) -- `gateCommand(cwd)`: git shell-out + `gate()` call + message/exit-code handling per Boundaries
- `packages/cli/src/program.ts` (lines 1-76) -- register the `gate` subcommand alongside the other six, following the exact `.command(...).description(...).action(...)` shape each already uses
- `packages/core/src/scaffold.ts` -- `ScaffoldResult` (lines 15-19, add `warnings: string[]`); the lock-guarded write block (lines 211-244, right after `ensureGitignoreEntry` at line 239) is where hook-writing slots in; reuse the `existsSync`-then-preserve idiom already used per-plan-entry (line 223) for the "already exists" cases
- `packages/core/src/gitignore.ts` (full file, 27 lines) -- `ensureGitignoreEntry`'s existence+content-check idiom to mirror for the hook marker-detection logic
- `packages/cli/src/commands/install.ts` (full file, 34 lines) -- print `result.warnings` after the existing `created`/`kept` loops
- `packages/core/src/gate.ts` / `packages/core/src/index.ts` -- `gate`, `GateInput` already exported (Story 3.2 part 1) for `gateCommand` to call directly
- `packages/cli/src/install.test.ts` -- existing tmpdir-fixture/`installCommand(tmpDir)` test shape to extend for hook-file writing, executable-bit, marker-idempotency, foreign-hook-preservation, and missing-`.git` cases
- `packages/cli/src/vendor-neutrality.test.ts` -- deliberately NOT extended to include `gateCommand` in its zero-`child_process`-calls assertion (`gate` legitimately shells out to `git`, unlike `install`/`new-patch`/`new-feature`); a new, separate test proves `gateCommand` makes zero *network*-surface calls (http/https/fetch/net.connect) while still shelling out to `git`

## Tasks & Acceptance

**Execution:**
- [x] `packages/cli/src/commands/gate.ts` -- implement `gateCommand` -- the actual enforcement entry point
- [x] `packages/cli/src/program.ts` -- register `gate` subcommand -- makes it invocable as `waypoint gate`
- [x] `packages/core/src/scaffold.ts` -- write both hook files with the three-way existence/marker/foreign handling -- the actual installation mechanism
- [x] `packages/cli/src/commands/install.ts` -- print `warnings` -- surfaces skipped/foreign-hook cases instead of hiding them
- [x] `packages/cli/src/gate.test.ts` (new) -- unit-test `gateCommand`'s exit code/message format against a real git repo fixture (real staged files, real `git diff --cached`), plus the network-surface-zero-calls test
- [x] `packages/cli/src/install.test.ts` -- extend for hook-file writing, executable bit, marker idempotency, foreign-hook preservation, missing-`.git` skip

**Acceptance Criteria:**
- Given an actual installed hook in a real git repo (not a mocked `gate()` call), when a real `git commit` is attempted with a staged enforced-tier file and no delta, then the commit is actually rejected by git itself, and succeeds once a qualifying delta is added to the same staged batch
- Given a commit made with `git commit --no-verify`, when that change later reaches a PR, then nothing in this story attempts to detect or log the bypass locally — Story 3.5's CI check is the independent backstop, per `docs/architecture.md`'s "bypass, reframed" section

## Spec Change Log

- 2026-08-24: Implemented per spec. All six tasks complete; `npm test` (240/240 at first pass) and `npm run build` both passed. Independently re-verified beyond the implementer's own report, and found + fixed two real issues before dispatching to review:
  - **Message-quality bug in `gateCommand`'s defensive not-a-git-repo catch block.** `execFileSync`'s thrown error embeds the child's *entire* stderr inside `.message` — and git's actual stderr for "not a git repository" (it falls into its `--no-index` fallback mode, which rejects `--cached`) is a multi-hundred-line usage dump, not a short message. The original implementation interpolated `err.message` directly into the `waypoint gate:` line, so the "clear message" the spec calls for was in practice a wall of git's own CLI help text. Confirmed by direct reproduction (`execFileSync('git', ['diff','--cached','--name-only'], ...)` against a non-repo directory). Fixed by extracting just the first non-empty line of `err.stderr` (falling back to `err.message` only if `stderr` isn't a populated string) — verified the fix produces a genuinely single-line message, and added a regression test asserting exactly that (`gate.test.ts`, the "reports a clear, single-line message" test).
  - **Missing automated proof of the story's own primary Acceptance Criterion.** All of the implementer's own `gateCommand` tests called the function directly — none of them exercised the *actual hook file `scaffold()` writes*, invoked by a *real `git commit`*, which is the literal AC ("not a mocked `gate()` call"). The implementer's own manual verification (not part of the committed test suite) did prove this once, by hand, but nothing in the repo would catch a regression here. Added a permanent, automated end-to-end test (`gate.test.ts`, "end-to-end — the actual installed hook, invoked by a real git commit") that installs real hooks via `scaffold()`, points the hook's `npx waypoint gate` line at this repo's own built CLI entry (the only necessary adjustment, since the package isn't published/linked), and runs real `git commit` attempts — confirming a commit is genuinely rejected without a delta and genuinely succeeds once one is added.
  - Re-verified after both fixes: `npm test` (241/241), `npm run build` (clean), and a from-scratch manual re-run of the full three-scenario real-git-repo check (block / allow-with-delta / allow-patch-tier) against the rebuilt CLI, independent of the new automated test.

- 2026-08-24: Patch round after 3-lens review (blind-hunter, edge-case-hunter, verification-gap) run against the diff. Applied via the implementation subagent:
  - **CRLF/quote-escape fragility in the git-diff parsing.** Splitting on `'\n'` retained a trailing `\r` on Windows/CRLF repos and didn't account for git's default `core.quotepath` escaping of non-ASCII filenames — both corrupt the path before it reaches `gate()`. Fixed by adding `-z` to the git command and splitting on `'\0'` instead; added a non-ASCII-filename regression test.
  - **No `maxBuffer`/`timeout` on the `execFileSync` call.** The ~1MB default buffer could overflow on a large merge (this command's explicit `pre-merge-commit` target) and there was no bound on lock-contention hangs. Added `maxBuffer: 32MB`, `timeout: 10s`.
  - **`gate()` itself was unguarded.** Wrapped in its own try/catch reporting a clear internal-error message, matching the doc comment's own stated intent; added a `vi.mock`-based regression test proving it's caught.
  - **Hook-installation failures could crash the entire install**, contradicting this story's own explicit "hook problems degrade to a warning, never abort" principle. Restructured `scaffold()`'s hook section: one outer try/catch around the whole section, plus a per-hook inner try/catch so one hook's failure doesn't prevent the other from being attempted or lose already-computed `createdPaths`/`preservedPaths`/`warnings`.
  - **TOCTOU race on hook creation.** Replaced the `existsSync`-then-`writeFile` pattern with exclusive-create (`{ flag: 'wx' }`), matching this codebase's established convention (`new-spec.ts`) — closes the window where a concurrently-created hook could be silently overwritten.
  - **Chmod not re-asserted on the idempotent path.** A previously-installed Waypoint hook that lost its executable bit would stay non-functional forever across re-installs. Fixed by re-running `chmod 0o755` on the recognized-as-ours branch too; added a test that strips the bit, re-installs, and confirms it's restored (skipped on `win32`, matching this file's own precedent).
  - **Windows CI risk caught before it shipped.** Verification-gap flagged that the new `statSync(...).mode & 0o777` assertions (`scaffold.test.ts`, `install.test.ts`) would fail on the `windows-latest` CI leg — Windows' fs layer doesn't implement POSIX permission bits, so `chmod`/`.mode` never reports `0o755` there. This is exactly the same class of issue that broke Story 3.2 part 1's own PR once already this session; fixed by guarding both assertions behind `process.platform !== 'win32'`, matching the precedent `vendor-neutrality.test.ts` already set for Windows-specific test differences.
  - **A second real bug I caught myself, after the patch round, that none of the three lenses nor the implementer found**: even after fixing the *message* printed via `console.error`, `execFileSync`'s failing child process was still leaking its *raw* stderr (git's full multi-hundred-line usage dump) straight to this process's own real stderr — confirmed by direct reproduction with an explicit vs. default `stdio` option, and by noticing the dump reappear in my own terminal output during a routine "everything passes" re-run, which is exactly why I don't stop at green tests. Fixed by passing an explicit `stdio: ['pipe', 'pipe', 'pipe']`. Added a regression test spying on the raw `process.stderr.write` (not just the mocked `console.error`, which the leak bypasses entirely) — verified the test genuinely fails without the fix and passes with it by temporarily reverting the fix and re-running.
  - Four lower-severity findings were deferred to `deferred-work.md` (no `core.hooksPath`/Husky-redirect detection; the `npx`/`node`-on-`PATH` hook dependency, a known limitation shared by any Node-based git hook approach; `HOOK_MARKER`'s fragility to incidental re-encoding, with no versioning scheme for future hook-content changes; `console.log`-vs-`console.error` inconsistency for warnings). Two findings were rejected: an unreachable `ok:false`-with-empty-`violations` case (`gate()`'s own contract guarantees this can't happen); no README/docs update (this project has no README convention — the CLI's own `--help` text, auto-generated from `.description()`, already covers the new command).
  - Re-verified after every fix in this round, including my own additional stderr-leak fix: `npm test` (245/245), `npm run build` (clean), and re-ran my earlier from-scratch manual real-git-commit script once more to confirm nothing regressed end-to-end.

## Design Notes

This completes Story 3.2 (epics.md), continuing directly from `spec-3-2-pre-commit-gate-blocks-missing-spec-deltas.md` (part 1, `status: done`), which delivered the CLI-less `gate()` primitive this spec now wires up. All the git-hook-behavior investigation for this piece already happened during part 1's planning and is durably recorded in `docs/architecture.md` v0.7 — nothing here needed re-deriving:

- Both `pre-commit` and `pre-merge-commit` must be installed: git invokes `pre-merge-commit`, not `pre-commit`, for a conflict-free automatic merge (confirmed by direct testing during part 1's planning).
- `--amend` gets the same diff-base treatment as an ordinary commit (`git diff --cached --name-only` against `HEAD`, or the empty tree when absent) — there is no reliable, portable signal available to `pre-commit` distinguishing an in-progress amend, confirmed empirically; this is a documented, accepted limitation, not something this spec attempts to solve differently.
- Hooks are hand-rolled shell scripts, not Husky — no new dependency, no reliance on the consuming repo's `prepare`-script/npm-lifecycle actually running.

The `warnings` field on `ScaffoldResult` is new in this spec (part 1 never needed it) — a plain `string[]`, additive to the existing `createdPaths`/`preservedPaths` shape, not a breaking change to any existing caller (both already-shipped consumers only read `createdPaths`/`preservedPaths`/`status`).

## Suggested Review Order

**The enforcement entry point**

- `gateCommand` — entry point; the `-z` flag, `maxBuffer`/`timeout`, and explicit `stdio` together close three independent real bugs found across two review passes.
  [`gate.ts:19`](../../packages/cli/src/commands/gate.ts#L19)

- The explicit `stdio` option — without it, a failing child process leaks its raw stderr straight to this process's own real stderr, bypassing the clean message entirely.
  [`gate.ts:43`](../../packages/cli/src/commands/gate.ts#L43)

- The end-to-end proof this actually works: installs real hooks, points one at this repo's own built CLI, and drives it through real `git commit` attempts.
  [`gate.test.ts:283`](../../packages/cli/src/gate.test.ts#L283)

- The stderr-leak regression guard — spies on the raw fd-level write, not the mocked `console.error`, since that's exactly what the bug bypassed.
  [`gate.test.ts:140`](../../packages/cli/src/gate.test.ts#L140)

**Hook installation**

- `scaffold()`'s hook section — outer try/catch for the whole section, inner try/catch per hook, exclusive-create closing the TOCTOU window, chmod re-asserted on the idempotent path.
  [`scaffold.ts:284`](../../packages/core/src/scaffold.ts#L284)

- `HOOK_NAMES` — both hooks are required; git invokes `pre-merge-commit`, not `pre-commit`, for a conflict-free automatic merge.
  [`scaffold.ts:53`](../../packages/core/src/scaffold.ts#L53)

**Peripherals**

- CLI registration and `installCommand`'s warning printing.
  [`program.ts:77`](../../packages/cli/src/program.ts#L77) · [`install.ts:24`](../../packages/cli/src/commands/install.ts#L24)

- The Windows-CI-safe executable-bit assertions — guarded after verification-gap flagged the same class of issue that broke this story's own part 1 PR once already.
  [`scaffold.test.ts:196`](../../packages/core/src/scaffold.test.ts#L196) · [`install.test.ts:84`](../../packages/cli/src/install.test.ts#L84)

## Verification

**Commands:**
- `npm test` -- expected: all new `gate.test.ts` (CLI) cases and extended `install.test.ts` cases pass
- `npm run build` -- expected: clean

**Manual checks (if no CLI):**
- In a real scratch git repo: run `waypoint install`, confirm both hook files exist and are executable; stage an enforced-tier file with no spec delta and attempt a real `git commit`, confirm it's rejected with a clear message; add a qualifying spec-tier file to the same staged batch and confirm the commit now succeeds; re-run `waypoint install` and confirm both hooks are reported as `kept`, unchanged
