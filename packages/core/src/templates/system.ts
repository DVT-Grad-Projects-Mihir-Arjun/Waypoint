/**
 * Single source of truth for a system-tier spec-set's content — mirrors the
 * embedded-string pattern `renderFeatureSpec()` uses in `./feature.ts`,
 * avoiding npm-packaging separate `templates/system/*.md` files.
 *
 * System tier's own output is a multi-file spec-set
 * (`specs/systems/<name>/{prd.md,architecture.md,adr.md}`), not a single
 * file — matching docs/architecture.md's own `templates/system/` source-tree
 * listing exactly (one `adr.md`, not numbered ADR stubs). Like Feature tier,
 * `prd.md`'s frontmatter carries `approved_by`/`approved_at` (both `null`
 * until `waypoint approve` runs — Epic 3's scope), since nothing has been
 * approved yet regardless of tier. Unlike Feature tier, `prd.md`'s body has
 * two phase sections (`## Phase 1`/`## Phase 2`), each with exactly one
 * placeholder task, making "phased tasks" concretely distinguishable from
 * Feature tier's single approval gate — the actual per-phase `waypoint
 * approve` mechanism is Epic 3's scope, not this story's.
 *
 * `id` uses the full tier word `system-<date>-<name>`, not an abbreviation —
 * docs/architecture.md gives no documented abbreviation for System tier
 * (unlike Feature's documented `feat-`), so inventing one risks the exact
 * "which abbreviation" ambiguity Story 1.2's review flagged for
 * `feat-`/`feature-`.
 *
 * `phase_approvals: []` (Story 3.4) is the per-phase-boundary approval
 * record `waypoint approve` appends to, one entry per distinct `phase`
 * number the matching ledger tracks — starts empty, since nothing has been
 * approved yet at scaffold time.
 */

/**
 * Description text for the Phase 1 placeholder task, written into both
 * `prd.md`'s `## Phase 1` section and the matching ledger row (`t1`) at
 * scaffold time. Exported so `new-spec.ts` can pass the identical string
 * into `renderSystemLedgerYaml()` — one source of truth, not two copies that
 * could drift.
 */
export const PLACEHOLDER_PHASE_1_TASK_DESCRIPTION =
  'Describe the first Phase 1 implementation task here';

/**
 * Description text for the Phase 2 placeholder task, written into both
 * `prd.md`'s `## Phase 2` section and the matching ledger row (`t2`) at
 * scaffold time. Same one-source-of-truth rationale as
 * `PLACEHOLDER_PHASE_1_TASK_DESCRIPTION`.
 */
export const PLACEHOLDER_PHASE_2_TASK_DESCRIPTION =
  'Describe the first Phase 2 implementation task here';

export function renderSystemPrd(name: string, createdAt: string): string {
  const id = `system-${createdAt}-${name}`;

  return `---
id: ${id}
tier: system
status: draft
approved_by: null
approved_at: null
created_at: ${createdAt}
phase_approvals: []
---

# ${name}

## Requirements

<!-- Describe what this system must do. -->

## Phase 1

- [ ] t1: ${PLACEHOLDER_PHASE_1_TASK_DESCRIPTION}

## Phase 2

- [ ] t2: ${PLACEHOLDER_PHASE_2_TASK_DESCRIPTION}
`;
}

/**
 * Architecture stub — no frontmatter, since architecture content isn't a
 * spec in its own right and carries no `id`/`tier`/`status` of its own.
 */
export function renderSystemArchitectureStub(): string {
  return `# Architecture

<!-- Describe this system's architecture: components, data flow, and key technical decisions. -->
`;
}

/**
 * One ADR stub — no frontmatter, no numbering (a single `adr.md`, matching
 * docs/architecture.md's own `templates/system/` listing exactly, not
 * separately-numbered stub files).
 */
export function renderSystemAdrStub(): string {
  return `# ADR: <decision title>

## Status

Proposed

## Context

<!-- Describe the decision that needs to be made. -->

## Decision

<!-- Describe the decision. -->

## Consequences

<!-- Describe the consequences of this decision. -->
`;
}
