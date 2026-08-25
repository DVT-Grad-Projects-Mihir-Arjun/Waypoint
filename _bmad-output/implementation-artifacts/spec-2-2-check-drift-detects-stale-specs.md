---
title: 'Story 2.2: check-drift detects stale specs'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: '5cafe60661d8e7159c706f94a01f61cc02ff2f5b'
review_loop_iteration: 1
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A spec's referenced file paths and named functions/classes can silently go stale as the codebase evolves, misleading a human or agent who trusts the spec's claims.

**Approach:** Implement `waypoint check-drift` (no arguments): scan every `approved`/`in-progress` spec (per `docs/architecture.md`'s own scope — `draft` and `done` are excluded) for backtick-delimited path/symbol references, flag any that no longer resolve, and exit non-zero if anything's flagged (zero otherwise) so it's usable as a CI job independent of the commit-time gate.

## Boundaries & Constraints

**Always:**
- Scan every spec file (`specs/patches/*.md`, `specs/features/*.md`, `specs/systems/*/prd.md` plus that system's `architecture.md`/`adr.md`) whose frontmatter `status` is exactly `approved` or `in-progress`; skip `draft` and `done` — status is the only filter, no tier exclusion needed (patch specs are always `draft` today, so they're excluded naturally).
- Classify each backtick-delimited (`` `...` ``) token in a scanned body as a candidate reference: **path-like** if it contains `/` (and isn't a URL — a token containing `://` is never a reference at all) or matches a bare `<name>.<ext>` shape (e.g. `` `package.json` ``, but not a pure decimal like `` `1.0` ``); **symbol-like** (checked only if not path-like) if it matches `identifier()` (e.g. `` `refreshToken()` ``) or genuine multi-hump `PascalCase` — at least two capitalized segments (e.g. `UserSession`, `FoundSpec`), not a single capitalized word or acronym (`Given`, `TODO`, `JSON`) — per FR5's "functions/classes referenced by name." A token matching neither is not a reference and is ignored — this is what keeps ordinary backticked words (`` `null` ``, `` `pending` ``, BDD keywords, acronyms) from becoming false positives.
- For a path-like candidate: strip a trailing `:<line>` suffix if present, then check it exists relative to the repo root — an absolute path or one containing a `..` segment never resolves (treated as stale, not probed against the real filesystem).
- For a symbol-like candidate: strip a trailing `()` if present, then do a repo-wide, word-boundary, case-sensitive text search (excluding `.git`, `node_modules`, `dist`, `.waypoint`, and — as a resolution-algorithm detail, not a fifth excluded directory — the exact file the reference was extracted from, since otherwise the reference's own backtick occurrence would always trivially "find" itself and no symbol could ever be flagged as stale) — no AST/language-aware parsing, per FR5's explicit MVP scope.
- Exit non-zero if any reference across any scanned spec fails to resolve; exit zero otherwise, including when there's nothing eligible to check (report this plainly, not as an error).

**Ask First:** none anticipated — the path/symbol classification heuristic is fully specified above.

**Never:**
- Detect "materially changed" drift (a symbol that still exists but whose behavior/signature diverged) — explicitly deferred post-MVP by FR5's own scope note.
- Modify any spec, ledger, or config file — `check-drift` only reads and reports.
- Touch `gate()`, `waypoint verify`/`approve`/`update`, or CI wiring itself — this story only adds the standalone command.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stale path reference | An eligible spec backtick-references a path that no longer exists | Flagged, naming the spec and the path; exit 1 | N/A |
| Stale symbol reference | An eligible spec backtick-references a symbol found nowhere in the repo | Flagged, naming the spec and the symbol; exit 1 | N/A |
| Valid references | Every referenced path/symbol resolves | No findings; exit 0 | N/A |
| Draft/done specs skipped | A `draft` or `done` spec has a stale reference | Not flagged (excluded by the status filter) | N/A |
| Nothing to check | No specs exist, or none are `approved`/`in-progress`, or none have any classifiable reference | Reports nothing-to-check; exit 0 | N/A |
| Materially-changed symbol | A referenced symbol still exists but its behavior diverged | Not flagged — explicitly out of MVP scope | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/check-drift.ts` (new) -- `listEligibleSpecs(cwd)` (walks all three tiers, same directory-walk shape as `packages/core/src/update-spec.ts:239`'s `findSpecById`, filters by frontmatter `status`); `extractReferences(body)` (backtick-token extraction + path/symbol classification); `resolvePathReference`/`resolveSymbolReference` (existence checks); `checkDrift(cwd)` (orchestrates all of the above, returns findings, never throws for "nothing to check")
- `packages/core/src/index.ts` -- export `checkDrift`, `DriftFinding`, `CheckDriftResult`
- `packages/cli/src/commands/check-drift.ts` (new) -- thin handler; sets `process.exitCode = 1` iff `findings.length > 0`, otherwise prints "nothing to check" or a clean summary
- `packages/cli/src/program.ts` -- register `check-drift` (no arguments)
- `packages/core/src/check-drift.test.ts` (new) -- unit-test all six I/O matrix rows against a temp-dir fixture seeded via `scaffold()`/`createFeatureSpec()`/`createSystemSpec()` with hand-set `status` frontmatter (draft specs never reach `approved`/`in-progress` through any existing command yet)
- `packages/cli/src/check-drift.test.ts` (new) -- CLI exit-code contract

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/check-drift.ts` -- write `listEligibleSpecs` -- the status-filtered spec inventory every other piece builds on
- [x] `packages/core/src/check-drift.ts` -- write `extractReferences` (path/symbol classification) -- the false-positive-avoidance heuristic under test
- [x] `packages/core/src/check-drift.ts` -- write the path/symbol resolution + repo-wide search + `checkDrift` orchestration -- the actual drift-detection behavior
- [x] `packages/core/src/index.ts` -- export `checkDrift` and its result/finding types
- [x] `packages/cli/src/commands/check-drift.ts` + `packages/cli/src/program.ts` -- wire `waypoint check-drift`, replacing nothing (new command)
- [x] `packages/core/src/check-drift.test.ts` -- unit-test all six I/O matrix rows
- [x] `packages/cli/src/check-drift.test.ts` -- exit-code contract (0 clean, 1 on any finding)

**Acceptance Criteria:**
- Given a spec backtick-referencing an ordinary word that's neither path- nor symbol-shaped (e.g. `` `pending` ``), when `check-drift` runs, then it's never flagged and never resolution-checked at all
- Given `check-drift` finds drift in multiple specs, when it reports, then every finding names its own spec, not just the first one found

## Design Notes

The path/symbol classification heuristic is this story's central design decision, resolving a real gap: FR5/`docs/architecture.md` say "backtick-delimited identifiers" are candidates but don't say how to avoid treating every backticked word in a spec (`` `null` ``, `` `wx' ``, YAML field names) as a reference needing resolution. Anchoring symbol-shape to `identifier()`/`PascalCase` (matching FR5's own "functions/classes referenced by name" and its own example) and path-shape to "contains `/`" or "bare `name.ext`" keeps the false-positive rate low without inventing scope beyond what's written.

The repo-wide symbol search is intentionally unfiltered by file type ("uniformly regardless of the referenced code's language," per `docs/architecture.md`) and does not exclude spec/doc files — a symbol renamed in real code but still mentioned in some other doc would not be flagged (a known, accepted crude-text-search limitation, not something this story tries to fix).

`listEligibleSpecs` duplicates the directory-walking shape already in `update-spec.ts`'s `findSpecById` a third time (after `new-spec.ts`'s own tier loop) rather than factoring out a shared spec-registry module — consistent with the already-deferred consolidation decision in `deferred-work.md`; extending that entry rather than doing the refactor here keeps this story's own risk surface small.

## Spec Change Log

- 2026-08-21: Implemented per spec. All seven tasks complete; `npm test` (170/170, including 31 new `check-drift.test.ts` cases and 6 new CLI cases) and `npm run build` both pass. During implementation, the frozen symbol-search exclusion list (`.git`/`node_modules`/`dist`/`.waypoint`) was found to make stale-symbol detection permanently unreachable if followed literally: a reference's own backtick occurrence in the spec file being scanned would always trivially "find" itself via the word-boundary search, so no symbol could ever be flagged. Human confirmed the necessary fix: symbol resolution also excludes the exact file a reference was extracted from (every other file, including other specs/docs, still counts) — amended the frozen Boundaries' symbol-search bullet accordingly. All six I/O matrix rows and both acceptance criteria independently re-verified: nothing-to-check on an all-draft repo, a stale path reference flagged and then resolved clean after fixing it, a stale symbol reference flagged (confirming the self-exclusion fix) and then resolved clean against a symbol that actually exists in the scanned repo's own tree, and an ordinary backticked word (`` `pending` ``) confirmed never counted as a reference at all. No other boundary/constraint deviations.
- 2026-08-21: Code review found 5 real issues, most notably (confirmed via a live repro) that the PascalCase heuristic flagged ordinary capitalized prose — `` `Given` ``/`` `When` ``/`` `Then` ``/`` `TODO` `` — as stale symbols. Fixed by tightening `PASCAL_CASE_PATTERN` to require genuine multi-hump structure (a capital, then lowercase/digits, then another capital), amending the frozen Boundaries' classification bullets to describe this and the other four fixes precisely: URL-shaped tokens (containing `://`) are now ignored entirely rather than misclassified as paths; pure decimal-shaped tokens (`1.0`, `2.5`) are excluded from bare-filename path classification; `resolvePathReference` now refuses to resolve an absolute path or one containing a `..` segment (previously could probe the real filesystem outside the repo); and the symbol word-boundary search was rebuilt with a manual lookbehind/lookahead boundary check instead of `\b`, which didn't work correctly for `$`-prefixed symbols. `npm test` now 181/181 (15 new cases); `npm run build` and the manual scratch-dir CLI run re-verified independently, including the exact `Given`/`When`/`Then`/`TODO`/URL/decimal false-positive scenario (now clean) alongside a genuine stale path, the absolute-path guard (confirmed against `/etc/hosts`, which genuinely exists on the test machine but is still correctly never resolved), and a `$scope()` symbol resolving cleanly once a matching occurrence exists in the scanned tree. 4 lower-priority findings (case-insensitive path existence checks, symlink handling, and a narrower build/output-directory exclusion list than some other conventions use) logged to `deferred-work.md`.

## Verification

**Commands:**
- `npm test` -- expected: all `check-drift.test.ts` cases (both files) pass, covering all six I/O matrix rows
- `npm run build && node packages/cli/dist/index.js check-drift` (against a scratch temp directory with a hand-set `approved`-status spec referencing a since-deleted path) -- expected: exits 1, names the stale path

**Manual checks (if no CLI):**
- Hand-edit a created spec's `status` to `approved`, add a backtick reference to a path that doesn't exist, run `check-drift`, and confirm it's flagged with exit code 1

## Suggested Review Order

**Classification heuristic — the false-positive-avoidance core**

- `classifyToken`: URL/decimal exclusions, then path-vs-symbol classification.
  [`check-drift.ts:253`](../../packages/core/src/check-drift.ts#L253)

- The tightened multi-hump `PascalCase` pattern, with its false-positive rationale spelled out.
  [`check-drift.ts:220`](../../packages/core/src/check-drift.ts#L220)

**Resolution**

- `resolvePathReference`'s absolute-path/traversal guard.
  [`check-drift.ts:315`](../../packages/core/src/check-drift.ts#L315)

- `resolveSymbolReference`'s manual boundary check, replacing `\b` for `$`-prefixed symbols; also where the self-match exclusion lives.
  [`check-drift.ts:410`](../../packages/core/src/check-drift.ts#L410)

- `listEligibleSpecs`: the status-filtered, cross-tier spec inventory.
  [`check-drift.ts:148`](../../packages/core/src/check-drift.ts#L148)

- `checkDrift`: orchestration, never throws for "nothing to check."
  [`check-drift.ts:466`](../../packages/core/src/check-drift.ts#L466)

**CLI wiring**

- Thin handler; stderr for findings, stdout for summaries (Unix convention).
  [`check-drift.ts:16`](../../packages/cli/src/commands/check-drift.ts#L16)

**Tests**

- Full classification/resolution matrix, including the five patch-round regression cases.
  [`check-drift.test.ts:1`](../../packages/core/src/check-drift.test.ts#L1)

- CLI exit-code contract and the real `createProgram()`/`parseAsync` wiring test.
  [`check-drift.test.ts:1`](../../packages/cli/src/check-drift.test.ts#L1)
