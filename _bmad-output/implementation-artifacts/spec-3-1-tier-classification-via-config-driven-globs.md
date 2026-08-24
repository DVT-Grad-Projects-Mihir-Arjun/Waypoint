---
title: 'Story 3.1: Tier classification via config-driven globs'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: 'bbe51c396b9dfcb6974871b5ff9dd59d3d29d6d1'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing yet decides whether a changed file is patch-tier (unenforced) or Feature/System-tier (enforced) — the prerequisite Story 3.2's gate needs before it can decide what to block.

**Approach:** Implement `classifyChangedFiles(repoRoot, filePaths)` in `@waypoint/core`: loads `.waypoint/config.yaml`'s `tiers.patch` globs, classifies each path as `unenforced` (patch-glob match) or `enforced` (default — no match), applies a spec file's own frontmatter `tier` as an override for that file only, and returns a single distinct config-error signal (never per-file noise) when the config is missing/empty/malformed. No CLI command — this is a pure `@waypoint/core` primitive Story 3.2 will call.

## Boundaries & Constraints

**Always:**
- Load `tiers.patch` from `.waypoint/config.yaml` once per `classifyChangedFiles` call, reusing the existing `WaypointConfig` shape from `config-defaults.ts`.
- Classify each path by matching it against every patch glob (`*` = one path segment, `**` = any number, including zero — same semantics as the four default patterns already shipped by `install`); a match → `unenforced`; no match → `enforced` (the fail-closed default).
- If the config file is missing, empty, fails to parse as YAML, or `tiers.patch` isn't an array of strings, treat the whole call as a config error: every path classifies `enforced`, and the result carries exactly one config-error message (distinct from any per-file reason), never a per-file "ambiguous" message.
- Classify a path purely as a string — glob matching never checks whether the file exists, so a deletion classifies correctly by its removed path with no special-casing.
- For a path currently existing on disk under `specs/{patches,features}/*.md` or `specs/systems/*/{prd,architecture,adr}.md`, read its frontmatter `tier` (if present and one of `patch`/`feature`/`system`) and let it override that file's own classification (`patch` → `unenforced`, `feature`/`system` → `enforced`); a path that doesn't currently exist (a deletion) skips this step entirely, since there's nothing to read.
- Never let the frontmatter-override step run for a path outside those three spec-tier locations, no matter what its content looks like.

**Ask First:** none anticipated — the classification rules are fully specified above.

**Never:**
- Implement the actual pre-commit gate, blocking behavior, or any CLI command — that's Story 3.2's job, consuming this function.
- Add a new npm dependency for glob matching — the pattern vocabulary needed (`*`, `**`, literal segments) is small enough to hand-roll, keeping `@waypoint/core`'s dependency footprint at just `yaml`.
- Populate `tiers.feature`/`tiers.system` — Epic 1 already decided only `tiers.patch` exists for MVP; this story doesn't revisit that.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Patch-glob match | Path matches a `tiers.patch` glob | Classified `unenforced` | N/A |
| No glob match (default) | Path matches no glob | Classified `enforced`, reason marks it as the default | N/A |
| Config missing/empty/malformed | `.waypoint/config.yaml` absent, empty, or `tiers.patch` not a string array | Every path classified `enforced`; exactly one config-error message, no per-file noise | N/A |
| Deletion | Path no longer exists on disk | Classified by that removed path via globs only; frontmatter step skipped | N/A |
| Rename (new path) | Classify using the file's new path and current content | Classified via globs + frontmatter (if spec-shaped) at the new location | N/A |
| Spec frontmatter override | A spec file's frontmatter `tier` differs from its path's glob classification | The frontmatter tier wins for that file only | N/A |
| Override doesn't extend to code | An ordinary file outside `specs/` happens to contain YAML-ish content with a `tier`-like field | Frontmatter is never consulted; glob classification stands | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/gate-classify.ts` (new) -- `loadPatchGlobs(repoRoot)` (reads/validates `.waypoint/config.yaml`, reusing `WaypointConfig` from `packages/core/src/config-defaults.ts:14`), a small hand-rolled `globToRegExp`/`matchesGlob` pair, `classifyChangedFiles(repoRoot, filePaths)` (the orchestrating entry point)
- `packages/core/src/index.ts` -- export `classifyChangedFiles` and its result/reason types
- `packages/core/src/gate-classify.test.ts` (new) -- unit-test all seven I/O matrix rows against a temp-dir fixture seeded via `scaffold()`/`createPatchSpec()`/`createFeatureSpec()`/`createSystemSpec()`

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/gate-classify.ts` -- write `loadPatchGlobs` (config loading + validation, distinct error messages per failure mode) -- the config-error path under test
- [x] `packages/core/src/gate-classify.ts` -- write the hand-rolled glob matcher (`*`/`**` semantics) -- the glob-matching heuristic under test
- [x] `packages/core/src/gate-classify.ts` -- write the per-path classification plus the spec-frontmatter-override step -- the actual classification behavior under test
- [x] `packages/core/src/gate-classify.ts` -- write `classifyChangedFiles` orchestrating all of the above across a batch of paths
- [x] `packages/core/src/index.ts` -- export `classifyChangedFiles` and its types
- [x] `packages/core/src/gate-classify.test.ts` -- unit-test all seven I/O matrix rows

**Acceptance Criteria:**
- Given `.waypoint/config.yaml` is valid but has zero patterns in `tiers.patch`, when any path is classified, then it's `enforced` by the normal no-match default, not a config error
- Given a batch of 10 changed paths with one config error, when `classifyChangedFiles` runs, then the single config-error message appears exactly once, not 10 times

## Design Notes

The hand-rolled glob matcher only needs to support `*` (one path segment) and `**` (any depth, including zero) — exactly what the four shipped default patterns (`specs/patches/**`, `docs/**`, `*.md`, `tasks/**`) use — so a small, fully-tested internal converter is safer and simpler than pulling in a general-purpose glob library for a vocabulary this narrow.

Whether a path currently exists on disk is the sole signal for whether the frontmatter-override step runs — no separate "is this a deletion" flag is needed from the caller. This means a rename is handled correctly for free: the caller passes the new path, which exists with real content, so the override naturally applies there and nowhere else.

## Spec Change Log

- 2026-08-21: Implemented per spec. All six tasks complete; `npm test` (202/202, including 21 new `gate-classify.test.ts` cases covering all seven I/O matrix rows and both acceptance criteria) and `npm run build` both pass. All seven I/O matrix rows independently re-verified directly against the built module: root-level `*.md` vs. non-root `nested/README.md` (correctly enforced), bare-prefix `docs`/`tasks`/`specs/patches` zero-segment matching for trailing `/**`, a real feature spec's frontmatter (`tier: patch`) correctly overriding its own otherwise-`enforced` glob classification to `unenforced`, a deleted spec-shaped path correctly skipping the override step and falling back to glob-only classification, a config-error batch of 3 paths reporting exactly one message with all three classified `enforced`, and an ordinary code file with fake `tier: patch`-shaped frontmatter content confirmed never consulted (the override never fires outside the three spec-tier locations). No boundary/constraint deviations. One implementation choice beyond the letter of the spec, noted by the implementer: the glob-to-regex converter handles `**` correctly in any slash-bounded position (not just the trailing case the four shipped defaults use), with a safe `.*` fallback for any pathological shape outside that vocabulary — a deliberate, low-risk, fully-tested robustness margin, not scope creep.

- 2026-08-21: Patch round after 3-lens review (blind-hunter, edge-case-hunter, verification-gap run in parallel against the diff since `baseline_commit`). Two lenses independently found the same real bug and a third found a closely-related one in the "beyond the letter of the spec" `**` handling praised in the previous entry's Change Log note — that note is corrected here, not retracted: the extra generality was the right call, but its implementation had two boundary-slash bugs. Original implementation subagent (`a7abac68a173d2026`) was unreachable this session, so I applied the patches directly and re-verified independently myself:
  - **Fixed `globToRegExp` in `gate-classify.ts`**: a leading `**/` (e.g. `**/gen.ts`) previously fell through to the generic `.*` fallback and never matched the zero-segment case (a root-level `gen.ts`), contradicting the documented "`**` = any number of segments, including zero" semantics — `precededBySlash` never treated the start of the pattern as a boundary. Separately, a mid-pattern `**` (e.g. `src/**/gen.ts`) previously matched a *fused* path with no separator at all (`srcgen.ts`) because the literal boundary slash was stripped from the accumulator and only reintroduced when the wildcard group matched a non-empty segment. Both are fixed by treating "start of pattern" as a boundary equal to an actual `/`, and by no longer stripping the boundary slash for the mid-pattern/leading case (only the genuinely-optional trailing-`/**` case still folds the slash into its group, since there the whole separator-plus-suffix is optional). Verified directly against the rebuilt module: `src/**/gen.ts` now correctly rejects `srcgen.ts` while accepting `src/gen.ts` and `src/a/gen.ts`; `**/leading.md` now correctly accepts `leading.md`, `x/leading.md`, and `x/y/leading.md`. The four shipped default globs (`specs/patches/**`, `docs/**`, `*.md`, `tasks/**`) are all trailing-form and untouched by this fix — confirmed by re-running the full suite (206/206) after the change.
  - **Fixed a message typo** in the `tiers.patch`-not-an-array-of-strings config error (rendered as `'.waypoint/config.yaml''s 'tiers.patch'...` — a doubled quote) by rephrasing to `'tiers.patch' in '.waypoint/config.yaml' is missing or is not an array of strings...`.
  - **Minor DRY fix**: `loadPatchGlobs` now builds its absolute config path via `path.join(repoRoot, CONFIG_RELATIVE_PATH)` instead of re-typing the literal `.waypoint/config.yaml` segments a second time.
  - **Added 4 new test cases** to `gate-classify.test.ts` (now 25 total, all passing): a leading-`**/` glob matching both the bare suffix and nested paths; a mid-pattern `**` glob proving the fused-path case is rejected while genuine nested matches still pass; a `tiers.patch` array with a mixed valid/invalid entry (`["docs/**", 42]`) correctly treated as a config error; and an override-eligible spec with an unrecognized frontmatter `tier` value (`obsolete`) correctly falling back to glob classification instead of silently winning. Also fixed the pre-existing "`*.md` only at top level" test, which asserted on only one of its two input paths — it now asserts on both.
  - Two coverage/design-contract gaps surfaced by blind-hunter (non-parallelized per-file frontmatter reads; no documented caller contract for a rename's vacated old path) plus a few "no test for X" observations that don't correspond to any actual defect (BOM-prefixed frontmatter, `EISDIR`/`EACCES`-specific config error messages, `architecture.md`/`adr.md` override coverage) were deferred or rejected rather than patched — see `deferred-work.md` for the two genuine defer entries; the rest were noise relative to this story's narrow scope and are not tracked further.
  - Re-verified after patching: `npm test` (206/206), `npm run build` (clean), and a fresh manual smoke test against the rebuilt `dist/gate-classify.js` covering both fixed glob shapes plus all four shipped defaults (unaffected).

## Suggested Review Order

**Glob matching (the trickiest logic, and the one the review round fixed)**

- Entry point: converts one `*`/`**` glob into an anchored regex — start here to see the boundary-slash fix.
  [`gate-classify.ts:150`](../../packages/core/src/gate-classify.ts#L150)

- Both a leading `**/` and a mid-pattern `**` now treat the pattern start as a real boundary, closing the false-negative gap.
  [`gate-classify.ts:162`](../../packages/core/src/gate-classify.ts#L162)

- The boundary slash is deliberately left in `pattern` here (not folded into the group) so mid-pattern `**` can't fuse across a missing separator.
  [`gate-classify.ts:166`](../../packages/core/src/gate-classify.ts#L166)

- Trailing `/**` stays a separate, narrower branch — the separator itself is the optional part here, unlike the case above.
  [`gate-classify.ts:179`](../../packages/core/src/gate-classify.ts#L179)

- Regression coverage for both fixed boundary cases, run directly against the rebuilt module during re-verification.
  [`gate-classify.test.ts:332`](../../packages/core/src/gate-classify.test.ts#L332)

**Config loading and the single config-error guarantee**

- Loads and validates `tiers.patch`, returning one of four distinct error messages rather than letting a raw fs/YAML error escape.
  [`gate-classify.ts:83`](../../packages/core/src/gate-classify.ts#L83)

**Frontmatter override and its scope boundary**

- Parses just the `tier` field out of a spec's frontmatter, falling back to `null` for anything malformed or unrecognized.
  [`gate-classify.ts:257`](../../packages/core/src/gate-classify.ts#L257)

- Gates the override to the three spec-tier locations and to files that currently exist, so deletions and ordinary code are never misread.
  [`gate-classify.ts:289`](../../packages/core/src/gate-classify.ts#L289)

**Orchestration**

- Ties config loading, glob matching, and the override step together into one pass over the batch.
  [`gate-classify.ts:337`](../../packages/core/src/gate-classify.ts#L337)

**Peripherals**

- The two-export addition making `classifyChangedFiles` and its types part of `@waypoint/core`'s public surface.
  [`index.ts:56`](../../packages/core/src/index.ts#L56)

## Verification

**Commands:**
- `npm test` -- expected: all `gate-classify.test.ts` cases pass, covering all seven I/O matrix rows and both acceptance criteria

**Manual checks (if no CLI):**
- In a Node REPL against `packages/core/dist`, call `classifyChangedFiles(repoRoot, ['specs/patches/foo.md', 'src/bar.ts'])` against a real installed scratch repo and confirm the first classifies `unenforced` and the second `enforced`
