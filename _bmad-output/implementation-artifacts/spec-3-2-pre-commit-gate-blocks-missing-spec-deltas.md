---
title: 'Story 3.2: Pre-commit gate blocks missing spec deltas'
type: 'feature'
created: '2026-08-24'
status: 'done'
baseline_commit: 'bd92d5f8a3d2655192221c06329e96a91e14f5ae'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing yet decides whether a batch of changed files, taken together, satisfies FR7's "Feature/System-tier code needs an accompanying spec delta" rule — the prerequisite the actual pre-commit gate (a follow-up spec; see Design Notes) needs before it can block anything.

**Approach:** Implement `gate(input: GateInput): GateResult` in `@waypoint/core`, a pure function built on Story 3.1's `classifyChangedFiles`: a batch containing any `enforced`-tier file is a violation unless the same batch also contains an `enforced`-tier spec-tier file (the delta itself). No CLI command, no git shell-out, no hook installation — this story delivers the CLI-less primitive only, the same shape Story 3.1 took for `classifyChangedFiles`.

## Boundaries & Constraints

**Always:**
- `GateInput = { mode: 'staged' | 'full-diff', changedFiles: string[], repoRoot: string }` — `changedFiles` are already-resolved, repo-root-relative, `/`-separated paths; `gate()` never resolves them itself and never sees a commit SHA/ref. `mode` is metadata only — it never changes this function's validation logic (both pre-commit and CI callers, built in later specs, call this same implementation).
- `GateResult = { ok: boolean, violations: Array<{ file: string; specId?: string; reason: string }> }` — `specId` stays permanently `undefined` in this MVP; no file→spec association mechanism exists (architecture.md's Error Handling Strategy is explicit about this).
- Violation rule: call `classifyChangedFiles(repoRoot, changedFiles)`. If `configError` is non-null, that is its own single violation (`file: '.waypoint/config.yaml'`, `reason` = the config error message) — never suppressed by a coincidentally-present spec-shaped path, and the delta rule below is skipped entirely for that call. Otherwise: the batch passes if any classification has `tier === 'enforced'` AND its path is a spec-tier path (`specs/{patches,features}/*.md` or `specs/systems/*/{prd,architecture,adr}.md` — reuse Story 3.1's own definition, do not re-derive a second one). A spec-tier path that itself resolved to `tier === 'unenforced'` (a `tier: patch` spec, or a path matching the default patch globs) never counts as a delta. Otherwise, every `enforced`-tier file in the batch is a violation, reason: `"Feature/System-tier change with no spec delta in this commit"`.
- This is a whole-batch check, not per-file matching — one qualifying spec-tier file anywhere in the batch satisfies every enforced file in it, by design. This matches architecture.md's "a Feature/System-tier spec file is itself a Feature/System-tier path, so the commit already is its own spec delta" framing; no finer-grained file-to-spec association exists to check against.
- Export `isSpecTierPath` (or an equivalently-named function with identical behavior) from `gate-classify.ts` for `gate()` to reuse — do not duplicate the three-location regex a second time. Unlike the small, self-contained duplications elsewhere in this codebase (frontmatter/id parsing in `new-spec.ts`/`update-spec.ts`/`check-drift.ts`, each independently flagged as deliberate), a second definition of "what counts as a spec file" here could silently drift from Story 3.1's own definition and break this exact enforcement rule.
- `gate()`'s own cost must scale with `changedFiles.length`, never with total repo size — it must not walk the working tree, glob the whole repo, or read anything beyond what `classifyChangedFiles` already reads for the given paths.

**Ask First:** none anticipated — the classification rule is fully specified above.

**Never:**
- Implement the CLI command, the `git diff --cached` shell-out, hook file installation, or any actual blocking behavior — deferred to a follow-up spec (see Design Notes and `deferred-work.md`).
- Implement CI's `full-diff` mode, the done-claim ancestor check, or anything with a `--ci` flag — Story 3.5's job, reusing this story's `gate()` unchanged.
- Populate `specId` on any violation, or build any file→spec association mechanism — explicitly out of scope per architecture.md.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Enforced file, no delta | Batch has a Feature/System-tier file, no spec-tier file present | `ok: false`, one violation per enforced file | N/A |
| Enforced file, with delta | Same, plus a `specs/features/*.md` (or system prd/architecture/adr) file also `enforced` | `ok: true`, no violations | N/A |
| Deletion, no delta | Batch has a removed enforced-tier path, no delta present | Same as a non-deletion change — deleting isn't a bypass (relies on `classifyChangedFiles`'s existing string-based deletion handling) | N/A |
| Patch-tier only | Every path in the batch classifies `unenforced` | `ok: true` — patch-tier never requires a delta | N/A |
| Delta is itself patch-tier | The only spec-tier file present resolved to `tier: 'unenforced'` (e.g. frontmatter `tier: patch`) | Does not count as a delta — enforced files in the batch still violate | N/A |
| Config missing/malformed | `classifyChangedFiles` returns non-null `configError` | One violation naming `.waypoint/config.yaml`, distinct from the delta-missing message, regardless of what else is in the batch | N/A |
| Empty batch | `changedFiles` is `[]`, config valid | `ok: true`, no violations — nothing to enforce | N/A |
| Empty batch, config missing/malformed | `changedFiles` is `[]`, config invalid | Config-error precedence still applies — `ok: false` with the single config-error violation, even though nothing was staged (a repo health problem is independent of what's being committed, consistent with the config-error rule's "regardless of what else is in the batch" framing) | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/gate-classify.ts` -- export `isSpecTierPath` (currently private, ~line 224); `classifyChangedFiles` (line 337) and its result/type shapes (`ClassifyChangedFilesResult`, `FileClassification`, `ClassificationTier`, lines 28-64) are what `gate()` builds on
- `packages/core/src/gate.ts` (new) -- `gate(input: GateInput): Promise<GateResult>`, implementing the violation rule above; mirror `gate-classify.ts`'s doc-comment style and file organization
- `packages/core/src/index.ts` -- add `export { gate, isSpecTierPath }` + `export type { GateInput, GateResult }`, following the existing barrel pattern (see the `gate-classify.ts` block at lines 56-62 for the exact style to mirror)
- `packages/core/src/gate.test.ts` (new) -- unit-test all seven I/O matrix rows against a real temp-dir fixture (same `scaffold()`/`createFeatureSpec()`/etc. pattern `gate-classify.test.ts` already uses)

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/gate-classify.ts` -- export `isSpecTierPath` -- lets `gate()` reuse the single definition of "spec-tier path" instead of re-deriving one
- [x] `packages/core/src/gate.ts` -- implement `gate(input): Promise<GateResult>` per the violation rule -- the core enforcement decision
- [x] `packages/core/src/index.ts` -- export `gate`, `isSpecTierPath`, and the new types
- [x] `packages/core/src/gate.test.ts` -- unit-test all seven I/O matrix rows

**Acceptance Criteria:**
- Given a synthetic batch of thousands of changed-file paths, when `gate()` evaluates it, then it completes quickly and without reading anything beyond the paths in the batch — proving the "cost scales with batch size, not repo size" boundary holds, not just asserting it

## Spec Change Log

- 2026-08-24: Implemented per spec. All four tasks complete; `npm test` (218/218 at first pass, including 12 new `gate.test.ts` cases covering all seven original I/O matrix rows and the performance AC) and `npm run build` both passed. Independently re-verified against the built module, including a manual repro confirming a pre-existing latent gap in the implementation's own new `existsSync` check (see below) before it was caught by review.

- 2026-08-24: Patch round after 3-lens review (blind-hunter, edge-case-hunter, verification-gap) run against the diff since `baseline_commit`. All three lenses independently converged on the same real bug; two independently also found a second one:
  - **Deletion-of-spec-file loophole (confirmed by two lenses).** The original `hasDelta` check accepted any spec-tier path classified `enforced`, including one that was *deleted* in the same batch — `classifyChangedFiles` classifies a deleted spec-tier path `enforced` via its default no-glob-match rule (frontmatter-override is skipped for a nonexistent path), so a deleted spec file could silently satisfy the delta requirement for other enforced files. Fixed: `hasDelta` now also requires `existsSync` on the spec-tier path.
  - **Missing slash-normalization before `isSpecTierPath` (confirmed by all three lenses).** `gate()` called `isSpecTierPath(classification.path)` with the raw, possibly-unnormalized path, even though that function's own parameter name/doc requires a `/`-normalized path and its only other call site normalizes first. Fixed: `gate()` now normalizes before both the `isSpecTierPath` check and the `existsSync` check (the implementer's first pass fixed only the former; I caught the latter myself during independent re-verification — a manual repro with a real backslash-separated path failed even after the review-driven patch, because the new `existsSync` check built its path from the *unnormalized* value. Fixed by normalizing once and reusing the normalized path for both checks. Re-verified the corrected fix with the same manual repro: now passes.).
  - **Duplicated, drift-prone config-path literal.** `gate.ts` hardcoded its own `.waypoint/config.yaml` string instead of reusing `gate-classify.ts`'s existing `CONFIG_RELATIVE_PATH` constant — the exact "second definition that could drift" risk the frozen spec already warned about for `isSpecTierPath`. Fixed by exporting and reusing `CONFIG_RELATIVE_PATH`.
  - **Doc comment inaccuracy.** The top-of-file comment reproduced the spec's prose signature without noting the real implementation is `async`/`Promise`-returning and performs bounded I/O. Corrected.
  - **Added test coverage**: a regression test for the deletion loophole; `architecture.md`/`adr.md` as qualifying deltas (previously only `prd.md` was tested); a `specs/patches/*.md` spec overridden *up* to `tier: feature`/`tier: system` as a valid delta (previously only the downgrade direction was tested); a multi-enforced-file-plus-one-delta test proving the "whole batch, not per-file" design claim; a backslash-separated delta-path test (the regression test for the normalization gap I caught); and an I/O-scope-verifying enhancement to the performance AC test (spies on `fs`/`fs/promises` confirming the decoy directory and decoy unparseable spec file are never read, not just that the call stays fast).
  - **Frozen-text amendment (I/O matrix, not a behavior change).** Split the "Empty batch" row into two: one for a valid config (`ok: true`, unchanged), and a new one making explicit that config-error precedence still applies to an empty batch (`ok: false`) — the original single row read as an unconditional claim that, taken literally alongside the separate "regardless of what else is in the batch" config-error rule, was ambiguous for their intersection. The implementation already did the safe/correct thing (fail-closed); this was a wording gap, not a code defect, resolved directly since there was exactly one sensible reading (a missing config is a repo-health problem independent of what's staged) — added the corresponding test myself since no existing test covered this exact row.
  - Two lower-severity findings were deferred (not patched) to `deferred-work.md`: `gate()` doesn't dedupe repeated paths in a batch (no real caller produces duplicates); and the pre-existing Story 3.1 `frontmatterOverrideTier` has the identical normalization-before-`existsSync` gap this story just fixed in `gate.ts`, discovered incidentally while diagnosing the above — left alone since it's already-shipped code outside this story's scope. Two findings were rejected as noise: `specId`-undefined isn't re-asserted in every test (already implicitly covered by `toEqual`'s exact-match semantics), and a test's raw-string-replace YAML mutation (matches this codebase's own established test convention from Story 3.1, not a deviation).
  - Re-verified after all patches: `npm test` (226/226), `npm run build` (clean), and fresh manual smoke tests against the rebuilt module confirming both the deletion-loophole fix and the normalization fix actually work end-to-end (not just via the test suite).

## Design Notes

This is the first of two specs covering epics.md's Story 3.2. The full story (core `gate()` function + a `waypoint gate` CLI command + `waypoint install` writing `.git/hooks/pre-commit`/`.git/hooks/pre-merge-commit` + an end-to-end real-git-repo test) estimated ~3600 tokens during planning — split here along the same "CLI-less primitive vs. consuming mechanism" seam Story 3.1/3.2 already established, with the user's approval. See `deferred-work.md` for the deferred follow-up scope.

Two design questions surfaced during planning — both already resolved with the human and durably recorded in `docs/architecture.md` v0.7 for when the follow-up spec is written, so they don't need re-deriving then: (1) `git commit --amend` gives a `pre-commit` hook no reliable, portable signal that it's mid-amend (confirmed by direct testing — no hook arguments, no distinguishing environment variable), so the follow-up spec will treat every commit type uniformly rather than attempt a fragile, platform-specific detection heuristic. (2) Hook installation will be a hand-rolled shell script written directly by `waypoint install`, not Husky (superseding the "Husky is the MVP default" line architecture.md carried through v0.1–v0.6) — and git invokes a *different* hook (`pre-merge-commit`) for a conflict-free automatic merge, confirmed by testing, so the follow-up spec must install both hook files. Neither of these affects this spec's pure `gate()` function.

## Suggested Review Order

**The violation rule itself**

- Entry point: the config-error short-circuit, then the whole-batch delta check, then the per-file violation mapping.
  [`gate.ts:96`](../../packages/core/src/gate.ts#L96)

- The delta check, in its final (patched) form — normalizes once, then checks both `isSpecTierPath` and `existsSync` against the same normalized path, closing both the deletion-loophole and the normalization gap in one place.
  [`gate.ts:108`](../../packages/core/src/gate.ts#L108)

**Reused primitives from Story 3.1, now exported for this purpose**

- `isSpecTierPath` — the single definition of "what counts as a spec file," reused rather than re-derived.
  [`gate-classify.ts:254`](../../packages/core/src/gate-classify.ts#L254)

- `normalizeSlashes` and `CONFIG_RELATIVE_PATH` — newly exported so `gate()` never carries its own drifting copy of either.
  [`gate-classify.ts:228`](../../packages/core/src/gate-classify.ts#L228)

**Regression coverage for the two patched bugs**

- The deletion-of-the-delta-itself test — the most important addition, since it's the one that would have caught the original loophole.
  [`gate.test.ts:231`](../../packages/core/src/gate.test.ts#L231)

- The backslash-separated delta-path test — regression coverage for the normalization gap, including the one the implementer's own fix initially missed.
  [`gate.test.ts:82`](../../packages/core/src/gate.test.ts#L82)

**Peripherals**

- The empty-batch/config-error intersection tests, added after the frozen I/O matrix's wording was clarified.
  [`gate.test.ts:360`](../../packages/core/src/gate.test.ts#L360)

- The strengthened performance AC test — now verifies I/O scope via fs spies, not just elapsed time.
  [`gate.test.ts:382`](../../packages/core/src/gate.test.ts#L382)

## Verification

**Commands:**
- `npm test` -- expected: all new `gate.test.ts` cases pass, covering all seven I/O matrix rows and the performance AC
- `npm run build` -- expected: clean

**Manual checks (if no CLI):**
- In a Node REPL against `packages/core/dist`, call `gate({ mode: 'staged', changedFiles: [...], repoRoot })` against a real scratch repo fixture and confirm the violation/pass behavior matches each I/O matrix row directly
