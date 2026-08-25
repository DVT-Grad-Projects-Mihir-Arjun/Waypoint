# Epic 5 Context: Status & Reporting

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A developer can see, at a glance, the state of every open spec — tier, approval state, task completion — without hunting across files. This is the final epic in the MVP roadmap: everything it reports on (tiers, approval, the task ledger, the `.gate-state` corruption signal) was already built and mechanically enforced by Epics 1–4; this epic only adds read-only visibility on top, never a new enforcement mechanism.

## Stories

- Story 5.1: waypoint status

## Requirements & Constraints

- `waypoint status` shows every open spec across the repo — its tier, its approval state, and its task completion — in terminal-readable output (table or list) that also reports counts by tier.
- Zero open specs prints an explicit empty-state message, never blank output.
- A Patch-tier spec has no approval concept and no task ledger at all; when listed, its approval/task-completion fields read as explicitly not applicable, never blank and never an error.
- A Feature/System spec that isn't yet approved and has at least one in-progress task is flagged explicitly, distinct from an ordinary still-open row.
- A task previously flagged `CORRUPTED` (Story 3.3's tamper-detection: a stored `.gate-state` hash missing or not matching the task's current field values) is shown with its own distinct indicator — never rendered as plain `done` or `pending`.
- A spec closes (leaves the "open specs" list) exactly when it's both approved and every one of its tasks is genuinely `done` — a task whose `done` claim is actually `CORRUPTED` does not count toward that closing condition, even though its raw ledger `status` field says `done`.
- `status` reads only the local, on-disk ledger and gate-state — no remote-awareness of anyone else's unpushed `waypoint verify` commits, and it writes nothing anywhere (purely a read/report command, like `check-drift` and CI's own checks).

## Technical Decisions

- No new npm dependency for terminal formatting (no table/CLI-styling library) — matches this codebase's established zero-added-dependency pattern; plain-text output, hand-aligned or list-shaped, is enough to satisfy "readable in a terminal."
- Spec discovery (enumerating every spec file across all three tiers) already has a working implementation to build on: `update-spec.ts`'s `findSpecById` walks `specs/patches/*.md`, `specs/features/*.md`, and `specs/systems/*/prd.md` exactly this way already, just filtered to one id. This epic's spec-discovery need is the same walk, unfiltered.
- CORRUPTED detection reuses `verify.ts`'s already-exported `computeLedgerTaskHash` (the same hashing function `waypoint verify` uses to write a stored hash) rather than re-deriving the hash algorithm a second time — a task's stored `.gate-state` entry must be read and compared with the identical function that wrote it, or corruption detection would silently diverge between the two commands.
- The `status` field on a spec's frontmatter is the single source of truth for "approved" on both Feature and System tier — System tier's own top-level `status` already flips to `'approved'` only once every ledger phase has been approved (Story 3.4's `approve` design), so `status` alone is sufficient without separately inspecting `phase_approvals`.

## Cross-Story Dependencies

- Depends on every prior epic's mechanism being stable: Epic 1's tier/spec scaffolding, Epic 2's delta format, Epic 3's ledger/gate/verify/approve mechanics and the `.gate-state` corruption signal specifically, Epic 4's `AGENTS.md`/role-prompt generation (unrelated to this epic's own output, but the last shipped work before it).
- This is the last story in the entire MVP roadmap (`prd.md`'s Epic List ends here) — no epic or story depends on this one; nothing is deferred past it for MVP.
