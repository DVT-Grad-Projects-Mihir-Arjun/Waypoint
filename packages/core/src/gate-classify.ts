import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * `classifyChangedFiles(repoRoot, filePaths)` (Story 3.1) — the config-driven
 * tier classifier Story 3.2's pre-commit gate needs before it can decide what
 * to block. Pure `@waypoint/core` primitive: no CLI command, no blocking
 * behavior of its own.
 *
 * Every changed file resolves to exactly one tier:
 * - `unenforced` (patch tier): matched a `tiers.patch` glob from
 *   `.waypoint/config.yaml`, or a spec file's own frontmatter `tier: patch`
 *   overrode its glob classification.
 * - `enforced` (Feature/System tier, the fail-closed default): matched no
 *   patch glob, or a spec file's own frontmatter `tier: feature`/`tier:
 *   system` overrode a patch-glob match.
 *
 * A missing/empty/malformed config (or a `tiers.patch` that isn't an array of
 * strings) is a single, distinct config-error condition: every path
 * classifies `enforced`, and the whole call reports exactly one config-error
 * message — never a per-file "ambiguous" message. See this story's Boundaries
 * & Constraints and I/O & Edge-Case Matrix.
 */

/** A single changed file's resolved tier. */
export type ClassificationTier = 'unenforced' | 'enforced';

/**
 * Why a file was classified the way it was.
 * - `'patch-glob-match'`: matched a `tiers.patch` glob, no frontmatter override.
 * - `'no-glob-match-default'`: matched no `tiers.patch` glob — the fail-closed default.
 * - `'frontmatter-override'`: a spec file's own frontmatter `tier` overrode its glob classification.
 * - `'config-error'`: `.waypoint/config.yaml` was missing/empty/malformed — see `ClassifyChangedFilesResult.configError`
 *   for the one distinct message; every file gets this reason, never a per-file variant.
 */
export type ClassificationReason =
  | 'patch-glob-match'
  | 'no-glob-match-default'
  | 'frontmatter-override'
  | 'config-error';

/** One changed file's classification. */
export interface FileClassification {
  /** The path exactly as passed in by the caller. */
  path: string;
  tier: ClassificationTier;
  reason: ClassificationReason;
}

/** Result of a `classifyChangedFiles()` call. */
export interface ClassifyChangedFilesResult {
  /** One entry per input path, in input order. */
  classifications: FileClassification[];
  /**
   * Non-null exactly when `.waypoint/config.yaml` is missing, empty,
   * malformed, or `tiers.patch` isn't an array of strings — in which case
   * every classification's `tier` is `'enforced'` and `reason` is
   * `'config-error'`. This single message is the only place the config
   * failure is reported; it never appears once per input path.
   */
  configError: string | null;
}

/** Internal result of loading and validating `tiers.patch` from `.waypoint/config.yaml`. */
type LoadPatchGlobsResult = { ok: true; globs: string[] } | { ok: false; error: string };

/**
 * Repo-root-relative, `/`-separated path to the config file — deliberately a
 * forward-slash literal, not `path.join(...)`, so it stays consistent with
 * every other repo-relative path this module hands back (all `/`-separated,
 * matching a `git diff` path's shape regardless of host OS) rather than
 * silently becoming backslash-separated on Windows. `path.join` still
 * accepts a forward-slash segment correctly on every platform, so this is
 * safe to use unchanged when building the absolute path read below. Used
 * both there and to name the file in every config-error message. Exported so
 * Story 3.2's `gate()` reuses this single definition (e.g. for its
 * config-error violation's `file` field) instead of a second,
 * independently-drifting literal.
 */
export const CONFIG_RELATIVE_PATH = '.waypoint/config.yaml';

/**
 * Loads and validates `tiers.patch` from `.waypoint/config.yaml` in
 * `repoRoot`, once per `classifyChangedFiles` call. Returns a distinct error
 * message per failure mode (missing file, empty file, unparseable YAML,
 * `tiers.patch` not an array of strings) — never a raw filesystem/YAML error
 * escaping to the caller.
 *
 * A config that parses fine but has zero patterns in `tiers.patch` is *not*
 * an error: `{ ok: true, globs: [] }` is returned, and every path then falls
 * through to the ordinary no-match `enforced` default (this story's first
 * Acceptance Criterion).
 */
async function loadPatchGlobs(repoRoot: string): Promise<LoadPatchGlobsResult> {
  const configPath = path.join(repoRoot, CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return {
      ok: false,
      error: `config error: '${CONFIG_RELATIVE_PATH}' was not found. Every changed file is classified 'enforced' until the repo is (re-)installed.`,
    };
  }

  if (raw.trim().length === 0) {
    return {
      ok: false,
      error: `config error: '${CONFIG_RELATIVE_PATH}' is empty. Every changed file is classified 'enforced' until 'tiers.patch' is restored.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `config error: '${CONFIG_RELATIVE_PATH}' failed to parse as YAML (${reason}). Every changed file is classified 'enforced' until the file is fixed.`,
    };
  }

  const patch = (parsed as { tiers?: { patch?: unknown } } | null)?.tiers?.patch;
  if (!Array.isArray(patch) || !patch.every((entry) => typeof entry === 'string')) {
    return {
      ok: false,
      error: `config error: 'tiers.patch' in '${CONFIG_RELATIVE_PATH}' is missing or is not an array of strings. Every changed file is classified 'enforced' until it is fixed.`,
    };
  }

  return { ok: true, globs: patch };
}

/** Escapes every regex metacharacter in a single literal character. `*` and `/` are handled by the caller, never passed here. */
function escapeRegExpChar(char: string): string {
  return char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts one glob pattern into an anchored `RegExp`, supporting exactly the
 * two wildcard forms this story's vocabulary needs (see the story's Design
 * Notes):
 * - `*` matches one path segment's worth of content — any run of characters
 *   excluding `/`, zero-length included.
 * - `**` matches any number of complete path segments, including zero. A
 *   trailing `/**` (e.g. `tasks/**`) also matches the bare prefix itself
 *   (`tasks`) — "including zero" segments means nothing has to follow the
 *   slash at all. A `**` sandwiched between two slashes (e.g. `a/**\/b`) or
 *   leading the whole pattern followed by a slash (e.g. `**\/b`) likewise
 *   allows zero segments in between, so `a/b` and `b` both match — but the
 *   boundary slash itself is never optional, so `ab` does NOT match `a/**\/b`.
 *   Anywhere `**` doesn't sit cleanly against (or at the very end of) slash
 *   boundaries, it falls back to matching literally anything (`.*`) rather
 *   than mis-rendering a pattern this vocabulary was never meant to need.
 *
 * Every other character is treated literally (regex-escaped as needed).
 * Matching is always against a `/`-normalized path — see `normalizeSlashes`.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  let i = 0;
  const n = glob.length;

  while (i < n) {
    const char = glob[i]!;

    if (char === '*' && glob[i + 1] === '*') {
      // The start of the pattern counts as a boundary too (there's simply
      // nothing before it), so a leading '**/' gets the same "zero or more
      // full segments" treatment as a mid-pattern one.
      const boundaryBefore = i === 0 || glob[i - 1] === '/';
      const followedBySlash = glob[i + 2] === '/';
      const atEnd = i + 2 === n;

      if (boundaryBefore && followedBySlash) {
        // '**' bounded by a slash (or the pattern start) before it and a
        // slash after: matches zero or more full segments in between. The
        // boundary slash already sitting in `pattern` (or, at the start,
        // nothing at all) is left untouched — only the segments strictly
        // between the boundaries are optional — so 'a/**/b' matches 'a/b'
        // and 'a/x/b' but never the fused 'ab', and '**/b' matches both 'b'
        // and 'x/b'.
        pattern += '(?:.*/)?';
        i += 3; // consume '**/'
        continue;
      }

      if (i > 0 && glob[i - 1] === '/' && atEnd) {
        // Trailing '/**': matches the bare prefix (zero segments) or
        // anything nested under it. Unlike the mid-pattern/leading case
        // above, the separator itself is part of what's optional here, so
        // the literal '/' already in `pattern` is dropped and folded into
        // the group.
        pattern = pattern.slice(0, -1);
        pattern += '(?:/.*)?';
        i += 2;
        continue;
      }

      // '**' not cleanly slash-bounded (e.g. pattern is just '**', or '**'
      // butts up against a literal with no separating slash) — fall back to
      // "matches anything", the safest interpretation for a shape this
      // narrow vocabulary was never designed to produce.
      pattern += '.*';
      i += 2;
      continue;
    }

    if (char === '*') {
      pattern += '[^/]*';
      i += 1;
      continue;
    }

    pattern += escapeRegExpChar(char);
    i += 1;
  }

  return new RegExp(`^${pattern}$`);
}

/**
 * Replaces every backslash with a forward slash, so glob matching (and
 * `isSpecTierPath`) is separator-agnostic regardless of the host OS or how
 * the caller sourced the path (e.g. a `git diff` path is always
 * `/`-separated). Exported so every caller of `isSpecTierPath` — this
 * module's own `frontmatterOverrideTier` included — normalizes through this
 * single definition rather than a second copy.
 */
export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/** `true` if `filePath` matches `glob` under this module's `*`/`**` semantics. */
function matchesGlob(filePath: string, glob: string): boolean {
  return globToRegExp(normalizeSlashes(glob)).test(normalizeSlashes(filePath));
}

/**
 * The three spec-tier locations eligible for the frontmatter-override step,
 * per this story's Boundaries & Constraints — nowhere else, no matter what a
 * file's content looks like:
 * - `specs/patches/<name>.md`
 * - `specs/features/<name>.md`
 * - `specs/systems/<name>/{prd,architecture,adr}.md`
 */
const PATCH_OR_FEATURE_SPEC_PATTERN = /^specs\/(?:patches|features)\/[^/]+\.md$/;
const SYSTEM_SPEC_FILE_PATTERN = /^specs\/systems\/[^/]+\/(?:prd|architecture|adr)\.md$/;

/**
 * `true` if a `/`-normalized path sits in one of the three
 * frontmatter-override-eligible spec-tier locations. Exported for Story
 * 3.2's `gate()` to reuse as its single definition of "what counts as a
 * spec file" — never re-derive a second copy of this regex.
 */
export function isSpecTierPath(normalizedPath: string): boolean {
  return (
    PATCH_OR_FEATURE_SPEC_PATTERN.test(normalizedPath) ||
    SYSTEM_SPEC_FILE_PATTERN.test(normalizedPath)
  );
}

const VALID_OVERRIDE_TIERS = new Set(['patch', 'feature', 'system']);

/** Matches the leading `---\n...\n---\n` frontmatter block, capturing the inner YAML text. */
const FRONTMATTER_BLOCK_PATTERN = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/;

/**
 * Parses just the frontmatter `tier` field out of a spec file's raw text.
 * Returns `null` if the file has no well-formed frontmatter block, has no
 * `tier` field, or the value isn't exactly `'patch'`, `'feature'`, or
 * `'system'` — same shape as `update-spec.ts`'s own
 * `parseFrontmatterIdAndTier`/`check-drift.ts`'s `parseFrontmatterMeta`,
 * duplicated locally per this codebase's existing convention (see
 * `check-drift.ts`'s own comment on this) rather than factored into a shared
 * helper.
 */
function parseFrontmatterTier(raw: string): 'patch' | 'feature' | 'system' | null {
  const match = raw.match(FRONTMATTER_BLOCK_PATTERN);
  if (!match) return null;

  const inner = match[1]!.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n$/, '');
  try {
    const parsed = parse(inner) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.tier !== 'string' || !VALID_OVERRIDE_TIERS.has(parsed.tier)) {
      return null;
    }
    return parsed.tier as 'patch' | 'feature' | 'system';
  } catch {
    return null;
  }
}

/**
 * Resolves the frontmatter-override tier for one changed file, or `null` if
 * no override applies. An override applies only when all of the following
 * hold:
 * - the path (normalized) sits in one of the three spec-tier locations
 *   (`isSpecTierPath`);
 * - the path currently exists on disk — a deletion (the path no longer
 *   exists) has nothing to read, so the override step is skipped entirely,
 *   per this story's Boundaries & Constraints;
 * - the file's frontmatter has a valid `tier` field.
 *
 * A path outside the three spec-tier locations never reaches the filesystem
 * read at all, regardless of its content — this is what keeps an ordinary
 * code file with YAML-ish, `tier`-like content from ever being consulted (the
 * "override doesn't extend to code" row of this story's I/O matrix).
 */
async function frontmatterOverrideTier(
  repoRoot: string,
  filePath: string
): Promise<'patch' | 'feature' | 'system' | null> {
  if (!isSpecTierPath(normalizeSlashes(filePath))) return null;

  const absPath = path.join(repoRoot, filePath);
  if (!existsSync(absPath)) return null;

  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch {
    // Vanished (or became unreadable) between the existsSync check above and
    // this read — treat the same as "nothing to read," not a fatal error.
    return null;
  }

  return parseFrontmatterTier(raw);
}

/** Maps a frontmatter override `tier` value to the `ClassificationTier` it forces. */
function tierToClassification(tier: 'patch' | 'feature' | 'system'): ClassificationTier {
  return tier === 'patch' ? 'unenforced' : 'enforced';
}

/**
 * Classifies every path in `filePaths` as `unenforced` (patch tier) or
 * `enforced` (Feature/System tier, the fail-closed default), per this
 * story's Intent and Boundaries & Constraints:
 *
 * 1. Loads and validates `tiers.patch` from `.waypoint/config.yaml`, once for
 *    the whole batch. If the config is missing/empty/malformed (or
 *    `tiers.patch` isn't an array of strings), every path classifies
 *    `enforced` with reason `'config-error'`, and the single distinct
 *    message is reported via `configError` — never once per path.
 * 2. Otherwise, for each path: match it against every `tiers.patch` glob (a
 *    match → `unenforced`/`'patch-glob-match'`; no match →
 *    `enforced`/`'no-glob-match-default'`), purely as a string — a deletion
 *    classifies correctly by its removed path with no special-casing, and no
 *    existence check is performed for this step.
 * 3. Then, only for a path that currently exists on disk under one of the
 *    three spec-tier locations, read its frontmatter `tier` and let it
 *    override that file's own classification (reason
 *    `'frontmatter-override'`). A path that doesn't currently exist (a
 *    deletion) skips this step entirely; a path outside the three spec-tier
 *    locations is never eligible, no matter its content.
 */
export async function classifyChangedFiles(
  repoRoot: string,
  filePaths: string[]
): Promise<ClassifyChangedFilesResult> {
  const loaded = await loadPatchGlobs(repoRoot);

  if (!loaded.ok) {
    const classifications: FileClassification[] = filePaths.map((filePath) => ({
      path: filePath,
      tier: 'enforced',
      reason: 'config-error',
    }));
    return { classifications, configError: loaded.error };
  }

  const { globs } = loaded;
  const classifications: FileClassification[] = [];

  for (const filePath of filePaths) {
    const matchedGlob = globs.some((glob) => matchesGlob(filePath, glob));
    let tier: ClassificationTier = matchedGlob ? 'unenforced' : 'enforced';
    let reason: ClassificationReason = matchedGlob
      ? 'patch-glob-match'
      : 'no-glob-match-default';

    const overrideTier = await frontmatterOverrideTier(repoRoot, filePath);
    if (overrideTier) {
      tier = tierToClassification(overrideTier);
      reason = 'frontmatter-override';
    }

    classifications.push({ path: filePath, tier, reason });
  }

  return { classifications, configError: null };
}
