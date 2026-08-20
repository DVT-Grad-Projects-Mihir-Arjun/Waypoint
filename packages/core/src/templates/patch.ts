/**
 * Single source of truth for a patch-tier spec's content — mirrors the
 * embedded-string pattern `renderConfigYaml()` uses in `../config-defaults.ts`,
 * avoiding npm-packaging a separate `templates/patch.md` file.
 *
 * Patch tier has no approval step and no task ledger (see
 * epic-1-context.md and docs/architecture.md's Data Models section), so the
 * frontmatter deliberately omits `approved_by`/`approved_at` and any ledger
 * reference — unlike Feature/System tier frontmatter.
 */
export function renderPatchSpec(name: string, createdAt: string): string {
  const id = `patch-${createdAt}-${name}`;

  return `---
id: ${id}
tier: patch
status: draft
created_at: ${createdAt}
---

# ${name}

## Summary

<!-- Describe the trivial change this patch spec records. -->
`;
}
