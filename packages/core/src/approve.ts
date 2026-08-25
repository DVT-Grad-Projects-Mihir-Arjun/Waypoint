import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import {
  findSpecById,
  LedgerNotFoundError,
  SpecNotFoundError,
  splitFrontmatter,
  todayIsoDate,
} from './update-spec.js';
import type { FoundSpec } from './update-spec.js';
import { SPEC_ID_SHAPE_PATTERN, withSpecLock } from './verify.js';

/**
 * `waypoint approve <spec-id>` (Story 3.4) — the sole mechanism that moves a
 * Feature/System-tier spec from `draft` to `approved` (the FR8 approval
 * gate). Deliberately a human-run CLI command, not something an agent is
 * meant to invoke directly — but that "not agent-callable" guarantee is a
 * documentation-layer convention (Epic 4 Story 4.1 excludes `approve` from
 * `AGENTS.md`'s action list), not anything this module itself technically
 * enforces. Nothing here checks who is running it.
 *
 * Every write is a targeted, line-level replacement within the frontmatter
 * block only (via `splitFrontmatter`/regex substitutions on fixed-shape
 * lines) — never a full parse-and-`yaml.stringify()` round trip — so
 * everything else in the file (body, comments, key order, whitespace)
 * round-trips byte-for-byte. See this story's Boundaries & Constraints.
 */

/**
 * Thrown when `<spec-id>` resolves to a patch-tier spec. Patch tier has no
 * approval concept at all (no `status`/`approved_by`/`approved_at` gate to
 * flip), and isn't supported by `approve`. Mirrors
 * `PatchTierUpdateNotSupportedError`'s shape, but with its own accurate
 * message — that class's own message says "isn't supported by 'update',"
 * which would be misleading here. Thrown before any filesystem write.
 */
export class PatchTierApprovalNotSupportedError extends Error {
  readonly specId: string;

  constructor(specId: string) {
    super(
      `'${specId}' is a patch-tier spec. Patch tier has no approval concept -- ` +
        "there is no 'draft' -> 'approved' gate for 'approve' to move."
    );
    this.name = 'PatchTierApprovalNotSupportedError';
    this.specId = specId;
  }
}

/**
 * Thrown when a frontmatter field this module needs to replace (or a
 * structural feature it needs to insert next to, e.g. the frontmatter
 * block's closing fence) can't be found -- most commonly because the spec
 * was hand-edited after being scaffolded. Mirrors
 * `PatchTierApprovalNotSupportedError`'s shape (a `specId` field, a clear
 * message) so the CLI can give it the same consistent `waypoint approve: `
 * prefix as every other known `approve` failure, instead of the generic
 * catch-all's plain `Error: ` prefix.
 */
export class FrontmatterFieldNotFoundError extends Error {
  readonly specId: string;

  constructor(specId: string, specPath: string, fieldDescription: string) {
    super(
      `cannot approve '${specId}': expected frontmatter field ${fieldDescription} was not found ` +
        `in '${specPath}' -- it may have been hand-edited. No changes were written.`
    );
    this.name = 'FrontmatterFieldNotFoundError';
    this.specId = specId;
  }
}

/**
 * Thrown for a System-tier spec whose ledger has zero tasks carrying a
 * numeric `phase` field (an empty or corrupted ledger). Distinct from the
 * genuine "every phase already approved" no-op, which requires at least one
 * distinct phase to exist -- without this check, a ledger like this would be
 * silently treated as fully approved even though `status` was never actually
 * set to `'approved'`, producing a permanently misleading report for a spec
 * that can never become approvable.
 */
export class NoPhaseTrackedTasksError extends Error {
  readonly specId: string;
  readonly ledgerPath: string;

  constructor(specId: string, ledgerPath: string) {
    super(
      `cannot approve '${specId}': its ledger '${ledgerPath}' has no phase-tagged tasks to approve ` +
        "(no task in the ledger carries a numeric 'phase' field). The ledger may be empty or corrupted."
    );
    this.name = 'NoPhaseTrackedTasksError';
    this.specId = specId;
    this.ledgerPath = ledgerPath;
  }
}

/**
 * Result of a successful `approveSpec()` call. Errors (unknown spec-id,
 * patch-tier spec) are thrown, not represented here -- see
 * `SpecNotFoundError`/`PatchTierApprovalNotSupportedError`.
 */
export interface ApproveResult {
  /** Absolute path to the spec file that was inspected/approved (`<name>.md` or a system's `prd.md`). */
  path: string;
  /** The spec's frontmatter `id` (unchanged by this call). */
  id: string;
  /** The spec's frontmatter `tier` -- patch tier is rejected before this result type is ever produced. */
  tier: 'feature' | 'system';
  /**
   * `'already-approved'` means this call wrote nothing -- the spec (Feature
   * tier) or every distinct ledger phase (System tier) was already approved.
   * `'approved'` means this call recorded a new approval (Feature tier's
   * one-shot flip, or one System-tier phase boundary).
   */
  outcome: 'already-approved' | 'approved';
  /**
   * The identity recorded for this approval (Feature tier: the spec's
   * top-level `approved_by`; System tier: the identity recorded for
   * `approvedPhase`'s entry). Reflects the pre-existing value on an
   * `already-approved` no-op, or the newly-resolved value (`git config
   * user.name`, or `null` if unresolvable) on a fresh approval.
   */
  approvedBy: string | null;
  /** The matching `approved_at` date (`YYYY-MM-DD`), by the same rules as `approvedBy`. */
  approvedAt: string | null;
  /**
   * System tier only: the phase number this call recorded a new approval
   * entry for. `null` for Feature tier, and `null` on a System-tier
   * `already-approved` no-op (no phase was touched by this call).
   */
  approvedPhase: number | null;
  /**
   * `true` once the spec's top-level `status` is (or already was)
   * `'approved'`. For Feature tier this is always `true` by the time a
   * result is returned. For System tier this is `true` only once every
   * distinct ledger phase has its own `phase_approvals` entry -- `false`
   * while phase boundaries remain outstanding.
   */
  statusApproved: boolean;
}

/** One entry of a System-tier spec's `phase_approvals` frontmatter array. */
interface PhaseApprovalEntry {
  phase: number;
  approved_by: string | null;
  approved_at: string;
}

/**
 * Resolves `approved_by` via `git config user.name`, shelled safely
 * (`execFileSync`, no shell interpolation) and never throwing -- any failure
 * at all (git not installed, no config set, not a git repo, ...) just
 * resolves to `null`. This is a best-effort convenience, not an identity/auth
 * system -- the AC only requires identity be recorded "optionally."
 *
 * Bounded with a `timeout` (mirrors how `verify.ts`/`gate.ts` bound their own
 * git plumbing calls elsewhere in this codebase) so a hung or misbehaving git
 * invocation (lock contention, an interactive credential prompt, ...) can't
 * block the whole `approve` command indefinitely -- it just degrades to
 * `null`, same as any other failure here.
 */
function resolveApprovedBy(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['config', 'user.name'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/**
 * Renders a string-or-null value as a YAML scalar suitable for a
 * single-line frontmatter replacement: `null` literally, or a JSON-quoted
 * string (JSON string syntax is valid YAML flow-scalar syntax) so any
 * character a resolved git identity might contain (colons, quotes,
 * non-ASCII, ...) round-trips safely without corrupting the line.
 */
function yamlScalar(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

/**
 * Parses a spec's frontmatter block into a plain object, read-only --
 * never used to drive a write (every write in this module is a targeted
 * line-level regex replacement on the original raw text, per this story's
 * byte-fidelity constraint). Returns `{}` if the block's inner text doesn't
 * parse to an object (shouldn't happen for a block `findSpecById` already
 * matched, but defensive rather than throwing on a read-only helper).
 */
function parseFrontmatterObject(frontmatterBlock: string): Record<string, unknown> {
  const inner = frontmatterBlock.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n$/, '');
  let parsed: unknown;
  try {
    parsed = parse(inner);
  } catch {
    return {};
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Replaces the single line matching `pattern` (a `^...$/m`-anchored,
 * whole-line pattern) with `replacement`, or throws a clear error naming the
 * spec and the missing field if no line matches -- per this story's "never a
 * partial or corrupted write" constraint. Since this only ever operates on
 * an in-memory string (never touching the filesystem itself), a throw here
 * can never leave a half-written file: the caller only calls `writeFile`
 * once, after every needed replacement in a given call has already
 * succeeded.
 */
function replaceFrontmatterLine(
  block: string,
  pattern: RegExp,
  replacement: string,
  specId: string,
  specPath: string,
  fieldDescription: string
): string {
  if (!pattern.test(block)) {
    throw new FrontmatterFieldNotFoundError(specId, specPath, fieldDescription);
  }
  return block.replace(pattern, replacement);
}

const STATUS_DRAFT_LINE = /^status: draft$/m;
const APPROVED_BY_NULL_LINE = /^approved_by: null$/m;
const APPROVED_AT_NULL_LINE = /^approved_at: null$/m;

/**
 * Applies the shared "flip `status`/`approved_by`/`approved_at` to their
 * final approved values" transform -- used verbatim by Feature tier's
 * one-shot approval, and by System tier's final phase boundary (which
 * mirrors Feature tier's final state in the same write, per this story's
 * Boundaries & Constraints).
 */
function applyTopLevelApproval(
  block: string,
  specId: string,
  specPath: string,
  approvedBy: string | null,
  approvedAt: string
): string {
  let next = replaceFrontmatterLine(
    block,
    STATUS_DRAFT_LINE,
    'status: approved',
    specId,
    specPath,
    "'status: draft'"
  );
  next = replaceFrontmatterLine(
    next,
    APPROVED_BY_NULL_LINE,
    `approved_by: ${yamlScalar(approvedBy)}`,
    specId,
    specPath,
    "'approved_by: null'"
  );
  next = replaceFrontmatterLine(
    next,
    APPROVED_AT_NULL_LINE,
    `approved_at: ${approvedAt}`,
    specId,
    specPath,
    "'approved_at: null'"
  );
  return next;
}

/**
 * `waypoint approve` for a Feature-tier spec: if already `status: approved`,
 * a no-op reporting the existing values. Otherwise, flips
 * `status`/`approved_by`/`approved_at` to their approved values in one write.
 */
async function approveFeatureSpec(cwd: string, found: FoundSpec): Promise<ApproveResult> {
  const raw = await readFile(found.path, 'utf8');
  const split = splitFrontmatter(raw);
  if (!split) {
    // Already validated as parseable when `findSpecById` matched it above --
    // reaching here would mean the file changed between that read and this
    // one. Surface a clear error rather than silently corrupting the file.
    throw new Error(`'${found.path}' does not have a well-formed frontmatter block.`);
  }
  const { frontmatterBlock, body } = split;
  const fm = parseFrontmatterObject(frontmatterBlock);

  if (fm.status === 'approved') {
    return {
      path: found.path,
      id: found.id,
      tier: 'feature',
      outcome: 'already-approved',
      approvedBy: typeof fm.approved_by === 'string' ? fm.approved_by : null,
      approvedAt: typeof fm.approved_at === 'string' ? fm.approved_at : null,
      approvedPhase: null,
      statusApproved: true,
    };
  }

  const approvedBy = resolveApprovedBy(cwd);
  const approvedAt = todayIsoDate();

  const newFrontmatterBlock = applyTopLevelApproval(
    frontmatterBlock,
    found.id,
    found.path,
    approvedBy,
    approvedAt
  );

  await writeFile(found.path, `${newFrontmatterBlock}${body}`, 'utf8');

  return {
    path: found.path,
    id: found.id,
    tier: 'feature',
    outcome: 'approved',
    approvedBy,
    approvedAt,
    approvedPhase: null,
    statusApproved: true,
  };
}

/**
 * Reads `tasks/<id>.ledger.yaml` and returns the full set of distinct
 * `phase` numbers across its tasks, ascending -- the existing source of
 * truth for "how many phase boundaries exist" (Story 1.3's ledger schema),
 * not a new one. A self-contained reader (mirrors `verify.ts`'s own
 * `readLedgerFile` in *shape* -- a small, dedicated reader that only ever
 * needs the distinct `phase` values, never the full task rows, rather than
 * reusing `update-spec.ts`'s internal, unexported `readLedger`).
 *
 * Unlike `verify.ts`'s `readLedgerFile`, this function is NOT itself
 * non-throwing: a missing/malformed ledger (unreadable file, invalid YAML,
 * no top-level `tasks` array) throws `LedgerNotFoundError` rather than
 * returning `null`. That's intentional, not a bug -- the CLI layer already
 * catches `LedgerNotFoundError` in its known-error list and reports it
 * cleanly, so this is a real, deliberate, already-correctly-handled error
 * path, not a raw crash (epic-1-5 MVP retrospective, Finding 15; a prior
 * version of this comment incorrectly claimed to mirror `readLedgerFile`'s
 * non-throwing convention too).
 */
async function readLedgerDistinctPhases(cwd: string, id: string): Promise<number[]> {
  const ledgerPath = path.join(cwd, 'tasks', `${id}.ledger.yaml`);

  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch (err) {
    throw new LedgerNotFoundError(ledgerPath, err instanceof Error ? err.message : String(err));
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
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

  const tasks = (parsed as { tasks: Array<Record<string, unknown> | null> }).tasks;
  const phases = new Set<number>();
  for (const task of tasks) {
    // A `null`/non-object task row (a plausible hand-edit mistake, e.g. a
    // stray blank list item) must never crash this whole call by accessing
    // `.phase` on it -- skip it and move on, same guard shape
    // `status.ts`/`done-claim.ts` already apply to the identical
    // malformed-row possibility (epic-1-5 MVP retrospective, Finding 8).
    if (!task || typeof task !== 'object') {
      continue;
    }
    if (typeof task.phase === 'number') {
      phases.add(task.phase);
    }
  }
  return Array.from(phases).sort((a, b) => a - b);
}

/**
 * Extracts the existing `phase_approvals` entries from a parsed frontmatter
 * object, tolerating a missing/malformed field (a spec scaffolded before
 * this story shipped has no `phase_approvals` field at all) by treating it
 * as an empty array -- never throwing.
 */
function readPhaseApprovals(fm: Record<string, unknown>): PhaseApprovalEntry[] {
  const raw = fm.phase_approvals;
  if (!Array.isArray(raw)) return [];

  const entries: PhaseApprovalEntry[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).phase === 'number') {
      const record = item as Record<string, unknown>;
      entries.push({
        phase: record.phase as number,
        approved_by: typeof record.approved_by === 'string' ? record.approved_by : null,
        approved_at: typeof record.approved_at === 'string' ? record.approved_at : String(record.approved_at),
      });
    }
  }
  return entries;
}

/**
 * Renders `entries` as the exact single-line `phase_approvals: [...]` text
 * for a targeted line replacement -- `JSON.stringify` produces valid YAML
 * flow syntax (JSON is a syntactic subset of YAML), and is deterministic,
 * so the same entries always render to the same bytes.
 */
function renderPhaseApprovalsLine(entries: PhaseApprovalEntry[]): string {
  return `phase_approvals: ${JSON.stringify(entries)}`;
}

const PHASE_APPROVALS_LINE_PATTERN = /^phase_approvals:.*$/m;
const CLOSING_FENCE_PATTERN = /\r?\n---\r?\n$/;

/**
 * Replaces the existing `phase_approvals: ...` line with `newLine`, or --
 * for a spec scaffolded before this story shipped, which has no such line
 * at all -- inserts `newLine` as a fresh line immediately before the
 * frontmatter block's closing `---` fence. Either way, every other line in
 * the block is left byte-identical.
 */
function upsertPhaseApprovalsLine(
  frontmatterBlock: string,
  newLine: string,
  specId: string,
  specPath: string
): string {
  if (PHASE_APPROVALS_LINE_PATTERN.test(frontmatterBlock)) {
    return frontmatterBlock.replace(PHASE_APPROVALS_LINE_PATTERN, newLine);
  }

  const match = frontmatterBlock.match(CLOSING_FENCE_PATTERN);
  if (!match || match.index === undefined) {
    // `findSpecById` only ever matches files `splitFrontmatter` already
    // parsed successfully, so this would mean the file changed underneath
    // this call between that read and now.
    throw new FrontmatterFieldNotFoundError(
      specId,
      specPath,
      "the frontmatter block's closing '---' fence"
    );
  }
  const idx = match.index;
  return `${frontmatterBlock.slice(0, idx)}\n${newLine}${frontmatterBlock.slice(idx)}`;
}

/**
 * `waypoint approve` for a System-tier spec: records each phase boundary's
 * approval as its own distinct `phase_approvals` entry (never a single
 * spec-wide flag), keyed off the ledger's existing `phase: number` field as
 * the source of truth for how many phase boundaries exist.
 *
 * If every distinct ledger phase already has an entry, this is a no-op
 * reporting the existing (already-fully-approved) state. Otherwise, the
 * lowest-numbered phase lacking an entry is approved: its entry is appended,
 * and -- only if that was the last remaining phase -- the top-level
 * `status`/`approved_by`/`approved_at` are also flipped to their approved
 * values, in the same write.
 */
async function approveSystemSpec(cwd: string, found: FoundSpec): Promise<ApproveResult> {
  const raw = await readFile(found.path, 'utf8');
  const split = splitFrontmatter(raw);
  if (!split) {
    throw new Error(`'${found.path}' does not have a well-formed frontmatter block.`);
  }
  const { frontmatterBlock, body } = split;
  const fm = parseFrontmatterObject(frontmatterBlock);

  const distinctPhases = await readLedgerDistinctPhases(cwd, found.id);
  if (distinctPhases.length === 0) {
    // An empty/corrupted ledger (no task carries a numeric `phase` field) is
    // NOT the same as "every phase already approved" -- that would silently
    // produce a permanently misleading already-approved report for a spec
    // that can never actually become approvable. Distinguish it with its own
    // error instead.
    throw new NoPhaseTrackedTasksError(found.id, path.join(cwd, 'tasks', `${found.id}.ledger.yaml`));
  }

  const existingApprovals = readPhaseApprovals(fm);
  const alreadyApprovedPhases = new Set(existingApprovals.map((e) => e.phase));
  const remainingPhases = distinctPhases.filter((p) => !alreadyApprovedPhases.has(p));

  if (remainingPhases.length === 0) {
    return {
      path: found.path,
      id: found.id,
      tier: 'system',
      outcome: 'already-approved',
      approvedBy: typeof fm.approved_by === 'string' ? fm.approved_by : null,
      approvedAt: typeof fm.approved_at === 'string' ? fm.approved_at : null,
      approvedPhase: null,
      statusApproved: fm.status === 'approved',
    };
  }

  const phaseToApprove = remainingPhases[0]!;
  const isLastPhase = remainingPhases.length === 1;
  const approvedBy = resolveApprovedBy(cwd);
  const approvedAt = todayIsoDate();

  const newApprovals: PhaseApprovalEntry[] = [
    ...existingApprovals,
    { phase: phaseToApprove, approved_by: approvedBy, approved_at: approvedAt },
  ];

  let newFrontmatterBlock = upsertPhaseApprovalsLine(
    frontmatterBlock,
    renderPhaseApprovalsLine(newApprovals),
    found.id,
    found.path
  );

  // Only flip `status`/`approved_by`/`approved_at` when they haven't already
  // been flipped -- `applyTopLevelApproval` requires finding a literal
  // `status: draft` line, which no longer exists once `status` is already
  // `'approved'` (e.g. a hand-edited ledger, or a future sync path that
  // discovers a "new" remaining phase after the spec was already approved).
  // In that case just record the new phase's entry above and report
  // `statusApproved: true` without touching the already-approved fields again.
  if (isLastPhase && fm.status !== 'approved') {
    newFrontmatterBlock = applyTopLevelApproval(
      newFrontmatterBlock,
      found.id,
      found.path,
      approvedBy,
      approvedAt
    );
  }

  await writeFile(found.path, `${newFrontmatterBlock}${body}`, 'utf8');

  return {
    path: found.path,
    id: found.id,
    tier: 'system',
    outcome: 'approved',
    approvedBy,
    approvedAt,
    approvedPhase: phaseToApprove,
    statusApproved: isLastPhase,
  };
}

// `SPEC_ID_SHAPE_PATTERN` is imported from `verify.ts` (shared with
// `update-spec.ts` -- see that export's own doc comment for why the two
// modules must agree on which ids are valid). `found.id` is always exactly
// the caller's `specId` (`findSpecById` only ever matches by strict string
// equality).
//
// Applied uniformly to both Feature and System tier below (patch tier is
// already rejected earlier). This used to be scoped to System tier only, on
// the reasoning "Feature tier never builds a path from the id" -- true only
// *inside this module*: `update-spec.ts`'s own Feature-tier sync pass also
// builds a `tasks/<id>.ledger.yaml` path from the identical id, so a
// malformed-shaped Feature-tier id used to `approve` successfully and then
// fail `update` for the same id -- an inter-command contract mismatch (see
// the epic-1-5 MVP retrospective, Finding 11). Applying the guard uniformly
// here matches `update-spec.ts`'s own existing behavior for every tier it
// supports, so the two commands agree on which ids are valid. A real spec's
// id can never fail this check.

/**
 * `waypoint approve <spec-id>` (Story 3.4): locates the spec via
 * `findSpecById`, rejects patch tier, and dispatches to the Feature/System
 * tier's own approval routine. See this story's Boundaries & Constraints for
 * the full behavioral contract.
 *
 * The dispatch to `approveFeatureSpec`/`approveSystemSpec` -- each of which
 * reads the spec file (and, for System tier, the ledger) and later writes a
 * modified version derived from that snapshot -- runs inside `verify.ts`'s
 * exported `withSpecLock`, keyed by `found.id`: the *same* per-spec lock
 * path `waypoint verify`/`waypoint update` already use for this spec. Before
 * this, `approveSpec()` had no locking at all, a real concurrent-write
 * corruption risk against a concurrent `waypoint update` on the same spec's
 * file, or a concurrent System-tier `waypoint verify` write to the same
 * ledger `approveSystemSpec` reads (epic-1-5 MVP retrospective, Findings 9
 * and 14).
 */
export async function approveSpec(cwd: string, specId: string): Promise<ApproveResult> {
  const found = await findSpecById(cwd, specId);
  if (!found) {
    // `findSpecById` returns `null` rather than throwing; `SpecNotFoundError`
    // is generic (not `update`-specific), so it's reused directly here.
    throw new SpecNotFoundError(specId);
  }
  if (found.tier === 'patch') {
    throw new PatchTierApprovalNotSupportedError(specId);
  }
  if (!SPEC_ID_SHAPE_PATTERN.test(found.id)) {
    throw new SpecNotFoundError(specId);
  }

  return withSpecLock(cwd, found.id, () =>
    found.tier === 'feature' ? approveFeatureSpec(cwd, found) : approveSystemSpec(cwd, found)
  );
}
