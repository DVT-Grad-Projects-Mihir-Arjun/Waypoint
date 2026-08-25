---
title: 'Story 3.4: Human-only approval'
type: 'feature'
created: '2026-08-24'
status: 'done'
baseline_commit: '3c582bc0668084cbbad36a27498e9ea2ab286225'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing yet moves a Feature/System-tier spec from `draft` to `approved` — the approval gate FR8 requires has no mechanism at all yet.

**Approach:** Implement `waypoint approve <spec-id>`: for Feature tier, sets `status: approved` plus a timestamp and (if resolvable) an identity, once, idempotently. For System tier, records each phase boundary's approval as its own distinct entry (not a single spec-wide flag), flipping `status: approved` only once every phase the ledger tracks has one.

## Boundaries & Constraints

**Always:**
- `approveSpec(cwd, specId): Promise<ApproveResult>` locates the spec via `update-spec.ts`'s existing `findSpecById` (export it for reuse — it already searches all three tiers by frontmatter `id` and already throws `DuplicateSpecIdError` on a collision). Not found → let the existing, generic `SpecNotFoundError` propagate (reuse it directly, it's not `update`-specific). Patch tier → throw a new `PatchTierApprovalNotSupportedError` (a new class, mirroring `PatchTierUpdateNotSupportedError`'s shape but with its own accurate message — that existing class's message says "isn't supported by 'update'," which would be misleading here).
- Every write is a targeted, line-level replacement within the frontmatter block only — never a full parse-and-`yaml.stringify()` round-trip — so everything else in the file (body, comments, key order, whitespace) round-trips byte-for-byte. Export and reuse `update-spec.ts`'s existing `splitFrontmatter` (isolates the frontmatter block from the body as a raw substring) rather than re-deriving the same byte-fidelity logic a second time.
- `approved_at` is always set to today's local calendar date (matching `update-spec.ts`'s own `todayIsoDate()` — reuse it) on every approval this story records, feature or per-phase. `approved_by` is attempted via `git config user.name` (shelled safely, e.g. `execFileSync`, never throwing — any failure, including git not installed or no config set, just leaves it `null`) — the AC only requires identity be recorded "optionally."
- **Feature tier:** if `status` is already `'approved'`, no-op (report already-approved, no write). Otherwise, replace `status: draft` → `status: approved`, `approved_by: null` → `approved_by: <value-or-null>`, `approved_at: null` → `approved_at: <today>` within the frontmatter block.
- **System tier:** read the matching ledger (`tasks/<id>.ledger.yaml`) to find the full set of distinct `phase` numbers across its tasks — this is the existing source of truth for "how many phase boundaries exist," not a new one. Read (or, if absent — a spec scaffolded before this story shipped — treat as empty and insert fresh) a `phase_approvals` frontmatter array of `{ phase, approved_by, approved_at }` entries. If every distinct phase already has an entry, no-op (already-approved). Otherwise, approve the lowest-numbered phase that doesn't yet have one: append its entry. If that was the last remaining phase, additionally set the top-level `status: approved`/`approved_by`/`approved_at` (mirroring Feature tier's final state) in the same write.
- If a required frontmatter line can't be located via the targeted-replacement pattern (e.g. a field was hand-deleted), that's a clear error naming the spec and the missing field — never a partial or corrupted write.
- CLI: `waypoint approve <spec-id>`, registered in `program.ts` alongside the other subcommands.

**Ask First:** none anticipated — the per-phase schema (a new `phase_approvals` array, keyed off the ledger's existing `phase` field rather than a new phase-count mechanism) is a single coherent design with no simpler alternative, not a multi-way fork.

**Never:**
- Touch `AGENTS.md` or build any agent-exclusion mechanism — Epic 4 Story 4.1's job. This story's own "not agent-callable" guarantee is a documentation-layer convention that doesn't exist until that story ships; epics.md calls this out explicitly as a known, time-boxed interim gap, not something to paper over here.
- Commit `approve`'s own change to git. Unlike `verify`, there's no commit-linkage precision to get right here — the human commits the updated spec file as part of their normal workflow, and per Story 3.2's design a Feature/System-tier spec file is already its own gate delta, so no special handling is needed for that either.
- Add a new npm dependency for git-identity lookup — shell to `git config user.name` directly, matching this codebase's established zero-added-dependency pattern.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Feature spec, draft | `status: draft` | `status: approved`, `approved_at` set, `approved_by` set if resolvable | N/A |
| Unknown spec-id | No spec matches | Errors naming the missing id | N/A |
| Patch-tier spec | `tier: patch` | Errors — patch tier has no approval concept | N/A |
| Feature spec, already approved | `status: approved` | No-op, reports already-approved | N/A |
| System spec, first phase boundary | No `phase_approvals` entries yet, 2 phases in the ledger | Phase 1 recorded as its own entry; `status` stays `draft` | N/A |
| System spec, final phase boundary | Phase 1 already recorded, this is the last remaining phase | Phase 2 recorded; `status` flips to `approved` in the same write | N/A |
| System spec, all phases already approved | Every distinct ledger phase has an entry | No-op, reports already-approved | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/update-spec.ts` -- export `findSpecById`/`FoundSpec` (already `export`-marked, just not re-exported through `index.ts`), `splitFrontmatter`, and `todayIsoDate` for reuse; `SpecNotFoundError`/`DuplicateSpecIdError` are already exported and directly reusable as-is (line ~40, ~75)
- `packages/core/src/templates/system.ts` -- `renderSystemPrd` (line 44) needs one additive line: `phase_approvals: []` in the frontmatter, alongside the existing `approved_by`/`approved_at: null` pair
- `packages/core/src/approve.ts` (new) -- `PatchTierApprovalNotSupportedError`, the targeted frontmatter-replacement helpers, and `approveSpec(cwd, specId): Promise<ApproveResult>`
- `packages/core/src/index.ts` -- export `approveSpec`, `PatchTierApprovalNotSupportedError`, `ApproveResult`, plus the newly-exported `findSpecById`/`FoundSpec`/`splitFrontmatter`/`todayIsoDate` from `update-spec.ts`
- `packages/core/src/approve.test.ts` (new) -- unit-test all seven I/O matrix rows against real temp-dir fixtures (real specs via `createFeatureSpec`/`createSystemSpec`, real ledgers)
- `packages/cli/src/commands/approve.ts` (new) -- thin CLI wrapper mapping `ApproveResult`'s outcomes to a message + exit code
- `packages/cli/src/program.ts` -- register `approve <spec-id>`
- `packages/cli/src/approve.test.ts` (new) -- CLI wiring/exit-code tests

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/update-spec.ts` -- export `findSpecById`, `splitFrontmatter`, `todayIsoDate` -- lets `approve` reuse the existing spec-location and byte-fidelity logic instead of duplicating it
- [x] `packages/core/src/templates/system.ts` -- add `phase_approvals: []` to `renderSystemPrd`'s frontmatter
- [x] `packages/core/src/approve.ts` -- implement `approveSpec` and its error class -- the core mechanism
- [x] `packages/core/src/index.ts` -- export the new and newly-shared symbols
- [x] `packages/core/src/approve.test.ts` -- unit-test all seven I/O matrix rows
- [x] `packages/cli/src/commands/approve.ts` -- implement the CLI wrapper
- [x] `packages/cli/src/program.ts` -- register the `approve` subcommand
- [x] `packages/cli/src/approve.test.ts` -- CLI wiring/exit-code tests

**Acceptance Criteria:**
- Given a spec approved via this command, when the spec file is inspected afterward, then every byte outside the specific fields this story writes is unchanged from before (verified by diffing the full file content, not just checking the changed fields in isolation)
- Given `approve`'s documented enforcement boundary, when it's checked against `AGENTS.md`, then nothing in this story's own output or behavior claims a technical block against direct agent invocation — the convention-only nature of the guarantee is exactly as epics.md describes, not oversold

## Spec Change Log

- 2026-08-24: Implemented per spec. All eight tasks complete; `npm test` (14 new core `approve.test.ts` cases plus 9 new CLI cases) and `npm run build` both passed. Before dispatching to review, I independently verified the mechanism with my own manual script against the built module (not just the automated suite): a Feature-tier approval with an apostrophe-containing git identity ("Jane O'Brien") round-trips correctly, zero git commits are made by `approve` itself, a re-run is a genuine no-op, and a two-phase System-tier sequence produces the correct `phase_approvals` array with the status flip landing only on the final phase.

- 2026-08-24: Patch round after 3-lens review (blind-hunter, edge-case-hunter, verification-gap) run against the diff. All three lenses returned real findings; six were patched, the rest deferred to `deferred-work.md` as adversarial-input-only or low-value-relative-to-cost:
  - **`SPEC_ID_SHAPE_PATTERN` was wrongly applied to both tiers (blind-hunter).** The guard exists to stop a corrupted/adversarial `id` from escaping `tasks/` when System tier builds a ledger path from it — Feature tier never builds a filesystem path from `found.id` at all, so applying the same guard there would wrongly reject a legitimately-located Feature spec whose hand-edited id simply doesn't match the usual `<tier>-<date>-<name>` shape. Scoped the guard to System tier only, in `approveSpec` right before dispatching to `approveSystemSpec`.
  - **No timeout on the `git config user.name` shell-out (edge-case-hunter), inconsistent with `verify.ts`/`gate.ts`'s own bounded git plumbing calls elsewhere in this codebase.** Added a 3-second `timeout` to `resolveApprovedBy`'s `execFileSync` call so a hung git invocation degrades to `null` instead of blocking the whole command.
  - **Re-approving a spec after `status` is already `'approved'` would throw instead of gracefully recording a new phase (edge-case-hunter).** If a hand-edited ledger (or a future sync path) introduces a "new" remaining phase after the spec's top-level fields were already flipped, `applyTopLevelApproval`'s `status: draft` line-match would fail, since that line no longer exists. Fixed `approveSystemSpec` to only re-flip the top-level fields when `isLastPhase && fm.status !== 'approved'`; otherwise it just appends the new phase's entry and reports `statusApproved: true` without re-touching already-approved fields.
  - **A ledger with zero phase-tagged tasks was silently treated identically to "every phase already approved" (blind-hunter and edge-case-hunter, independently).** That produced a permanently misleading no-op report for a spec that could never actually become approvable, with no diagnostic. Added a new `NoPhaseTrackedTasksError`, thrown distinctly from the genuine already-approved case.
  - **CLI message-prefix inconsistency for the hand-edited-field error (blind-hunter).** The "frontmatter field not found" failure was a bare `Error`, so the CLI's generic catch-all gave it a different prefix (`Error: `) than every other known `approve` failure (`waypoint approve: `). Added a proper `FrontmatterFieldNotFoundError` class (mirroring `PatchTierApprovalNotSupportedError`'s shape) and registered it in the CLI's known-error branch.
  - **Two real, confirmed test-coverage gaps from verification-gap.** (1) The `upsertPhaseApprovalsLine` "insert fresh line" backward-compatibility branch, meant for a System-tier spec scaffolded before this story shipped, was never exercised — every existing fixture already includes `phase_approvals: []` via `createSystemSpec`'s current template. Added a hand-written pre-3.4 fixture test proving the fresh-insert path and byte-fidelity elsewhere in the file. (2) The YAML-escaping path (`yamlScalar`/`renderPhaseApprovalsLine`, both `JSON.stringify`-based specifically so special characters round-trip safely) was only loosely asserted (`null`-or-`typeof string`), never with an actual special-character value — a real escaping regression could have shipped undetected. Added deterministic tests using a real `git init`'d fixture with `user.name` set to `O'Brien: Test`, for both Feature tier's flat `approved_by` and a System-tier `phase_approvals` entry.
  - **Added a network-surface-neutrality test for `approveCommand`** mirroring `gate.test.ts`'s/`verify.test.ts`'s existing pattern (both also legitimately shell to git, so neither is part of `vendor-neutrality.test.ts`'s "zero `child_process` calls" test) — spies on http/https/fetch/net.connect and confirms none are called while git is legitimately shelled to.
  - Six findings deferred to `deferred-work.md`, all requiring a hand-corrupted or adversarial input to reach: `parseFrontmatterObject`'s silent YAML-parse-error swallowing, `readPhaseApprovals`'s silent drop of malformed entries (data lost on rewrite), a hand-typed `.nan` phase value breaking the sort comparator, the `findSpecById`-to-re-read TOCTOU window (matches an already-accepted pattern elsewhere in this codebase), a missing-`approved_at` entry persisting the literal string `"undefined"`, and `LedgerNotFoundError` being reused for three distinct failure shapes. One finding (the asymmetric YAML quoting of `approved_at` vs. `approved_by`) was rejected outright after I confirmed empirically, with a direct Node script against the actual `yaml` package in use, that it does not auto-coerce an unquoted ISO date string into a `Date` — a non-issue with this dependency as used.
  - Re-verified after every fix: `npm test` (16 test files, 300 tests, 0 failures), `npm run build` (clean). I independently re-read the full diff of `approve.ts` line by line against each of the six patches before accepting the report, rather than relying on the implementer's self-report alone.

## Design Notes

The per-phase schema (`phase_approvals: [{ phase, approved_by, approved_at }]` on System tier's `prd.md`) isn't pinned anywhere in `docs/architecture.md` or `epics.md` — both describe "repeated `waypoint approve` calls across the System spec's phase boundaries" without specifying a data shape. Resolved by reusing the ledger's already-established `phase: number` field (Story 1.3) as the source of truth for how many phase boundaries exist, rather than inventing a second, parallel phase-count mechanism — a spec-approval record belongs in the committed spec file itself (unlike `.gate-state`, which is explicitly machine-local, gitignored tamper-detection state, not legitimate spec metadata).

`approved_by` resolution via `git config user.name` is a best-effort convenience, not an identity/auth system — this tool has none, and the AC's "optionally" already anticipates it may be unavailable.

## Suggested Review Order

**The core mechanism**

- `approveSpec` — entry point; locates the spec, rejects patch tier, and applies the System-tier-only id-shape guard before dispatching.
  [`approve.ts:563`](../../packages/core/src/approve.ts#L563)

- `approveFeatureSpec` — the one-shot flip, or the already-approved no-op.
  [`approve.ts:283`](../../packages/core/src/approve.ts#L283)

- `approveSystemSpec` — the per-phase mechanism; the `isLastPhase && fm.status !== 'approved'` guard on line ~519 is the load-bearing fix from this round's review, closing the "new phase after already-approved" throw.
  [`approve.ts:459`](../../packages/core/src/approve.ts#L459)

**New error classes from this round's review**

- `NoPhaseTrackedTasksError` — distinguishes an empty/corrupted ledger from the genuine already-approved no-op.
  [`approve.ts:83`](../../packages/core/src/approve.ts#L83)

- `FrontmatterFieldNotFoundError` — replaces the bare `Error` the hand-edited-field case used to throw, giving the CLI a consistent message prefix.
  [`approve.ts:61`](../../packages/core/src/approve.ts#L61)

**Regression tests added in this round**

- The re-approval-after-already-approved test — the scenario the `isLastPhase && fm.status !== 'approved'` fix exists for.
  [`approve.test.ts:395`](../../packages/core/src/approve.test.ts#L395)

- The zero-phase-tagged-tasks test proving `NoPhaseTrackedTasksError` is distinct from the already-approved no-op.
  [`approve.test.ts:355`](../../packages/core/src/approve.test.ts#L355)

- The pre-3.4-scaffold backward-compatibility test for `upsertPhaseApprovalsLine`'s fresh-insert branch.
  [`approve.test.ts:260`](../../packages/core/src/approve.test.ts#L260)

- The deterministic special-character git-identity round-trip tests (Feature tier's flat field, and a System-tier `phase_approvals` entry).
  [`approve.test.ts:90`](../../packages/core/src/approve.test.ts#L90) / [`approve.test.ts:241`](../../packages/core/src/approve.test.ts#L241)

- The Feature-tier non-standard-id test proving the id-shape guard's new System-only scoping.
  [`approve.test.ts:482`](../../packages/core/src/approve.test.ts#L482)

**Peripherals**

- `resolveApprovedBy`'s added `timeout`.
  [`approve.ts:163`](../../packages/core/src/approve.ts#L163)

## Verification

**Commands:**
- `npm test` -- expected: all new `approve.test.ts` cases (core + CLI) pass, covering all seven I/O matrix rows
- `npm run build` -- expected: clean

**Manual checks (if no CLI):**
- In a real scratch repo: `waypoint new-feature demo`, `waypoint approve feat-<date>-demo` — confirm `status: approved` plus a timestamp landed with the rest of the file unchanged; run it again and confirm a no-op. `waypoint new-system demo2`, `waypoint approve system-<date>-demo2` twice — confirm phase 1 then phase 2 are each recorded distinctly, with `status` flipping to `approved` only after the second call.
