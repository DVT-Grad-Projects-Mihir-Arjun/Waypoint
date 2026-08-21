---
title: 'Story 2.1: Update spec via delta'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: '37e9137e2f02a6733989303f6789963801ae4c4d'
review_loop_iteration: 1
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Feature/System specs can only be created, never evolved — a small requirement change forces a full rewrite instead of a lightweight, auditable edit.

**Approach:** Implement `waypoint update <spec-id>`. Every invocation does two things in one pass: first, it syncs any already-filled-in `### ADDED` bullets (from a delta the human/agent has since hand-edited) into the ledger as new `pending` tasks, skipping any whose text already matches an existing task's description; then, only if the most recently appended delta block is not still completely empty, it appends a fresh, empty `## Delta — <date>` block (disambiguated if one was already appended today) for the human/agent to fill in next — a true no-op re-run reuses the existing empty heading instead of littering another one. No editor is spawned — this CLI never blocks on interactive input, matching every other command's design; "fill in" happens with the human/agent's own tools, and the next `waypoint update` run is what picks the change up.

## Boundaries & Constraints

**Always:**
- Locate `<spec-id>` by searching every spec file's frontmatter `id` field across all three tiers (`specs/patches/*.md`, `specs/features/*.md`, `specs/systems/*/prd.md`) — not by parsing the id string into a path. If none match, error naming the missing spec-id, before writing anything.
- If the matched spec's frontmatter `tier` is `patch`, error — patch tier has no ledger to sync into and isn't supported by `update` for MVP.
- Sync pass: scan the spec's full markdown body for every `### ADDED` subsection under any `## Delta — ...` heading (not just today's); for each bullet line whose trimmed text doesn't already exactly match an existing ledger task's `description`, append a new ledger row (next available `t<N>` id, `status: pending`, `linked_commit: null`, `verified_by_gate: false`; System-tier rows default `phase: 1`, since a delta has no phase markup to say otherwise).
- Scaffold pass: after syncing, look at the most recently appended `## Delta — ...` heading in the spec's body. If none exists yet (first run ever), append one. If one exists and already has content in at least one of its three subsections, append a fresh `## Delta — <date>` heading (disambiguated with `(2)`, `(3)`, etc. if one for today already exists). If the most recent heading exists but is still completely empty, leave it as-is — never append a second heading while the most recent one is untouched.
- Never modify the spec's frontmatter — `status`, `approved_by`, `approved_at` must be byte-identical before and after.

**Ask First:** none anticipated — the two-pass (sync-then-scaffold) design is fully specified above.

**Never:**
- Sync `### MODIFIED`/`### REMOVED` content into the ledger — those stay a manual human/agent judgment call for MVP, per `epics.md`'s own AC.
- Spawn `$EDITOR` or any interactive/blocking prompt.
- Implement concurrent-invocation locking for `update` — a real gap (two concurrent runs on the same spec could interleave), but out of scope for this story; note it for `deferred-work.md` if review confirms it's worth tracking.
- Touch `gate()`, `waypoint verify`/`approve`, or CI — Epic 3's scope.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Spec not found | `<spec-id>` matches no spec's frontmatter `id` | Errors naming the missing spec-id | Clear message, no filesystem write |
| Patch-tier spec-id | `<spec-id>` resolves to a patch-tier spec | Errors, no write | Clear message: patch tier unsupported |
| First run, nothing to sync | Feature/System spec, no unsynced `ADDED` content anywhere | New delta heading appended; ledger untouched | N/A |
| Sync picks up hand-filled content | A prior delta's `ADDED` section now has a bullet not yet in the ledger | New `pending` row appended (description matches the bullet exactly) plus a new delta heading appended | N/A |
| Idempotent re-run | Same bullet text already present as a ledger task's `description` | Not re-added; only the new delta heading is appended | N/A |
| No-op re-run reuses empty heading | `update` run again with the most recent delta heading still completely empty | No new heading appended; the existing empty one is left as-is | N/A |
| Second run same day, after content was added | The most recent delta heading (today's) now has content in at least one subsection | New heading gets a `(2)`-style suffix | N/A |
| System-tier sync | `ADDED` bullet synced for a System-tier spec | New row includes `phase: 1` | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/update-spec.ts` -- `findSpecById(cwd, specId)` (search + frontmatter match across `specs/{patches,features}/*.md` and `specs/systems/*/prd.md`, duplicate-id detection), `parseDeltaBlocks(body)` (ordered `## Delta — ...` blocks with per-subsection bullets, used by both the sync pass and the reuse-vs-append scaffold-pass decision), `readLedger(ledgerPath)`, `updateSpec(cwd, specId)` (sync pass + scaffold pass); reuses the `yaml` `stringify()`/`parse()` pattern from `packages/core/src/templates/feature-ledger.ts:31` and `packages/core/src/new-spec.ts:143` (`isValidName`-style small helpers)
- `packages/core/src/index.ts` -- export `updateSpec`, `SpecNotFoundError`, `PatchTierUpdateNotSupportedError`, `DuplicateSpecIdError`, `LedgerNotFoundError`, `UpdateSpecResult`
- `packages/cli/src/commands/update.ts` (new) -- thin handler mirroring `new-feature.ts`'s try/catch → clean exit-code pattern (`packages/cli/src/commands/new-feature.ts:19`)
- `packages/cli/src/program.ts` -- register `update <spec-id>`
- `packages/core/src/update-spec.test.ts` (new) -- unit-test all seven I/O matrix rows against a temp-dir fixture (`scaffold()` + `createFeatureSpec()`/`createSystemSpec()` to seed real specs, same pattern as `new-spec.test.ts:1`)
- `packages/cli/src/update.test.ts` (new) -- CLI exit-code contract; `install.test.ts` has grown large enough across four commands that a fifth belongs in its own file

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/update-spec.ts` -- write `findSpecById` -- locates the target spec regardless of tier or filename, without parsing the id string
- [x] `packages/core/src/update-spec.ts` -- write `updateSpec`'s sync pass (parse `### ADDED` bullets across all deltas, diff against the ledger, append missing rows) -- the actual delta→ledger behavior under test
- [x] `packages/core/src/update-spec.ts` -- write `updateSpec`'s scaffold pass (today's heading, disambiguation) -- the other half of every invocation
- [x] `packages/core/src/index.ts` -- export `updateSpec` and its error types
- [x] `packages/cli/src/commands/update.ts` + `packages/cli/src/program.ts` -- wire `waypoint update <spec-id>` to `updateSpec`
- [x] `packages/core/src/update-spec.test.ts` -- unit-test all seven I/O matrix rows
- [x] `packages/cli/src/update.test.ts` -- exit-code contract for `update`'s error paths plus a clean-run test

**Acceptance Criteria:**
- Given a spec with an `approved` status, when `update` runs, then `status`/`approved_by`/`approved_at` are byte-identical afterward
- Given a delta whose `MODIFIED`/`REMOVED` sections are filled in but `ADDED` is empty, when `update` runs, then no ledger rows are added

## Spec Change Log

- 2026-08-21: Implemented per spec. Added `packages/core/src/update-spec.ts` (`findSpecById`, `updateSpec`, `SpecNotFoundError`, `PatchTierUpdateNotSupportedError`, `UpdateSpecResult`), re-exported from `packages/core/src/index.ts`; added `packages/cli/src/commands/update.ts` and wired `waypoint update <spec-id>` in `packages/cli/src/program.ts`. `findSpecById` reads and frontmatter-matches every candidate file across all three tiers (never parses the id string into a path) and tolerates unrelated malformed spec files elsewhere. `updateSpec` preserves the spec's frontmatter block as a raw, unparsed, byte-identical substring, syncs only `### ADDED` bullets (scanned across every `## Delta — ...` heading in the body, not just today's) into new `pending` ledger rows (next `t<N>` id; `phase: 1` added for System tier) skipping any whose trimmed text already matches an existing task's `description`, then always appends a fresh empty `## Delta — <date>` block, disambiguating same-day re-runs with `(2)`, `(3)`, etc. `npm test` (123/123, including 13 new `update-spec.test.ts` cases covering all seven I/O matrix rows plus both acceptance criteria, and 6 new CLI cases in `update.test.ts`) and `npm run build` both pass. Manually re-verified end-to-end in a scratch temp dir via the built CLI: first run scaffolds an empty delta with untouched ledger; hand-filling an `ADDED` bullet and re-running syncs exactly one new `pending` row and appends a second same-day heading disambiguated `(2)`; a third same-day run disambiguates `(3)`; a patch-tier spec-id errors with no write; an unknown spec-id errors with no write; frontmatter (`status`/`approved_by`/`approved_at`) verified byte-identical (via `head`) across all three runs. No boundary/constraint deviations. `docs/architecture.md`'s "Ledger sync on delta" cross-document inconsistency was already corrected to v0.6 prior to this implementation pass (per this spec's own Design Notes), so no further doc fix was needed. Concurrent-invocation locking for `update` remains unimplemented per this story's explicit "Never" list; flagging it for `deferred-work.md` as noted there.
- 2026-08-21: Review (blind-hunter, edge-case-hunter) found that always appending a fresh delta heading — even on a true no-op re-run with nothing new to sync — litters the spec with empty headings. Human confirmed the fix: the scaffold pass now only appends a new heading when the most recently appended one already has content in at least one subsection; a heading that's still completely empty is reused instead. Amended the frozen Boundaries' scaffold-pass bullet and the I/O matrix (added a "no-op re-run reuses empty heading" row, reworded the same-day-disambiguation row) accordingly. KEEP: the sync pass, frontmatter byte-identity guarantee, and every other already-implemented behavior are unchanged. Re-implementing this change next, alongside 8 additional patch-level findings from the same review round.
- 2026-08-21: Applied the design change plus all 8 mechanical findings from the review round above. `packages/core/src/update-spec.ts`: (1) scaffold pass now parses the body into ordered `## Delta — ...` blocks (`parseDeltaBlocks`) and reuses the most recent one verbatim (`deltaHeadingReused: true` in the new `UpdateSpecResult` field, no spec-file write at all) when it's still completely empty across all three subsections, appending fresh (with existing disambiguation) only otherwise or on a true first run; (2) removed the unused `existsSync` import; (3) added `LedgerNotFoundError`, thrown by a new `readLedger()` helper when the ledger file can't be read or doesn't parse to an object with a `tasks` array, replacing the previous raw `readFile`/`parse` calls; (4) added `SPEC_ID_SHAPE_PATTERN` (`^(patch|feat|system)-\d{4}-\d{2}-\d{2}-...$`) checked against `found.id` before it's used to build `ledgerPath`, throwing `SpecNotFoundError` on a shape mismatch instead of letting a corrupted/adversarial id reach a path join; (5) `parseFrontmatterIdAndTier` now only accepts `tier` values of exactly `patch`/`feature`/`system`, treating anything else as a non-match (`null`) the same as other malformed frontmatter; (6) `findSpecById` now scans every candidate (never returns early) and throws a new `DuplicateSpecIdError` naming every colliding path when more than one file shares an `id`; (7) the bullet regex (`BULLET_LINE_PATTERN`) now accepts `-`, `*`, or `+` markers; (8) `DELTA_HEADING_PATTERN` now accepts an em dash, en dash, or plain hyphen when *parsing* a heading (generation via `nextDeltaHeading` still always emits the canonical em dash). `LedgerNotFoundError`/`DuplicateSpecIdError` are re-exported from `packages/core/src/index.ts` and handled by `packages/cli/src/commands/update.ts`'s domain-error branch alongside the existing two; the CLI's success message now also distinguishes "reused existing empty delta" from "appended" per the design change. Test changes: rewrote the stale "second run same day" test (which asserted the old always-append behavior) into two tests matching the amended I/O matrix rows ("no-op re-run reuses empty heading" and "second run same day, after content was added"); added a feature-tier `not.toHaveProperty('phase')` assertion (finding 9); added coverage for `DuplicateSpecIdError`, both `LedgerNotFoundError` triggers (missing file, malformed YAML shape), the corrupted-id-shape-treated-as-not-found path, the tier-validation-tolerance path, broadened bullet markers, and broadened dash-character heading recognition, in `update-spec.test.ts`; in the CLI's `update.test.ts`, replaced the now-stale "non-domain failure" test (deleting the ledger is a domain error now) with a dedicated ledger-missing domain-error test plus a mock-based test (mirroring `new-spec.test.ts`'s `writeFile`-passthrough pattern, applied here to `readFile`) that still exercises the true generic-fallback branch by failing only the second read of the spec path, and added a no-op-reuse CLI message test. `npm test`: 133/133 (21 `update-spec.test.ts` + 8 `update.test.ts`, up from 13/6). `npm run build` and a manual scratch-dir CLI run both re-verified: three consecutive no-edit `update` runs leave exactly one delta heading in the file (bodies byte-identical across all three); filling in the heading's `ADDED` section and re-running syncs the bullet and appends heading `(2)`; a further no-edit run reuses `(2)` without appending a third; patch-tier and unknown-spec-id error paths still exit non-zero with no write. No further boundary/constraint deviations found.

## Design Notes

`docs/architecture.md` says `waypoint update` "opens it for editing" — read as prose describing the human/agent's own next step, not a literal instruction to spawn `$EDITOR`: every other command in this CLI is non-interactive and script/agent-safe, and blocking on an interactive editor would break exactly that property. The sync-then-scaffold design resolves the apparent tension between "a second delta gets disambiguated" (implying a run can append fresh) and "once filled in, syncs" (implying some later run must pick up prior edits) — each invocation both harvests whatever's newly filled in *and* leaves a fresh block for the next edit when the last one has already been used, with idempotent description-matching making repeated runs safe. The heading is only appended fresh once the prior one has real content, avoiding empty-heading litter on a true no-op re-run (amended after review — see Spec Change Log).

Fixed a cross-document inconsistency while researching this spec: `docs/architecture.md`'s "Ledger sync on delta" said `ADDED`/`MODIFIED` content both sync, contradicting `epics.md`'s explicit AC that only `ADDED` does — corrected `architecture.md` (now v0.6) to match the AC.

## Verification

**Commands:**
- `npm test` -- expected: all `update-spec.test.ts` and `update.test.ts` cases pass, covering all seven I/O matrix rows
- `npm run build && node packages/cli/dist/index.js update <spec-id>` (against a feature/system spec created via `new-feature`/`new-system` in an installed scratch temp directory) -- expected: exits 0, delta heading appended, ledger synced if applicable

**Manual checks (if no CLI):**
- Hand-edit a created feature spec's `### ADDED` section with a new bullet, run `update` again, and inspect the ledger by eye to confirm exactly one new `pending` row was appended

## Suggested Review Order

**Core update logic**

- Entry point: locate → validate tier/id-shape → sync pass → scaffold pass, with the frontmatter carried through byte-identical.
  [`update-spec.ts:486`](../../packages/core/src/update-spec.ts#L486)

- `parseDeltaBlocks` is the shared parser behind both the sync pass and the reuse-vs-append decision — the load-bearing piece of this story's design.
  [`update-spec.ts:319`](../../packages/core/src/update-spec.ts#L319)

- The reuse-vs-append branch: no spec-file write at all when the most recent delta is still empty.
  [`update-spec.ts:538`](../../packages/core/src/update-spec.ts#L538)

- `findSpecById`'s cross-tier search, including duplicate-id detection.
  [`update-spec.ts:239`](../../packages/core/src/update-spec.ts#L239)

- `readLedger` turns a raw `ENOENT`/parse failure into a clean domain error.
  [`update-spec.ts:432`](../../packages/core/src/update-spec.ts#L432)

**CLI wiring**

- Thin handler; success message distinguishes "reused" from "appended".
  [`update.ts:19`](../../packages/cli/src/commands/update.ts#L19)

**Tests**

- Full `updateSpec`/`findSpecById` matrix, including the no-op-reuse and same-day-disambiguation-after-content rows.
  [`update-spec.test.ts:1`](../../packages/core/src/update-spec.test.ts#L1)

- CLI exit-code contract, including the four domain-error branches and the real `createProgram()`/`parseAsync` wiring test.
  [`update.test.ts:1`](../../packages/cli/src/update.test.ts#L1)
