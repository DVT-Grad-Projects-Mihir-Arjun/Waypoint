import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

/**
 * `waypoint update <spec-id>` — evolves an existing Feature/System-tier spec
 * via a delta instead of a full rewrite (Story 2.1). Every invocation does
 * two things in one pass, in order:
 *
 * 1. Sync pass: any already-filled-in `### ADDED` bullets (from a delta the
 *    human/agent has since hand-edited, under any `## Delta — ...` heading,
 *    not just today's) are synced into the ledger as new `pending` tasks,
 *    skipping any whose trimmed text already exactly matches an existing
 *    task's `description`.
 * 2. Scaffold pass: looks at the most recently appended `## Delta — ...`
 *    heading. If it's still completely empty (no bullets in any of its
 *    three subsections), it's reused as-is — no new heading is appended,
 *    avoiding empty-heading litter on a true no-op re-run. Otherwise (or if
 *    no delta heading exists yet at all), a fresh, empty `## Delta — <date>`
 *    block is appended for the human/agent to fill in next (disambiguated
 *    with `(2)`, `(3)`, ... if one was already appended today).
 *
 * No editor is spawned — matches every other Waypoint command's
 * non-interactive, script/agent-safe design (see this story's Design Notes).
 * `MODIFIED`/`REMOVED` content is never synced — that stays a manual
 * human/agent judgment call for MVP, per `epics.md`'s own AC.
 */

/**
 * Thrown when `<spec-id>` matches no spec's frontmatter `id` field across any
 * of the three tiers (`specs/patches/<name>.md`, `specs/features/<name>.md`,
 * `specs/systems/<name>/prd.md`). Thrown before any filesystem write.
 *
 * Also thrown (rather than letting a malicious or corrupted value escape the
 * `tasks/` directory) when a matched spec's frontmatter `id` doesn't have the
 * expected `<tier>-<date>-<name>` shape — a corrupted/adversarial id can't
 * legitimately resolve to a real spec anyway, so it's treated the same as
 * "not found."
 */
export class SpecNotFoundError extends Error {
  readonly specId: string;

  constructor(specId: string) {
    super(`no spec found with id '${specId}'.`);
    this.name = 'SpecNotFoundError';
    this.specId = specId;
  }
}

/**
 * Thrown when `<spec-id>` resolves to a patch-tier spec. Patch tier has no
 * task ledger to sync into, and isn't supported by `update` for MVP. Thrown
 * before any filesystem write.
 */
export class PatchTierUpdateNotSupportedError extends Error {
  readonly specId: string;

  constructor(specId: string) {
    super(
      `'${specId}' is a patch-tier spec. Patch tier has no task ledger to sync into, ` +
        "and isn't supported by 'update' for MVP."
    );
    this.name = 'PatchTierUpdateNotSupportedError';
    this.specId = specId;
  }
}

/**
 * Thrown when more than one spec file's frontmatter `id` matches the same
 * `specId` — e.g. from manual editing or a bug elsewhere. Silently picking
 * the first match would risk syncing/scaffolding the wrong file, so this is
 * surfaced as a clear error naming every colliding path instead. Thrown
 * before any filesystem write.
 */
export class DuplicateSpecIdError extends Error {
  readonly specId: string;
  readonly paths: string[];

  constructor(specId: string, paths: string[]) {
    super(
      `multiple spec files share the id '${specId}': ${paths.join(', ')}. ` +
        'Fix the duplicate before running update.'
    );
    this.name = 'DuplicateSpecIdError';
    this.specId = specId;
    this.paths = paths;
  }
}

/**
 * Thrown when the matched spec's task ledger (`tasks/<id>.ledger.yaml`)
 * can't be read, isn't valid YAML, or doesn't parse to an object with a
 * top-level `tasks` array — a clear domain error instead of letting a raw
 * `ENOENT`/`TypeError` escape from the sync pass's ledger read.
 */
export class LedgerNotFoundError extends Error {
  readonly ledgerPath: string;

  constructor(ledgerPath: string, reason?: string) {
    super(
      `task ledger '${ledgerPath}' could not be read${reason ? ` (${reason})` : ''}. ` +
        "It may be missing or malformed (expected a YAML file with a top-level 'tasks' array)."
    );
    this.name = 'LedgerNotFoundError';
    this.ledgerPath = ledgerPath;
  }
}

/** A spec located by `findSpecById`. */
export interface FoundSpec {
  /** Absolute path to the spec file (`<name>.md` or a system's `prd.md`). */
  path: string;
  /** The spec's frontmatter `id`. */
  id: string;
  /** The spec's frontmatter `tier` (`'patch' | 'feature' | 'system'`, as written). */
  tier: string;
}

/** Result of a successful `updateSpec()` call. */
export interface UpdateSpecResult {
  /** Absolute path to the spec file that was updated. */
  path: string;
  /** The spec's frontmatter `id` (unchanged by this call). */
  id: string;
  /** The spec's frontmatter `tier` (`'feature' | 'system'` — patch tier is rejected earlier). */
  tier: string;
  /** Absolute path to the matching task ledger file. */
  ledgerPath: string;
  /** `t<N>` ids of the new ledger rows appended by the sync pass, in append order (empty if none). */
  syncedTaskIds: string[];
  /** The exact `## Delta — ...` heading text that is now "current" — either just-reused or freshly appended. */
  deltaHeading: string;
  /**
   * `true` if `deltaHeading` refers to an already-existing, still-empty
   * heading that was reused (no new heading appended — a true no-op
   * re-run); `false` if a fresh heading was appended by this call.
   */
  deltaHeadingReused: boolean;
}

/**
 * `YYYY-MM-DD`, from the local calendar date at write time (not UTC) — same
 * rationale, and same implementation, as `new-spec.ts`'s own (unexported)
 * `todayIsoDate()`: a user running the command late at night or early
 * morning should get the date that matches their own "today," not UTC's.
 *
 * Exported so `approve.ts` (Story 3.4) can stamp `approved_at` with the exact
 * same "today" semantics as everything else in this codebase, instead of a
 * second, potentially-drifting implementation.
 */
export function todayIsoDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Matches the leading `---\n...\n---\n` frontmatter block, capturing the inner YAML text. */
const FRONTMATTER_BLOCK_PATTERN = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/;

/**
 * Splits a spec file's raw text into its frontmatter block (the exact
 * substring from the opening `---` through the closing `---` and its
 * trailing newline, verbatim) and everything after it (the markdown body).
 * Returns `null` if `raw` doesn't start with a well-formed frontmatter block.
 *
 * The frontmatter block is kept as a raw, unparsed string — never
 * re-serialized — so `updateSpec()` can guarantee it round-trips
 * byte-identical, per this story's "never modify the spec's frontmatter"
 * constraint.
 *
 * Exported so `approve.ts` (Story 3.4) can reuse the identical byte-fidelity
 * isolation logic for its own targeted, line-level frontmatter edits, rather
 * than re-deriving the same substring split a second time.
 */
export function splitFrontmatter(raw: string): { frontmatterBlock: string; body: string } | null {
  const match = raw.match(FRONTMATTER_BLOCK_PATTERN);
  if (!match) return null;
  return { frontmatterBlock: match[1]!, body: match[2]! };
}

const VALID_TIERS = new Set(['patch', 'feature', 'system']);

/**
 * Parses just the `id`/`tier` fields out of a spec file's frontmatter.
 * Returns `null` if the file has no well-formed frontmatter block, is
 * missing either field as a string, or has a `tier` value other than
 * exactly `'patch'`, `'feature'`, or `'system'` — a spec with a corrupted or
 * unexpected `tier` must never be silently treated as feature-tier. Either
 * way, the file is silently skipped by `findSpecById`'s search rather than
 * treated as a fatal error, since an unrelated malformed file elsewhere in
 * `specs/` must not block locating the one the caller actually asked for.
 */
function parseFrontmatterIdAndTier(raw: string): { id: string; tier: string } | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  const inner = split.frontmatterBlock.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n$/, '');
  try {
    const parsed = parse(inner) as Record<string, unknown> | null;
    if (
      !parsed ||
      typeof parsed.id !== 'string' ||
      typeof parsed.tier !== 'string' ||
      !VALID_TIERS.has(parsed.tier)
    ) {
      return null;
    }
    return { id: parsed.id, tier: parsed.tier };
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
 * Locates the spec whose frontmatter `id` field equals `specId`, searching
 * every spec file across all three tiers (`specs/patches/<name>.md`,
 * `specs/features/<name>.md`, `specs/systems/<name>/prd.md`) — deliberately
 * by reading and matching each file's actual frontmatter, never by parsing
 * `specId` itself into a path (per this story's Boundaries & Constraints).
 *
 * Scans every candidate (not just until the first hit) so that two files
 * sharing the same `id` is detected rather than silently resolved to
 * whichever happened to be listed first — see `DuplicateSpecIdError`.
 *
 * Returns `null` if no spec matches.
 */
export async function findSpecById(cwd: string, specId: string): Promise<FoundSpec | null> {
  const patchesDir = path.join(cwd, 'specs', 'patches');
  const featuresDir = path.join(cwd, 'specs', 'features');
  const systemsDir = path.join(cwd, 'specs', 'systems');

  const candidatePaths: string[] = [];

  for (const name of await safeReaddirNames(patchesDir)) {
    if (name.endsWith('.md')) candidatePaths.push(path.join(patchesDir, name));
  }
  for (const name of await safeReaddirNames(featuresDir)) {
    if (name.endsWith('.md')) candidatePaths.push(path.join(featuresDir, name));
  }
  for (const dirName of await safeReaddirSystemDirNames(systemsDir)) {
    candidatePaths.push(path.join(systemsDir, dirName, 'prd.md'));
  }

  const matches: FoundSpec[] = [];

  for (const candidatePath of candidatePaths) {
    let raw: string;
    try {
      raw = await readFile(candidatePath, 'utf8');
    } catch {
      // Vanished between the directory listing and the read (e.g. a
      // concurrent delete), or unreadable for some other reason — either
      // way, not a match; keep searching the rest.
      continue;
    }
    const frontmatter = parseFrontmatterIdAndTier(raw);
    if (frontmatter && frontmatter.id === specId) {
      matches.push({ path: candidatePath, id: frontmatter.id, tier: frontmatter.tier });
    }
  }

  if (matches.length > 1) {
    throw new DuplicateSpecIdError(
      specId,
      matches.map((m) => m.path)
    );
  }

  return matches[0] ?? null;
}

/**
 * Locates every spec file across all three tiers (`specs/patches/<name>.md`,
 * `specs/features/<name>.md`, `specs/systems/<name>/prd.md`) whose
 * frontmatter parses successfully, returning one `FoundSpec` per match — the
 * same directory walk and frontmatter parsing `findSpecById` already
 * performs, generalized to return every hit instead of filtering to a single
 * `specId`. Unlike `findSpecById`, this never throws `DuplicateSpecIdError`:
 * that concept ("two files claim the same id") doesn't apply to a call whose
 * whole point is to return every match, not resolve one specific id.
 *
 * A file that fails to parse (missing/malformed frontmatter, an invalid
 * `tier`) is silently skipped, exactly as `findSpecById` already tolerates
 * for its own candidates — an unrelated malformed file elsewhere in `specs/`
 * must not block reporting every other spec that did parse.
 */
export async function findAllSpecs(cwd: string): Promise<FoundSpec[]> {
  const patchesDir = path.join(cwd, 'specs', 'patches');
  const featuresDir = path.join(cwd, 'specs', 'features');
  const systemsDir = path.join(cwd, 'specs', 'systems');

  const candidatePaths: string[] = [];

  for (const name of await safeReaddirNames(patchesDir)) {
    if (name.endsWith('.md')) candidatePaths.push(path.join(patchesDir, name));
  }
  for (const name of await safeReaddirNames(featuresDir)) {
    if (name.endsWith('.md')) candidatePaths.push(path.join(featuresDir, name));
  }
  for (const dirName of await safeReaddirSystemDirNames(systemsDir)) {
    candidatePaths.push(path.join(systemsDir, dirName, 'prd.md'));
  }

  const found: FoundSpec[] = [];

  for (const candidatePath of candidatePaths) {
    let raw: string;
    try {
      raw = await readFile(candidatePath, 'utf8');
    } catch {
      // Vanished between the directory listing and the read (e.g. a
      // concurrent delete), or unreadable for some other reason — either
      // way, not a match; keep walking the rest of the candidates.
      continue;
    }
    const frontmatter = parseFrontmatterIdAndTier(raw);
    if (frontmatter) {
      found.push({ path: candidatePath, id: frontmatter.id, tier: frontmatter.tier });
    }
  }

  return found;
}

// Matches a top-level `## Delta — ...` heading line, capturing its date and
// an optional `(N)` disambiguation suffix. `renderDeltaBlock`/`nextDeltaHeading`
// always *generate* the canonical em dash (`—`) form, but *parsing* tolerates
// an em dash, en dash, or plain hyphen in that position, so a hand-typed
// heading using a different dash character than the template's own still
// matches instead of silently falling outside every delta block.
const DELTA_HEADING_PATTERN = /^##\s+Delta\s+[–—-]\s+(\d{4}-\d{2}-\d{2})(?:\s+\((\d+)\))?\s*$/;

// Matches a markdown bullet line under a Delta subsection: any of the three
// standard CommonMark unordered-list markers (`-`, `*`, `+`), not just the
// template's own `-`, so a hand-typed bullet using a different marker still
// gets picked up.
const BULLET_LINE_PATTERN = /^\s*[-*+]\s+(.+?)\s*$/;

interface DeltaBlock {
  /** The exact heading line text (trimmed), e.g. `## Delta — 2026-08-21`. */
  heading: string;
  added: string[];
  modified: string[];
  removed: string[];
}

/**
 * Parses `body` into an ordered list of `## Delta — ...` blocks (document
 * order — the last entry is always the most recently appended, since the
 * scaffold pass only ever appends at the end of the body), each with its
 * `### ADDED`/`### MODIFIED`/`### REMOVED` bullet lines collected
 * separately.
 *
 * Nesting is tracked line-by-line: encountering any other `## ...` heading
 * exits the current Delta block (so trailing content, if any, is never
 * mistaken for a Delta block's), and encountering any `### ...` heading
 * (the three recognized subsections included) exits/re-enters the relevant
 * subsection tracker.
 */
function parseDeltaBlocks(body: string): DeltaBlock[] {
  const lines = body.split(/\r?\n/);
  const blocks: DeltaBlock[] = [];
  let current: DeltaBlock | null = null;
  let currentSubsection: 'ADDED' | 'MODIFIED' | 'REMOVED' | null = null;

  for (const line of lines) {
    const h2Match = /^##\s+(.*)$/.exec(line);
    if (h2Match) {
      current = DELTA_HEADING_PATTERN.test(line)
        ? { heading: line.trim(), added: [], modified: [], removed: [] }
        : null;
      if (current) blocks.push(current);
      currentSubsection = null;
      continue;
    }

    const h3Match = /^###\s+(.*)$/.exec(line);
    if (h3Match) {
      const label = h3Match[1]!.trim();
      currentSubsection =
        current && (label === 'ADDED' || label === 'MODIFIED' || label === 'REMOVED')
          ? label
          : null;
      continue;
    }

    if (current && currentSubsection) {
      const bulletMatch = BULLET_LINE_PATTERN.exec(line);
      if (bulletMatch) {
        const text = bulletMatch[1]!;
        if (currentSubsection === 'ADDED') current.added.push(text);
        else if (currentSubsection === 'MODIFIED') current.modified.push(text);
        else current.removed.push(text);
      }
    }
  }

  return blocks;
}

/** Every `### ADDED` bullet's trimmed text, across every Delta block in `body`, in document order. */
function extractAddedBullets(body: string): string[] {
  return parseDeltaBlocks(body).flatMap((block) => block.added);
}

/** `true` if none of a Delta block's three subsections have any bullet content. */
function deltaBlockIsEmpty(block: DeltaBlock): boolean {
  return block.added.length === 0 && block.modified.length === 0 && block.removed.length === 0;
}

/**
 * Builds the exact `## Delta — <date>` heading text for a *new* scaffold
 * block, disambiguating against every existing `## Delta — <date>` heading
 * already in `body` for that same date: the first heading for a date is
 * bare, the second gets ` (2)`, the third ` (3)`, and so on — never reusing
 * a suffix, even across multiple runs on the same day. Always generates the
 * canonical em dash (`—`) form, regardless of what dash character any
 * existing headings happen to use.
 */
function nextDeltaHeading(body: string, isoDate: string): string {
  const lines = body.split(/\r?\n/);
  let countForToday = 0;

  for (const line of lines) {
    const match = line.match(DELTA_HEADING_PATTERN);
    if (match && match[1] === isoDate) {
      countForToday++;
    }
  }

  return countForToday === 0
    ? `## Delta — ${isoDate}`
    : `## Delta — ${isoDate} (${countForToday + 1})`;
}

/** Renders an empty scaffold Delta block (heading + three empty subsections) ready to append to a spec body. */
function renderDeltaBlock(heading: string): string {
  return `${heading}\n\n### ADDED\n\n### MODIFIED\n\n### REMOVED\n`;
}

/** The highest numeric suffix among `t<N>`-shaped ledger task ids, or `0` if there are none. */
function maxTaskNumber(tasks: Array<{ id: unknown }>): number {
  let max = 0;
  for (const task of tasks) {
    const match = /^t(\d+)$/.exec(String(task.id));
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}

interface LedgerTaskRow {
  id: string;
  phase?: number;
  description: string;
  status: 'pending' | 'in-progress' | 'done';
  linked_commit: string | null;
  verified_by_gate: boolean;
}

interface LedgerFile {
  spec_id: string;
  tasks: LedgerTaskRow[];
}

/**
 * Reads and parses `ledgerPath`, throwing a clear `LedgerNotFoundError`
 * (instead of letting a raw `ENOENT`/YAML-parse/`TypeError` escape) if the
 * file can't be read, isn't valid YAML, or doesn't parse to an object with a
 * top-level `tasks` array.
 */
async function readLedger(ledgerPath: string): Promise<LedgerFile> {
  let ledgerRaw: string;
  try {
    ledgerRaw = await readFile(ledgerPath, 'utf8');
  } catch (err) {
    throw new LedgerNotFoundError(ledgerPath, err instanceof Error ? err.message : String(err));
  }

  let parsed: unknown;
  try {
    parsed = parse(ledgerRaw);
  } catch (err) {
    throw new LedgerNotFoundError(ledgerPath, err instanceof Error ? err.message : String(err));
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Record<string, unknown>).tasks)
  ) {
    throw new LedgerNotFoundError(ledgerPath, "missing a top-level 'tasks' array");
  }

  return parsed as LedgerFile;
}

// Matches the shape every `create*Spec()` function actually generates
// (`patch-<date>-<name>`, `feat-<date>-<name>`, `system-<date>-<name>`).
// Defensive only: guards against a corrupted or adversarial frontmatter
// `id` value escaping the `tasks/` directory when it's used to build
// `ledgerPath` below — a real spec's id can never fail this check.
const SPEC_ID_SHAPE_PATTERN = /^(patch|feat|system)-\d{4}-\d{2}-\d{2}-[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Runs `waypoint update <spec-id>`'s sync-then-scaffold pass against the spec
 * matching `specId` in `cwd`, per this story's Boundaries & Constraints:
 *
 * 1. Locate the spec by frontmatter `id` (`findSpecById`) — errors naming the
 *    missing id if none matches, before writing anything.
 * 2. Reject patch-tier specs — they have no ledger to sync into.
 * 3. Sync pass: parse every `### ADDED` bullet under any `## Delta — ...`
 *    heading in the spec's body, and append a new `pending` ledger row (next
 *    available `t<N>` id; System-tier rows default `phase: 1`) for each
 *    bullet whose trimmed text doesn't already exactly match an existing
 *    task's `description`. Existing rows are never rewritten.
 * 4. Scaffold pass: if the most recently appended delta heading is still
 *    completely empty, reuse it (no write to the spec file at all — nothing
 *    changed). Otherwise, append a fresh, empty `## Delta — <date>` block,
 *    disambiguated with `(2)`, `(3)`, ... if one was already appended today.
 * 5. Write the ledger only if the sync pass added rows; write the spec only
 *    if the scaffold pass appended a new heading. The spec's frontmatter
 *    block is carried through byte-identical whenever the spec is written —
 *    only the body after it is ever touched.
 */
export async function updateSpec(cwd: string, specId: string): Promise<UpdateSpecResult> {
  const found = await findSpecById(cwd, specId);
  if (!found) {
    throw new SpecNotFoundError(specId);
  }
  if (found.tier === 'patch') {
    throw new PatchTierUpdateNotSupportedError(specId);
  }
  if (!SPEC_ID_SHAPE_PATTERN.test(found.id)) {
    throw new SpecNotFoundError(specId);
  }

  const raw = await readFile(found.path, 'utf8');
  const split = splitFrontmatter(raw);
  if (!split) {
    // Already validated as parseable when `findSpecById` matched it above —
    // reaching here would mean the file changed between that read and this
    // one. Surface a clear error rather than silently corrupting the file.
    throw new Error(`'${found.path}' does not have a well-formed frontmatter block.`);
  }
  const { frontmatterBlock, body } = split;

  const ledgerPath = path.join(cwd, 'tasks', `${found.id}.ledger.yaml`);
  const ledger = await readLedger(ledgerPath);

  // --- Sync pass ---
  const existingDescriptions = new Set(ledger.tasks.map((t) => t.description.trim()));
  const addedBullets = extractAddedBullets(body);
  let nextTaskNumber = maxTaskNumber(ledger.tasks) + 1;
  const syncedTaskIds: string[] = [];

  for (const bulletText of addedBullets) {
    if (existingDescriptions.has(bulletText)) continue;

    const newRow: LedgerTaskRow = {
      id: `t${nextTaskNumber}`,
      ...(found.tier === 'system' ? { phase: 1 } : {}),
      description: bulletText,
      status: 'pending',
      linked_commit: null,
      verified_by_gate: false,
    };
    ledger.tasks.push(newRow);
    syncedTaskIds.push(newRow.id);
    existingDescriptions.add(bulletText);
    nextTaskNumber++;
  }

  if (syncedTaskIds.length > 0) {
    await writeFile(ledgerPath, stringify(ledger), 'utf8');
  }

  // --- Scaffold pass ---
  const blocks = parseDeltaBlocks(body);
  const mostRecentBlock = blocks.length > 0 ? blocks[blocks.length - 1]! : null;

  let deltaHeading: string;
  let deltaHeadingReused: boolean;

  if (mostRecentBlock && deltaBlockIsEmpty(mostRecentBlock)) {
    // True no-op re-run: the most recently appended heading is still
    // completely empty — reuse it instead of littering another one. The
    // spec's body is left exactly as read; no write to the spec file.
    deltaHeading = mostRecentBlock.heading;
    deltaHeadingReused = true;
  } else {
    const isoDate = todayIsoDate();
    deltaHeading = nextDeltaHeading(body, isoDate);
    deltaHeadingReused = false;

    const trimmedBody = body.replace(/\s+$/, '');
    const newBody = `${trimmedBody}\n\n${renderDeltaBlock(deltaHeading)}`;

    // Frontmatter block is carried through unchanged (verbatim), guaranteeing
    // `status`/`approved_by`/`approved_at` remain byte-identical.
    await writeFile(found.path, `${frontmatterBlock}${newBody}`, 'utf8');
  }

  return {
    path: found.path,
    id: found.id,
    tier: found.tier,
    ledgerPath,
    syncedTaskIds,
    deltaHeading,
    deltaHeadingReused,
  };
}
