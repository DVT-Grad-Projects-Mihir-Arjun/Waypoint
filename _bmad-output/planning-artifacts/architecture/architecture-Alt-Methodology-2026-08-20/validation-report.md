# Architecture Validation Report — Waypoint

- **Document:** `docs/architecture.md` (v0.4 — the redesign)
- **Reviewers:** rubric walker, adversarial seam-conflict, research verification
- **Run at:** 2026-08-20T07:27:21Z
- **Grade:** Poor (by finding count) — but qualitatively different from rounds 1–3
- **Pass:** 4th validation round, 1st on the redesign

## Overall verdict
The redesign converged on what it set out to fix. Both independent reviews confirm, in a dedicated "Closed / well-pinned" section, that every headline problem from rounds 1–3 is now **closed by construction, not just by restated intent**: the gate-state/CI-write contradiction is gone because CI never touches that file; the fork-PR token gap, branch-protection deadlock, review-dismissal-on-push, and local/CI write race are all gone because CI is now provably read-only end to end; the trailer-grammar and spec-id-encoding gaps are gone because there's no trailer left to parse; the undeclared GitHub-specific assumption is gone because the CI script needs no elevated permissions at all, on any provider.

What the redesign didn't do — and this round's findings are almost entirely about — is fully specify its own replacement mechanism. `waypoint verify`'s "makes its own commit for that ledger change" line turns out to hide four real gaps: the commit isn't stated to be exempt from the pre-commit gate it must pass (a bootstrapping deadlock two reviews found independently), `runCheck()` never says whether it isolates the target commit before running the check, CI's enumeration of "every done task" has no bound or dedup strategy, and shallow CI checkouts / squash-merges can make a recorded `linked_commit` unresolvable. **These are narrow, independently fixable specification gaps in one new mechanism — not a new instance of the structural, comparable-severity-every-round pattern from rounds 1–3.** Rounds 1–3 kept finding that fixing one incompatibility opened a different incompatibility of equal severity in the same subsystem; this round found that one new command's contract needs one more pass of detail, which is a normal, converging kind of finding.

## Review summary
- **Rubric walker** — thin — 1 critical, 2 high, 2 medium, 1 low
- **Adversarial seam-conflict** — 3 critical, 3 high, 2 medium, 1 low (plus a "Closed" section confirming 5 round 1–3 problem classes are gone by construction)
- **Research verification** — clean — 0 findings across all severities

## Findings by severity (deduplicated where both reviews independently found the same root cause)

### Critical (3 distinct root causes — the bootstrapping deadlock was found independently by both reviews)
**[Rubric + Adversarial, independently]** `waypoint verify`'s own commit collides with the pre-commit gate it must pass
The default patch-classified globs (`specs/patches/**`, `docs/**`, root `*.md`) don't cover `tasks/**`, so a ledger-only commit is Feature-tier-classified with no spec delta — exactly what `gate()` is defined to block. As written, `waypoint verify` likely can't complete its own commit on any Feature/System-tier spec, breaking the mechanism at its core the first time it's used.
Fix: Add `tasks/**` (or the literal ledger glob) to the default patch bucket, or explicitly document that `waypoint verify`'s internal commit intentionally skips hooks (and say so plainly, so it isn't confused with a Story 3.1 AC2 bypass).

**[Adversarial]** `runCheck()` never specifies how `commitSha` gets materialized before `checkCommand` runs
Nothing says whether an implementation must isolate/checkout that commit (e.g. a worktree) or can just run the check in-place. Skipping isolation means local `verify` could test uncommitted working-tree state rather than the committed snapshot it claims to check, and CI's per-task loop could end up checking every task against the same current HEAD regardless of what `linked_commit` says — silently defeating the redesign's central claim that CI independently re-derives correctness.
Fix: Pin `runCheck()` to require an isolated checkout of `commitSha` (and state the dependency-install cost this implies), or explicitly scope MVP to same-commit-only checks if isolation is deferred.

**[Adversarial]** Shallow CI clones and squash-merge can make a recorded `linked_commit` unresolvable
Default shallow checkouts mean older SHAs aren't in CI's object database (`runCheck()` fails with "unknown revision," not a real check failure); squash-merge rewrites every feature-branch commit into one new SHA on merge, so every `linked_commit` recorded during a PR's life becomes unreachable on `main` immediately after. The document doesn't distinguish "commit not found" from "check genuinely regressed."
Fix: State a required CI checkout depth/merge-strategy assumption, or define "commit not resolvable" as a distinct, non-failing outcome rather than an undifferentiated failure.

### High (5)
**[Adversarial]** Self-commit's staging scope is unpinned and collides with a known git gotcha — plain `git add <ledger> && git commit` doesn't isolate the commit from other already-staged files; two implementations following the doc literally produce different repo histories.
Fix: Specify the verify commit must be isolated to the ledger path alone (`git commit --only`/equivalent), and state behavior when other changes are staged.

**[Adversarial]** Re-running `waypoint verify` on an already-`done` task is undefined — v0.3 had an explicit idempotency rule; v0.4 removed the subsystem that rule lived in with no replacement.
Fix: State explicitly whether a re-verify on an already-done task no-ops, errors, or re-verifies-and-overwrites.

**[Rubric + Adversarial, same root]** Bypass-logging guarantee is conditional on branch-protection/PR infrastructure the document never states as a precondition — a solo developer pushing straight to `main` (brief.md's own stated primary user) with no PR leaves zero record anywhere if they bypass locally, since neither a Waypoint log nor a git-host audit entry exists in that case.
Fix: State the branch-protection-plus-required-check precondition explicitly (ideally have `waypoint install`/`status` detect and warn when absent), or scope the "logged, not silent" guarantee's Non-Goal to PR-gated repos only.

**[Rubric]** CI's "done-claim correctness" re-check has no bound and no incremental/dedup strategy — re-running a full `check_command` once per `done` task with no caching could mean hundreds of full test-suite runs per PR as a repo accumulates completed tasks; NFR4 only bounds the fast pre-commit check, not this.
Fix: Scope the re-check to specs touched by the current PR, and/or dedup `runCheck()` calls by unique `linked_commit`.

## Medium (4)
**[Rubric]** No specified failure/rollback contract for `waypoint verify`'s commit step — unclear what `verify` stages, or what happens if the commit itself fails, leaving a possible inconsistent intermediate state.

**[Rubric]** `linked_commit`'s semantics are looser than FR6/Story 3.2 imply — it's whatever `HEAD` is when `verify` happens to be invoked, not necessarily the commit that implemented that specific task; combined with a global `check_command`, this is a weaker guarantee than FR6's language suggests. Worth documenting as an accepted limitation rather than leaving implicit.

**[Adversarial]** `.gate-state/<spec-id>.json` update semantics (merge vs. overwrite) are unpinned — an overwrite implementation would silently erase previously recorded hashes for other tasks in the same spec, quietly disabling their local corruption detection.

**[Adversarial]** CI's "every done task" enumeration has no interface contract (unlike `gate()`'s explicit `changedFiles` contract) and no stated dedup for tasks sharing a `linked_commit`.

## Low (2)
**[Rubric]** Global `check_command` lets `verify` mark a not-actually-tested task `done` if the suite happens to be green for unrelated reasons — an already-accepted MVP tradeoff, but worth calling out explicitly as a residual FR6 gap rather than a closed issue.

**[Adversarial]** Push timing for the verify commit is unstated — CI can't see a `done` status until the commit is pushed, which could confuse a first-time user watching CI still show `pending` right after a local `verify` succeeds.

## What's now genuinely closed by construction (both reviews independently confirm)
- **Gate-state/CI-write contradiction** (rounds 1–3's headline issue) — fully closed. `.gate-state` is local-only, gitignored, never expected on a fresh checkout; CI's check doesn't touch it at all.
- **Fork-PR token gap, branch-protection deadlock, review-dismissal-on-push, local/CI write race** — all closed. All four depended on CI needing write/push permissions; CI is now read-only end to end.
- **Trailer-grammar and spec-id-encoding gaps** — closed. No trailer left to parse; `verify` takes identity as explicit CLI arguments.
- **Undeclared GitHub-specific assumption** — closed. CI needs no elevated permissions and works identically across providers.
- **Async execution ambiguity** — closed. `verify` is explicitly synchronous, with the tradeoff justified rather than left implicit.

## Reviewer files
- `reviews/review-rubric.md`
- `reviews/review-adversarial-seams.md`
- `reviews/review-research-verification.md`
