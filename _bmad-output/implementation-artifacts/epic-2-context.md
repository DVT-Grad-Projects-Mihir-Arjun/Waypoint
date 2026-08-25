# Epic 2 Context: Delta Spec Format & Drift Detection

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A developer can evolve an existing spec via a delta instead of a full rewrite, and catch specs that have gone stale against the actual code. This closes the loop on specs being a *living* source of truth: without a low-friction update path, specs would either go stale or force a full rewrite for small changes; without drift detection, staleness would go unnoticed until it misleads a human or agent relying on the spec.

## Stories

- Story 2.1: Update spec via delta
- Story 2.2: check-drift detects stale specs

## Requirements & Constraints

- Specs must support delta-style edits (ADDED/MODIFIED/REMOVED) so an existing spec can be updated without a full rewrite.
- Patch-tier specs are excluded from delta support for MVP — they have no ledger to sync new requirements into, so `update` against a patch-tier spec-id must error rather than silently no-op.
- Appending a delta must never change a spec's approval `status` — no silent reversion, no forced re-approval.
- Drift detection compares a spec's referenced file paths and named symbols against the actual codebase and flags any that no longer exist.
- Symbol references are scoped to backtick-delimited identifiers in spec prose only; resolution is a repo-wide word-boundary text search, not language-aware/AST parsing, uniformly regardless of the referenced code's language.
- Content-level "materially changed" detection (symbol still exists but behavior/signature diverged from the spec) is explicitly out of MVP scope — ships path/symbol-existence checking only.
- Drift checking must be usable both as an ad hoc manual command and as a scheduled/CI job, independent of the commit-time gate.
- No spec-format migration tooling for MVP — the delta/template format is assumed stable pre-1.0; a future breaking change to the format is a manual-migration (major-version) signal, not something this epic needs to handle.

## Technical Decisions

- **Delta block format**: appended under a `## Delta — <date>` heading directly in the spec's markdown body (no separate file), with `### ADDED` / `### MODIFIED` / `### REMOVED` subsections. A second delta on the same calendar date gets a disambiguating sequence suffix (e.g. `## Delta — <date> (2)`) so headings never collide.
- **Ledger sync on delta**: only the `ADDED` subsection's content syncs to the task ledger — each newly-introduced requirement becomes a new `pending` task row, appended using the same append-only rule that governs scaffold-time task creation (existing rows are never rewritten). `MODIFIED`/`REMOVED` entries never automatically touch the ledger; reconciling them against existing tasks is a manual human/agent judgment call for MVP. Wording-only clarifications (no new requirement) add zero ledger rows.
- **Gate interaction**: a Feature/System spec file's own path is itself a Feature/System-tier path, so committing a filled-in delta already *is* its own spec delta for gate purposes (Epic 3's `gate()`) — no separate gate check is needed for the update commit itself.
- **Module ownership**: `delta/` (in `@waypoint/core`) scaffolds and validates delta blocks; `drift/` owns reference-scanning for `check-drift`. Both are thin, deterministic modules with no LLM involvement, consistent with the project's priority on unit-testing enforcement logic over agent-behavior tests.
- **check-drift behavior**: scans specs with status `approved` or `in-progress` (not `draft`) for path/symbol references; exits non-zero if any drift is found (CI-usable), zero otherwise; when a repo has zero specs or a spec has no references at all, it reports "nothing to check" rather than erroring.
- Relevant existing data shapes to build against: spec frontmatter (`id`, `tier`, `status`, `approved_by`, `approved_at`, `created_at`) and the per-task ledger row (`id`, `description`, `status`, `linked_commit`, `verified_by_gate`) — both already defined and in use by Epic 1's spec-creation commands.

## Cross-Story Dependencies

- Story 2.1's ledger-sync logic reuses the append-only task-row convention Epic 1 established at spec-scaffold time — new rows must follow the same shape and ordering guarantees.
- Story 2.1 has no dependency on Story 2.2, and vice versa; both are independent, additive commands.
- Story 2.1's delta output is what Epic 3's gate mechanism (Story 3.2) checks for when deciding whether a Feature/System-tier code change has a corresponding spec delta — Epic 3 consumes this format but does not need to be built first.
- Story 2.2's drift check is orthogonal to Epic 3's commit-time gate; it's a separate, optionally-scheduled command, not a hook.
