/**
 * Single source of truth for a feature-tier spec's content — mirrors the
 * embedded-string pattern `renderPatchSpec()` uses in `./patch.ts`, avoiding
 * npm-packaging a separate `templates/feature.md` file.
 *
 * Feature tier has one approval gate before implementation tasks close (see
 * epic-1-context.md and docs/architecture.md's Data Models section), so —
 * unlike patch tier — the frontmatter includes `approved_by`/`approved_at`
 * (both `null` until `waypoint approve` runs; Epic 3's concern, not this
 * story's). `id` uses the `feat-` abbreviation, matching
 * docs/architecture.md's own frontmatter example (`feat-2026-08-19-auth-refresh`),
 * not `feature-<date>-<name>`.
 *
 * The body starts with exactly one placeholder task in the Task List — see
 * `PLACEHOLDER_TASK_DESCRIPTION` below, shared with `feature-ledger.ts` so
 * the spec's task list and its matching ledger row never drift out of sync.
 */

/**
 * Description text for the single placeholder task written into both the
 * spec's `## Task List` and the matching ledger row (`t1`) at scaffold time.
 * Exported so `new-spec.ts` can pass the identical string into
 * `renderFeatureLedgerYaml()` — one source of truth, not two copies that
 * could drift.
 */
export const PLACEHOLDER_TASK_DESCRIPTION = 'Describe the first implementation task here';

export function renderFeatureSpec(name: string, createdAt: string): string {
  const id = `feat-${createdAt}-${name}`;

  return `---
id: ${id}
tier: feature
status: draft
approved_by: null
approved_at: null
created_at: ${createdAt}
---

# ${name}

## Requirements

<!-- Describe what this feature must do. -->

## Design

<!-- Describe how this feature will be implemented. -->

## Task List

- [ ] t1: ${PLACEHOLDER_TASK_DESCRIPTION}
`;
}
