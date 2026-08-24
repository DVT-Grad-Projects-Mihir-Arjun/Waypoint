import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  classifyChangedFiles,
  isSpecTierPath,
  normalizeSlashes,
  CONFIG_RELATIVE_PATH,
} from './gate-classify.js';

/**
 * `async function gate(input: GateInput): Promise<GateResult>` (Story 3.2) —
 * the enforcement primitive FR7's "Feature/System-tier code needs an
 * accompanying spec delta" rule needs. Built on Story 3.1's
 * `classifyChangedFiles`: a batch containing any `enforced`-tier file is a
 * violation unless the same batch also contains an `enforced`-tier spec-tier
 * file (the delta itself) that currently exists on disk.
 *
 * This function performs real, bounded I/O (via `classifyChangedFiles`,
 * itself scoped to `changedFiles.length` — see that function's own docs) and
 * an `existsSync` check per candidate delta; it is not synchronous and not
 * side-effect-free in the I/O sense. It is still "pure" in the narrower
 * sense this codebase cares about: no mutation, no writes, no git shell-out,
 * no hook installation — just reads.
 *
 * This is a CLI-less primitive only — no `git diff --cached` shell-out, no
 * hook installation, no actual blocking behavior. Both the future pre-commit
 * CLI command and CI's `--ci` full-diff mode call this same implementation
 * unchanged; `mode` is metadata only and never changes this function's
 * validation logic.
 */

/** How the caller resolved `changedFiles` — metadata only, never consulted by `gate()`'s own logic. */
export type GateMode = 'staged' | 'full-diff';

/** Input to `gate()`. `changedFiles` are already-resolved, repo-root-relative, `/`-separated paths. */
export interface GateInput {
  mode: GateMode;
  changedFiles: string[];
  repoRoot: string;
}

/** One violation in a `GateResult`. */
export interface GateViolation {
  file: string;
  /**
   * Permanently `undefined` in this MVP — no file-to-spec association
   * mechanism exists (architecture.md's Error Handling Strategy is explicit
   * about this; never populate this field).
   */
  specId?: string;
  reason: string;
}

/** Result of a `gate()` call. */
export interface GateResult {
  ok: boolean;
  violations: GateViolation[];
}

/** Reason text for an enforced-tier file with no spec delta present in the batch. */
const NO_DELTA_REASON = 'Feature/System-tier change with no spec delta in this commit';

/**
 * Evaluates whether a batch of changed files satisfies FR7's spec-delta
 * rule:
 *
 * 1. Classifies the batch via `classifyChangedFiles(repoRoot, changedFiles)`.
 * 2. If classification reports a non-null `configError`, that is its own
 *    single violation naming `.waypoint/config.yaml` — never suppressed by a
 *    coincidentally-present spec-shaped path, and the delta rule below is
 *    skipped entirely for that call.
 * 3. Otherwise, the batch passes if any classification is `enforced`-tier,
 *    its (normalized) path is a spec-tier path (`isSpecTierPath`), AND that
 *    path currently exists on disk — that is the delta itself. A spec-tier
 *    path that resolved to `unenforced` (e.g. a `tier: patch` spec) never
 *    counts as a delta, and neither does a spec-tier path that was DELETED
 *    in this batch: `classifyChangedFiles` classifies a deleted spec-tier
 *    path `enforced` by its default no-glob-match rule (the
 *    frontmatter-override step is skipped for a nonexistent path — see that
 *    function's docs), but a deleted file has no content to serve as a
 *    delta, so it must never satisfy this rule for other enforced files in
 *    the batch.
 * 4. If no qualifying delta is present, every `enforced`-tier file in the
 *    batch is reported as its own violation.
 *
 * This is a whole-batch check, not per-file matching — one qualifying
 * spec-tier file anywhere in the batch satisfies every enforced file in it.
 *
 * Cost scales with `changedFiles.length` only: this function does no work
 * beyond one `classifyChangedFiles` call (itself bounded by the input list,
 * per Story 3.1), a linear scan of its results, and one `existsSync` check
 * per `enforced`-tier, spec-tier-shaped path in that same list (the
 * deletion check above) — it never walks the working tree, globs the whole
 * repo, or touches any path outside `changedFiles`.
 */
export async function gate(input: GateInput): Promise<GateResult> {
  const { changedFiles, repoRoot } = input;

  const { classifications, configError } = await classifyChangedFiles(repoRoot, changedFiles);

  if (configError !== null) {
    return {
      ok: false,
      violations: [{ file: CONFIG_RELATIVE_PATH, reason: configError }],
    };
  }

  const hasDelta = classifications.some((classification) => {
    if (classification.tier !== 'enforced') return false;
    const normalizedPath = normalizeSlashes(classification.path);
    return isSpecTierPath(normalizedPath) && existsSync(path.join(repoRoot, normalizedPath));
  });

  if (hasDelta) {
    return { ok: true, violations: [] };
  }

  const violations: GateViolation[] = classifications
    .filter((classification) => classification.tier === 'enforced')
    .map((classification) => ({ file: classification.path, reason: NO_DELTA_REASON }));

  return { ok: violations.length === 0, violations };
}
