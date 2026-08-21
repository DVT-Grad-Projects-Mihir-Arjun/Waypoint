import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * `waypoint check-drift` (Story 2.2) — scans every `approved`/`in-progress`
 * spec for backtick-delimited path/symbol references and flags any that no
 * longer resolve against the actual repository. No arguments, reads only,
 * and is meant to be run both ad hoc and as a scheduled/CI job independent
 * of the commit-time gate (see this story's Intent).
 *
 * Scope is deliberately narrow (see this story's Boundaries & Constraints
 * and Design Notes):
 * - Only path/symbol *existence* is checked — a symbol that still exists but
 *   whose behavior/signature diverged ("materially changed" drift) is
 *   explicitly out of MVP scope.
 * - Symbol resolution is a repo-wide, word-boundary, case-sensitive text
 *   search, not AST/language-aware parsing, applied uniformly regardless of
 *   the referenced code's language.
 * - This module never modifies any spec, ledger, or config file.
 */

/** The only two frontmatter `status` values eligible for drift scanning. */
const ELIGIBLE_STATUSES = new Set(['approved', 'in-progress']);

/** Directory names excluded from the repo-wide symbol search, by design. */
const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', '.waypoint']);

const VALID_TIERS = new Set(['patch', 'feature', 'system']);

/** Matches the leading `---\n...\n---\n` frontmatter block, capturing the inner YAML text. */
const FRONTMATTER_BLOCK_PATTERN = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/;

/**
 * Splits a file's raw text into its frontmatter block and everything after
 * it (the body), or returns `null` if `raw` doesn't start with a well-formed
 * frontmatter block — the same shape as `update-spec.ts`'s own
 * `splitFrontmatter`, duplicated locally per this story's Design Notes
 * (a third copy of this directory/file-shape logic, consistent with the
 * already-deferred consolidation decision in `deferred-work.md`).
 */
function splitFrontmatter(raw: string): { frontmatterBlock: string; body: string } | null {
  const match = raw.match(FRONTMATTER_BLOCK_PATTERN);
  if (!match) return null;
  return { frontmatterBlock: match[1]!, body: match[2]! };
}

/**
 * The scannable body of a spec file: everything after its frontmatter block,
 * or the entire raw text unchanged if it has no frontmatter block at all
 * (e.g. a system spec-set's `architecture.md`/`adr.md`, which carry no
 * frontmatter of their own per `templates/system.ts`).
 */
function bodyOf(raw: string): string {
  const split = splitFrontmatter(raw);
  return split ? split.body : raw;
}

/**
 * Parses just the `id`/`tier`/`status` fields out of a spec file's
 * frontmatter. Returns `null` if the file has no well-formed frontmatter
 * block, is missing any of the three fields as a string, or has a `tier`
 * value other than exactly `'patch'`, `'feature'`, or `'system'` — mirrors
 * `update-spec.ts`'s `parseFrontmatterIdAndTier`, extended with `status`
 * since eligibility filtering is this function's whole purpose here.
 */
function parseFrontmatterMeta(raw: string): { id: string; tier: string; status: string } | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  const inner = split.frontmatterBlock.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n$/, '');
  try {
    const parsed = parse(inner) as Record<string, unknown> | null;
    if (
      !parsed ||
      typeof parsed.id !== 'string' ||
      typeof parsed.tier !== 'string' ||
      !VALID_TIERS.has(parsed.tier) ||
      typeof parsed.status !== 'string'
    ) {
      return null;
    }
    return { id: parsed.id, tier: parsed.tier, status: parsed.status };
  } catch {
    return null;
  }
}

/** `readdir`, tolerating a missing directory by reporting no entries. */
async function safeReaddirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The subdirectory names directly under `specs/systems/` (each a spec-set), tolerating a missing directory. */
async function safeReaddirSystemDirNames(systemsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(systemsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * A spec eligible for drift scanning (frontmatter `status` is exactly
 * `approved` or `in-progress`), together with every body-bearing file that
 * must be scanned for it.
 *
 * For patch/feature tier this is just the spec file itself. For system tier
 * this is `prd.md` (whose frontmatter is what determined eligibility) plus
 * that same spec-set's `architecture.md`/`adr.md`, whichever exist — per
 * this story's Boundaries & Constraints ("`specs/systems/<name>/prd.md` plus
 * that system's `architecture.md`/`adr.md`").
 */
export interface EligibleSpec {
  /** The spec's frontmatter `id`. */
  id: string;
  /** The spec's frontmatter `tier` (`'patch' | 'feature' | 'system'`, as written). */
  tier: string;
  /** Absolute paths of every file to scan for backtick references, for this spec. */
  files: string[];
}

/**
 * True only if `status` is exactly `'approved'` or `'in-progress'` — `draft`
 * and `done` are excluded, per this story's Boundaries & Constraints
 * ("status is the only filter, no tier exclusion needed").
 */
function isEligibleStatus(status: string): boolean {
  return ELIGIBLE_STATUSES.has(status);
}

/**
 * Walks all three spec tiers (same directory-walk shape as
 * `update-spec.ts:239`'s `findSpecById`) and returns every spec whose
 * frontmatter `status` is exactly `approved` or `in-progress`, together with
 * the files that must be scanned for each.
 *
 * A spec file that's unreadable or has malformed/missing frontmatter is
 * silently skipped (not eligible) rather than treated as a fatal error — one
 * corrupted file elsewhere in `specs/` must not block scanning every other
 * eligible spec.
 */
export async function listEligibleSpecs(cwd: string): Promise<EligibleSpec[]> {
  const patchesDir = path.join(cwd, 'specs', 'patches');
  const featuresDir = path.join(cwd, 'specs', 'features');
  const systemsDir = path.join(cwd, 'specs', 'systems');

  const eligible: EligibleSpec[] = [];

  for (const dir of [patchesDir, featuresDir]) {
    for (const name of await safeReaddirNames(dir)) {
      if (!name.endsWith('.md')) continue;
      const filePath = path.join(dir, name);

      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch {
        continue;
      }

      const meta = parseFrontmatterMeta(raw);
      if (!meta || !isEligibleStatus(meta.status)) continue;

      eligible.push({ id: meta.id, tier: meta.tier, files: [filePath] });
    }
  }

  for (const dirName of await safeReaddirSystemDirNames(systemsDir)) {
    const specDir = path.join(systemsDir, dirName);
    const prdPath = path.join(specDir, 'prd.md');

    let raw: string;
    try {
      raw = await readFile(prdPath, 'utf8');
    } catch {
      continue;
    }

    const meta = parseFrontmatterMeta(raw);
    if (!meta || !isEligibleStatus(meta.status)) continue;

    const files = [prdPath];
    const architecturePath = path.join(specDir, 'architecture.md');
    const adrPath = path.join(specDir, 'adr.md');
    if (existsSync(architecturePath)) files.push(architecturePath);
    if (existsSync(adrPath)) files.push(adrPath);

    eligible.push({ id: meta.id, tier: meta.tier, files });
  }

  return eligible;
}

/** A backtick-delimited token classified as a candidate reference, ready for resolution. */
interface ExtractedReference {
  type: 'path' | 'symbol';
  /** The value used for resolution: trailing `:<line>` stripped for path, trailing `()` stripped for symbol. */
  value: string;
}

/** Matches every backtick-delimited token in a markdown body (single backticks, no embedded backtick or newline). */
const BACKTICK_TOKEN_PATTERN = /`([^`\n]+)`/g;

/** A trailing `:<line-number>` suffix on a path-like token, e.g. `packages/core/src/foo.ts:42`. */
const TRAILING_LINE_SUFFIX_PATTERN = /:\d+$/;

/** Bare `<name>.<ext>` shape with no path separator, e.g. `package.json`. */
const BARE_FILENAME_PATTERN = /^[^\s/]+\.[A-Za-z0-9]+$/;

/** A plain identifier immediately followed by `()`, e.g. `refreshToken()`. */
const SYMBOL_CALL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*\(\)$/;

/**
 * A genuine multi-hump PascalCase word: a capital, then one or more
 * lowercase/digit characters, then *another* capital, then anything
 * alphanumeric — e.g. `UserSession`, `FoundSpec`, `CheckDriftResult`.
 *
 * Deliberately tighter than "starts with a capital letter": a single-hump
 * capitalized word (`Given`, `When`, `Then`) or an all-caps acronym
 * (`TODO`, `JSON`, `HTML`) has no lowercase-then-capital transition, so it
 * fails this pattern and is correctly left unclassified — real code
 * identifiers referenced by name have genuine multi-word structure; ordinary
 * capitalized prose words don't.
 */
const PASCAL_CASE_PATTERN = /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/;

/** A URL scheme separator (`://`) — present in `` `https://example.com` `` etc. */
const URL_SCHEME_PATTERN = /:\/\//;

/** A pure decimal-number-shaped token, e.g. `1.0`, `2.5` — never a path, despite being structurally identical to a bare `<name>.<ext>` filename. */
const DECIMAL_NUMBER_PATTERN = /^\d+\.\d+$/;

/**
 * Classifies one backtick-delimited token per this story's Boundaries &
 * Constraints heuristic:
 * - A URL (contains a `://` scheme separator) is ignored entirely — neither
 *   path nor symbol — rather than being misclassified as a stale path via
 *   its `/`-containing shape.
 * - **path-like** if it contains `/`, or matches a bare `<name>.<ext>` shape
 *   that isn't actually a pure decimal number (`1.0`, `2.5` are version-ish
 *   prose, not files).
 * - **symbol-like** (checked only if not path-like) if it matches
 *   `identifier()` or the tightened multi-hump `PascalCase` pattern above.
 * - Anything else (e.g. `` `null` ``, `` `pending` ``, `` `Given` ``,
 *   `` `TODO` ``) is not a reference and is ignored — returns `null`.
 */
function classifyToken(token: string): ExtractedReference | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;

  if (URL_SCHEME_PATTERN.test(trimmed)) return null;

  const isDecimalNumber = DECIMAL_NUMBER_PATTERN.test(trimmed);
  const isPathLike =
    !isDecimalNumber && (trimmed.includes('/') || BARE_FILENAME_PATTERN.test(trimmed));
  if (isPathLike) {
    return { type: 'path', value: trimmed.replace(TRAILING_LINE_SUFFIX_PATTERN, '') };
  }

  if (SYMBOL_CALL_PATTERN.test(trimmed)) {
    return { type: 'symbol', value: trimmed.slice(0, -2) };
  }
  if (PASCAL_CASE_PATTERN.test(trimmed)) {
    return { type: 'symbol', value: trimmed };
  }

  return null;
}

/**
 * Extracts every classifiable path/symbol reference from a scanned spec
 * body. Non-reference backticked tokens (an ordinary word, a YAML-ish
 * value, etc.) are silently dropped by `classifyToken` — this is what keeps
 * ordinary backticked prose from becoming false positives (this story's
 * first Acceptance Criterion).
 *
 * De-duplicates by `(type, value)` so the same reference repeated multiple
 * times in one body is only resolved (and, if stale, flagged) once.
 */
export function extractReferences(body: string): ExtractedReference[] {
  const seen = new Set<string>();
  const references: ExtractedReference[] = [];

  for (const match of body.matchAll(BACKTICK_TOKEN_PATTERN)) {
    const classified = classifyToken(match[1]!);
    if (!classified) continue;

    const key = `${classified.type}:${classified.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(classified);
  }

  return references;
}

/**
 * True if `pathValue` exists relative to the repo root (`cwd`).
 *
 * Refuses to resolve (returns `false` without touching the filesystem) an
 * absolute-looking `pathValue` (starts with `/` or `\`) or one containing a
 * `..` segment: `path.join(cwd, pathValue)` would otherwise ignore `cwd`
 * entirely for an absolute value, or escape the repo root for a `..`
 * traversal, either way probing whatever happens to exist on the real
 * machine's filesystem rather than something meaningful relative to the
 * repo's own content. A legitimate repo-relative reference should never need
 * either shape.
 */
function resolvePathReference(cwd: string, pathValue: string): boolean {
  if (pathValue.startsWith('/') || pathValue.startsWith('\\')) return false;
  if (pathValue.split(/[/\\]/).some((segment) => segment === '..')) return false;
  return existsSync(path.join(cwd, pathValue));
}

/** One file collected by `collectRepoFiles`, ready for repeated word-boundary symbol searches. */
interface RepoFile {
  /** Absolute path, used only to let a resolution exclude its own source file (see `resolveSymbolReference`). */
  path: string;
  content: string;
}

/**
 * Recursively collects the text content of every file under `cwd`, skipping
 * `.git`, `node_modules`, `dist`, and `.waypoint` at any depth (per this
 * story's Boundaries & Constraints), for the repo-wide symbol search.
 * Collected once per `checkDrift()` call and reused across every symbol
 * reference resolved during that call, rather than re-walking the tree once
 * per symbol.
 *
 * A file that can't be read (permissions, or removed mid-walk) is silently
 * skipped rather than failing the whole scan.
 */
async function collectRepoFiles(cwd: string): Promise<RepoFile[]> {
  const files: RepoFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const filePath = path.join(dir, entry.name);
        try {
          const content = await readFile(filePath, 'utf8');
          files.push({ path: filePath, content });
        } catch {
          // Unreadable or not valid UTF-8 text — skip; not this command's
          // job to report unrelated filesystem errors.
        }
      }
    }
  }

  await walk(cwd);
  return files;
}

/** Escapes every regex metacharacter in `value` so it can be embedded literally in a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `symbol` appears anywhere in `repoFiles`' content as a
 * boundary-respecting match — a repo-wide, case-sensitive text search, not
 * AST/language-aware parsing, applied uniformly regardless of the
 * referenced code's language, per this story's Boundaries & Constraints and
 * `docs/architecture.md`.
 *
 * Uses a manual negative-lookbehind/lookahead boundary
 * (`(?<![A-Za-z0-9_$])...(?![A-Za-z0-9_$])`) instead of regex `\b`. `\b`
 * asserts a transition between a "word" character (`\w` = `[A-Za-z0-9_]`)
 * and a non-word one — but `SYMBOL_CALL_PATTERN` allows a symbol to start
 * (or be composed of) `$` (e.g. `` `$scope()` ``), and `$` is *not* a word
 * character. `\b` immediately before a `$`-prefixed symbol fails to assert
 * whenever the preceding character is also non-word (whitespace,
 * start-of-line, a backtick, ...), which would wrongly report a
 * legitimately-present `$`-prefixed symbol as not found. Treating `$` as
 * part of the "identifier" boundary character class — uniformly, regardless
 * of what character the symbol actually starts with — fixes this for every
 * symbol shape this module can extract.
 *
 * `excludeFilePath` is always the exact file the reference was extracted
 * from, excluded from its own search corpus. Without this, a backtick
 * reference's own literal text (e.g. the token `` `deletedHelper()` `` in
 * the spec's markdown source) would always contain the plain string
 * "deletedHelper", which would then trivially satisfy the boundary search
 * against the spec's own file — making every symbol resolve as "found,"
 * permanently, regardless of whether it still exists in real code. That
 * would defeat this story's Intent outright. This exclusion is a
 * resolution-algorithm detail, not an additional excluded directory beyond
 * the four named in the Boundaries & Constraints — every *other* spec/doc
 * file in the repo remains part of the corpus, per `docs/architecture.md`'s
 * explicit "does not exclude spec/doc files" and its accepted cross-file
 * false-negative limitation.
 */
function resolveSymbolReference(
  repoFiles: RepoFile[],
  symbol: string,
  excludeFilePath: string
): boolean {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`
  );
  return repoFiles.some((file) => file.path !== excludeFilePath && pattern.test(file.content));
}

/** One stale reference found by `checkDrift()`. */
export interface DriftFinding {
  /** The frontmatter `id` of the spec the stale reference was found in. */
  specId: string;
  /** Absolute path to the specific file (spec/architecture/adr) containing the stale reference. */
  specPath: string;
  /** Whether the stale reference was classified as a path or a symbol. */
  type: 'path' | 'symbol';
  /** The reference's resolved value (post-stripping of `:<line>`/`()`), as it failed to resolve. */
  reference: string;
}

/** Result of a `checkDrift()` run. */
export interface CheckDriftResult {
  /** Every stale reference found, across every scanned spec — never just the first one. */
  findings: DriftFinding[];
  /** The number of eligible (`approved`/`in-progress`) specs scanned. */
  specsScanned: number;
  /** The total number of distinct classifiable references resolved across every scanned file. */
  referencesChecked: number;
  /**
   * `true` when there was nothing eligible to check at all: no specs exist,
   * none are `approved`/`in-progress`, or none have any classifiable
   * reference. Reported plainly by the CLI layer, not as an error, per this
   * story's Boundaries & Constraints.
   */
  nothingToCheck: boolean;
}

/**
 * Orchestrates `waypoint check-drift`'s full behavior: locates every
 * eligible spec (`listEligibleSpecs`), extracts every classifiable
 * path/symbol reference from each of its scanned files
 * (`extractReferences`), and resolves each one (`resolvePathReference`/
 * `resolveSymbolReference`), collecting every reference that fails to
 * resolve as a `DriftFinding`.
 *
 * Never throws for "nothing to check" — that's reported via
 * `CheckDriftResult.nothingToCheck` instead, per this story's Boundaries &
 * Constraints ("report this plainly, not as an error"). A per-file read
 * failure (the file vanished between `listEligibleSpecs` and this read) is
 * silently skipped for the same reason `listEligibleSpecs` skips unreadable
 * files — this command only reads and reports, it never fails a whole run
 * over one file's transient I/O issue.
 */
export async function checkDrift(cwd: string): Promise<CheckDriftResult> {
  const eligible = await listEligibleSpecs(cwd);

  const findings: DriftFinding[] = [];
  let referencesChecked = 0;

  if (eligible.length > 0) {
    const repoFiles = await collectRepoFiles(cwd);

    for (const spec of eligible) {
      for (const filePath of spec.files) {
        let raw: string;
        try {
          raw = await readFile(filePath, 'utf8');
        } catch {
          continue;
        }

        const references = extractReferences(bodyOf(raw));
        for (const ref of references) {
          referencesChecked++;
          const resolved =
            ref.type === 'path'
              ? resolvePathReference(cwd, ref.value)
              : resolveSymbolReference(repoFiles, ref.value, filePath);

          if (!resolved) {
            findings.push({
              specId: spec.id,
              specPath: filePath,
              type: ref.type,
              reference: ref.value,
            });
          }
        }
      }
    }
  }

  return {
    findings,
    specsScanned: eligible.length,
    referencesChecked,
    nothingToCheck: referencesChecked === 0,
  };
}
