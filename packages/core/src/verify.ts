import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { acquireLock, releaseLock } from './scaffold.js';

/**
 * `waypoint verify <spec-id> <task-id>` (Story 3.3) — the sole write path for
 * a task ledger's completion fields (`linked_commit`, `status: 'done'`,
 * `verified_by_gate`). Nothing else (hand-edit, free-text agent output, an
 * automatic hook) may ever write those three fields.
 *
 * This module is inherently git-native: `runCheck` shells to the project's
 * own `check_command`; `verifyTask` shells to `git rev-parse`/`add`/`commit`.
 * Unlike Story 3.1/3.2's pure-function-first split, there is no meaningful
 * "primitive vs. CLI wiring" seam here — the git operations are intrinsic to
 * what "verify" means, not an optional caller convenience.
 */

/** Input to `runCheck()`. */
export interface RunCheckInput {
  /** The exact `check_command` string read from `.waypoint/config.yaml` — may be a shell pipeline. */
  checkCommand: string;
  /** The working tree `checkCommand` runs in (this repo, not an isolated checkout). */
  repoRoot: string;
}

/** Result of a `runCheck()` call. */
export interface RunCheckResult {
  ok: boolean;
}

/**
 * Runs `checkCommand` via `execSync(checkCommand, { cwd: repoRoot, stdio:
 * 'inherit' })` in the current working tree — shell semantics are required
 * (`check_command` can be a pipeline, e.g. `npm test && npm run lint`), and
 * output stays live/visible, matching "blocks the same way running the suite
 * manually would." A thrown error (non-zero exit, command not found, ...)
 * maps to `{ ok: false }`; a clean exit maps to `{ ok: true }`.
 */
export function runCheck(input: RunCheckInput): RunCheckResult {
  try {
    execSync(input.checkCommand, { cwd: input.repoRoot, stdio: 'inherit' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Result of a `verifyTask()` call — a discriminated union over every outcome
 * this story's I/O & Edge-Case Matrix defines. `verified`/`already-verified`
 * map to exit code `0`; every other outcome maps to exit code `1` (owned by
 * the CLI layer, not this module).
 */
export type VerifyResult =
  | {
      outcome: 'verified';
      specId: string;
      taskId: string;
      linkedCommit: string;
      /**
       * Set only when the commit landed successfully but the follow-up
       * `.gate-state` integrity-hash write then failed (disk full,
       * permissions, ...). The verification itself is real and complete --
       * this is a non-fatal warning, not a reason to treat the outcome as
       * anything other than `verified`. Without a stored hash, the *next*
       * `verify` call's already-done check will find no hash and report
       * `corrupted`, even though nothing was tampered with -- surfacing the
       * warning here gives the operator a chance to notice and fix it first.
       */
      hashWriteWarning?: string;
    }
  | { outcome: 'already-verified'; specId: string; taskId: string }
  | { outcome: 'check-failed'; specId: string; taskId: string; reason: string }
  | { outcome: 'commit-failed'; specId: string; taskId: string; reason: string }
  | { outcome: 'not-found'; message: string }
  | { outcome: 'no-head'; message: string }
  | { outcome: 'corrupted'; specId: string; taskId: string };

/** A single ledger task row, read/written generically — this module never needs to know about `phase` or any other tier-specific field. */
type LedgerTaskRow = Record<string, unknown> & {
  id: unknown;
  status: unknown;
  linked_commit: unknown;
  verified_by_gate: unknown;
};

/** A ledger file, read/written generically against `{ spec_id, tasks }` so this module works for both Feature and System ledgers unchanged. */
type LedgerFileShape = Record<string, unknown> & {
  tasks: LedgerTaskRow[];
};

const GATE_STATE_DIRNAME = '.gate-state';

/**
 * Repo-root-relative, `/`-separated path to the task ledger for `specId` —
 * a forward-slash literal, not `path.join(...)`, so it stays consistent on
 * every platform: used both in human-readable messages and as the exact
 * pathspec passed to `git add`/`git commit --only` (whose own reporting,
 * e.g. `git show --name-only`, always normalizes to forward-slash
 * regardless of host OS) and to build the absolute path read/written below
 * (`path.join` still resolves a forward-slash segment correctly on every
 * platform, confirmed by direct testing during Story 3.2's planning).
 */
function ledgerRelativePath(specId: string): string {
  return `tasks/${specId}.ledger.yaml`;
}

/**
 * Reads and parses `ledgerAbsPath`, returning both the parsed object and the
 * exact raw text read (needed verbatim for a failed-commit rollback). Returns
 * `null` — never throws — if the file can't be read, isn't valid YAML, or
 * doesn't parse to an object with a top-level `tasks` array; the caller maps
 * that to a clear `not-found` result rather than a raw exception.
 */
async function readLedgerFile(
  ledgerAbsPath: string
): Promise<{ raw: string; parsed: LedgerFileShape } | null> {
  let raw: string;
  try {
    raw = await readFile(ledgerAbsPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return null;
  }

  return { raw, parsed: parsed as LedgerFileShape };
}

/** Internal result of loading and validating `check_command` from `.waypoint/config.yaml`. */
type LoadCheckCommandResult = { ok: true; checkCommand: string } | { ok: false; error: string };

/**
 * Loads and validates `check_command` from `.waypoint/config.yaml` in
 * `repoRoot`. A small, self-contained reader (this story only needs one
 * field) — deliberately not a reuse of `gate-classify.ts`'s
 * `tiers.patch`-specific loader, per this story's Boundaries & Constraints.
 *
 * Every failure mode (missing file, empty file, unparseable YAML,
 * `check_command` not a non-empty string) returns a distinct message naming
 * `.waypoint/config.yaml` — a config problem, never confused with a check
 * that ran and failed.
 */
async function loadCheckCommand(repoRoot: string): Promise<LoadCheckCommandResult> {
  // Forward-slash literal, not `path.join(...)` — see `ledgerRelativePath`'s
  // doc comment for why (the same Windows-backslash-in-messages issue that
  // broke Story 3.2's CONFIG_RELATIVE_PATH once already this session).
  const configRelPath = '.waypoint/config.yaml';
  const configPath = path.join(repoRoot, configRelPath);

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return {
      ok: false,
      error: `config error: '${configRelPath}' was not found. Run 'waypoint install' first.`,
    };
  }

  if (raw.trim().length === 0) {
    return { ok: false, error: `config error: '${configRelPath}' is empty.` };
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `config error: '${configRelPath}' failed to parse as YAML (${reason}).`,
    };
  }

  const checkCommand = (parsed as { check_command?: unknown } | null)?.check_command;
  if (typeof checkCommand !== 'string' || checkCommand.trim().length === 0) {
    return {
      ok: false,
      error: `config error: 'check_command' in '${configRelPath}' is missing or is not a non-empty string.`,
    };
  }

  return { ok: true, checkCommand };
}

/**
 * Resolves current `HEAD` via `git rev-parse HEAD`, never throwing. Bounded
 * with a `timeout` (matches `done-claim.ts`'s `gitStdio()`/`approve.ts`'s
 * `resolveApprovedBy`, both established in later stories) so a hung or
 * misbehaving git invocation can't block the calling process/CLI invocation
 * indefinitely -- a general "don't let a git shell-out hang the whole
 * command" guard, independent of any lock. `verifyTask`'s own call to this
 * function runs strictly *before* `withSpecLock` is ever invoked (lock
 * acquisition happens afterward), so a hang here blocks only the current
 * process's own call; it cannot poison or hold the per-spec lock open, since
 * the lock hasn't been acquired yet at this point. Contrast with the
 * `gitStdio` git calls further down (`git add`/`commit --only`/rollback
 * `reset`), which genuinely DO run inside `withSpecLock`'s critical section
 * -- see that call site's own comment for why a hang *there* would actually
 * hold the lock open (epic-1-5 MVP retrospective, Finding 10; this comment
 * previously conflated the two).
 */
function resolveHead(repoRoot: string): { ok: true; sha: string } | { ok: false } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
    return { ok: true, sha };
  } catch {
    return { ok: false };
  }
}

/**
 * Extracts a short, clear diagnostic from a thrown `execFileSync` error —
 * the first non-empty line of its stderr (or, absent that, its message) —
 * rather than surfacing a raw multi-line git error verbatim. Mirrors
 * `packages/cli/src/commands/gate.ts`'s own stderr-extraction pattern.
 */
function extractGitErrorMessage(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const rawText =
    typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr
      : err instanceof Error
        ? err.message
        : String(err);
  const firstLine = rawText.split('\n').find((line) => line.trim().length > 0) ?? rawText;
  return firstLine.trim();
}

/**
 * `sha256(JSON.stringify({ id, status, verified_by_gate, linked_commit },
 * ['id', 'status', 'verified_by_gate', 'linked_commit']))` — the per-task
 * integrity hash stored in `.waypoint/.gate-state/<spec-id>.json`. Passing the
 * four keys as `JSON.stringify`'s replacer array (rather than relying on the
 * object's own key order) guarantees a fixed, canonical key order regardless
 * of how the ledger's own YAML happened to order them.
 *
 * Deliberately typed as `unknown` for every field, and deliberately NOT
 * type-coerced (no `String(...)`/`Boolean(...)`) anywhere in this module
 * before hashing: this hash exists to catch tampering, including a
 * *type-level* change to a field (e.g. `verified_by_gate` hand-edited from
 * the boolean `true` to the string `"false"`). `JSON.stringify` already
 * encodes a value's type as well as its content (`true` vs `"false"` produce
 * different JSON text), so hashing the raw, as-parsed value is what makes
 * that kind of tamper detectable. Coercing first (e.g. `Boolean("false")`,
 * which is `true` in JavaScript) would silently normalize the tampered value
 * back to the original and reproduce the original hash, defeating the whole
 * point of storing it.
 */
export function computeLedgerTaskHash(fields: {
  id: unknown;
  status: unknown;
  verified_by_gate: unknown;
  linked_commit: unknown;
}): string {
  const canonical = JSON.stringify(
    {
      id: fields.id,
      status: fields.status,
      verified_by_gate: fields.verified_by_gate,
      linked_commit: fields.linked_commit,
    },
    ['id', 'status', 'verified_by_gate', 'linked_commit']
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Extracts a raw ledger task row's hashable fields, verbatim and uncoerced,
 * for `computeLedgerTaskHash`. `task.id` is always the exact string `taskId`
 * both call sites pass in (each finds `task` via `tasks.find((t) => t.id ===
 * taskId)` first), so there is no fallback-id case to handle here.
 */
function hashableFieldsOf(task: LedgerTaskRow): {
  id: unknown;
  status: unknown;
  verified_by_gate: unknown;
  linked_commit: unknown;
} {
  return {
    id: task.id,
    status: task.status,
    verified_by_gate: task.verified_by_gate,
    linked_commit: task.linked_commit,
  };
}

/**
 * Reads the stored hash for `taskId` from `.waypoint/.gate-state/<spec-id>.json`,
 * or `null` if absent/unreadable/not a string.
 *
 * Exported so `status.ts` (Story 5.1) can reuse this exact reader instead of
 * an independently-drifting byte-for-byte copy -- both modules need the
 * identical read (this file's own `.gate-state` sidecar, keyed by task id),
 * and only the surrounding ledger-parsing logic legitimately differs between
 * them (epic-1-5 MVP retrospective, Finding 5).
 */
export async function readStoredHash(repoRoot: string, specId: string, taskId: string): Promise<string | null> {
  const gateStatePath = path.join(repoRoot, '.waypoint', GATE_STATE_DIRNAME, `${specId}.json`);
  try {
    const raw = await readFile(gateStatePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed?.[taskId];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Merges `hash` under `taskId` into `.waypoint/.gate-state/<spec-id>.json`
 * (read existing file if present, merge, write the whole object back) —
 * never a whole-file replace that would erase another task's stored hash.
 * Must only ever be called from inside `withSpecLock`'s critical section —
 * it performs no locking of its own.
 */
async function mergeGateStateHashLocked(
  repoRoot: string,
  specId: string,
  taskId: string,
  hash: string
): Promise<void> {
  const gateStatePath = path.join(repoRoot, '.waypoint', GATE_STATE_DIRNAME, `${specId}.json`);

  let existing: Record<string, string> = {};
  try {
    const raw = await readFile(gateStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, string>;
    }
  } catch {
    // Missing, or malformed — start fresh rather than blocking the write.
    // This file is machine-local, gitignored tamper-detection state, not a
    // source of truth that must be preserved at all costs.
  }

  existing[taskId] = hash;
  await writeFile(gateStatePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}

/**
 * Thrown by `withSpecLock` when the per-spec lock can't be acquired within
 * `LOCK_MAX_WAIT_MS` -- i.e. another `waypoint verify`/`update`/`approve` run
 * on this exact spec is genuinely still in progress. A dedicated class
 * (rather than a plain `Error`) so lock contention is recognizable via
 * `instanceof` as its own first-class, expected outcome -- now that
 * `update`/`approve` share this exact lock too, not just `verify`, every CLI
 * wrapper that can hit it needs to give it that command's own framing
 * instead of falling through to the generic catch-all.
 */
export class LockAcquisitionError extends Error {
  constructor(specId: string) {
    super(
      `could not acquire the lock for spec '${specId}' in time -- another 'waypoint verify'/'update'/'approve' run on this spec may be in progress.`
    );
    this.name = 'LockAcquisitionError';
  }
}

/**
 * Runs `fn` inside an exclusive, per-`specId` lock, guarding the *entire*
 * write-side critical section for that spec: re-reading the ledger, writing
 * it, committing it, and merging the new hash into `.gate-state` — not just
 * the final `.gate-state` write. This is what actually makes "concurrent
 * `verify` calls against the same or sibling tasks in one spec serialize
 * instead of corrupting the file" (Story 3.3's Boundaries & Constraints)
 * true for the ledger too, not only for `.gate-state`: without locking the
 * whole section, a sibling call could read the ledger before another's write
 * landed and then clobber it on its own write.
 *
 * Reuses `scaffold.ts`'s exported `acquireLock`/`releaseLock` mkdir-based
 * helpers, against a lock path distinct from (and never contending with)
 * `waypoint install`'s own `.waypoint/.install.lock`.
 *
 * Exported so `update-spec.ts`'s `updateSpec()` and `approve.ts`'s
 * `approveSpec()` can contend on this *exact same* per-spec lock path
 * (`.waypoint/.gate-state/.verify-<spec-id>.lock`) for their own
 * read-then-write critical sections against the identical ledger and spec
 * file `verifyTask` itself writes to. Before this, `update`/`approve` had no
 * locking at all around either file, a real concurrent-write corruption risk
 * against `verify`'s already-locked writes (epic-1-5 MVP retrospective,
 * Findings 9 and 14) -- two independent locks (one per module) would not
 * have actually serialized anything, since they'd never contend with each
 * other for the same spec.
 */
export async function withSpecLock<T>(repoRoot: string, specId: string, fn: () => Promise<T>): Promise<T> {
  const gateStateDir = path.join(repoRoot, '.waypoint', GATE_STATE_DIRNAME);
  await mkdir(gateStateDir, { recursive: true });

  const lockDir = path.join(gateStateDir, `.verify-${specId}.lock`);
  const acquired = await acquireLock(lockDir);
  if (!acquired) {
    throw new LockAcquisitionError(specId);
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockDir);
  }
}

/**
 * Resolves the `already done` outcome for `task` (used both by phase 1's
 * locked pre-check, before any check is even run, and again by phase 3's
 * locked re-check if a sibling call -- or a second concurrent call on this
 * exact task-id -- finished verifying it while this call was running its own
 * `check_command` or waiting for a lock): recomputes the hash from the
 * task's current field values and compares it to the stored hash. A match is
 * a no-op (`already-verified`); a missing or mismatched hash is `corrupted`
 * -- never silently re-verified or overwritten.
 *
 * Must only ever be called from inside `withSpecLock`'s critical section --
 * it reads `.gate-state` (via `readStoredHash`), and that file is shared
 * across every task in the spec, so reading it outside the lock would race
 * with a sibling task's lock-protected write.
 */
async function resolveAlreadyDone(
  repoRoot: string,
  specId: string,
  taskId: string,
  task: LedgerTaskRow
): Promise<VerifyResult> {
  const currentHash = computeLedgerTaskHash(hashableFieldsOf(task));
  const storedHash = await readStoredHash(repoRoot, specId, taskId);

  if (storedHash !== null && storedHash === currentHash) {
    return { outcome: 'already-verified', specId, taskId };
  }
  return { outcome: 'corrupted', specId, taskId };
}

/**
 * Simple character-denylist path-safety check: `true` if `value` contains
 * `/`, `\`, or `..` -- any of which could let a filesystem path built by
 * simple template interpolation escape its intended directory.
 *
 * Exported so `status.ts` (Story 5.1) can reuse this exact check instead of
 * an independently-drifting copy of its own (epic-1-5 MVP retrospective,
 * Finding 12). Deliberately the *simpler* of this codebase's two path-safety
 * styles -- `update-spec.ts`/`approve.ts`'s own `SPEC_ID_SHAPE_PATTERN` is a
 * stricter allowlist those two modules need because their ids are also
 * frontmatter-sourced *and* they build a ledger path for every tier they
 * support. This simpler denylist is intentionally NOT merged with that
 * stricter pattern: `status.ts` must keep working correctly for a
 * legitimately-located Feature-tier spec whose id doesn't happen to match
 * the strict `<tier>-<date>-<name>` shape, which the stricter pattern would
 * wrongly reject.
 */
export function isPathUnsafeId(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('..');
}

/**
 * Matches the shape every `create*Spec()` function actually generates
 * (`patch-<date>-<name>`, `feat-<date>-<name>`, `system-<date>-<name>`) — the
 * strict allowlist shared by every write-path command that enforces spec-id
 * shape (`update-spec.ts`'s `updateSpec()` and `approve.ts`'s `approveSpec()`,
 * both of which build a `tasks/<id>.ledger.yaml` path from the id and reject
 * anything not matching this shape as `SpecNotFoundError` rather than risk a
 * corrupted/adversarial id escaping the `tasks/` directory). A real spec's id
 * can never fail this check.
 *
 * Exported here (rather than staying duplicated in both call sites) so
 * `update-spec.ts` and `approve.ts` share one definition instead of two
 * independently-drifting copies (epic-1-5 MVP retrospective, Finding 12 --
 * this batch already unified `isPathUnsafeId` for the same reason but left
 * this one duplicated until now).
 *
 * Deliberately NOT merged with `isPathUnsafeId` above, even though both are
 * "spec-id path safety" checks: `isPathUnsafeId` is the simpler, looser
 * denylist `status.ts` needs to keep working correctly for a legitimately-
 * located Feature-tier spec whose id doesn't happen to match this stricter
 * `<tier>-<date>-<name>` shape -- see `isPathUnsafeId`'s own doc comment for
 * why that wider trust boundary must stay separate from this narrower one.
 */
export const SPEC_ID_SHAPE_PATTERN = /^(patch|feat|system)-\d{4}-\d{2}-\d{2}-[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Rejects a path-unsafe `specId` before it's used to build this module's
 * filesystem locations (the task ledger path, the `.gate-state` path, and
 * the verify-lock directory name are all built directly from `specId`) --
 * mirrors `new-spec.ts`'s `isValidName`/`InvalidSpecNameError` guard on
 * `waypoint new-patch`/`new-feature`/`new-system`'s `<name>` argument,
 * adapted to this module's result-returning (rather than throwing) style.
 *
 * `taskId` is validated by the identical check too, even though -- unlike
 * `specId` -- it is never actually used to build any path in this module:
 * `taskId` is only ever compared against a ledger row's own `id` field, in
 * memory, after the ledger has already been read via `specId`-derived paths.
 * Rejecting a path-unsafe `taskId` up front is still worthwhile defense in
 * depth (and gives a clear, on-brand `not-found` message instead of a
 * confusing "no such task" for an obviously-malformed argument), but it is
 * not a path-construction guard the way `specId`'s check is.
 *
 * Returns a `not-found`-shaped `VerifyResult` -- the same class of "the
 * target doesn't resolve to something valid" as the existing not-found
 * cases -- for the first offending id, or `null` if both are safe.
 */
function validatePathSafeIds(specId: string, taskId: string): VerifyResult | null {
  if (isPathUnsafeId(specId)) {
    return {
      outcome: 'not-found',
      message: `invalid spec-id '${specId}': must not contain '/', '\\', or '..'.`,
    };
  }
  if (isPathUnsafeId(taskId)) {
    return {
      outcome: 'not-found',
      message: `invalid task-id '${taskId}': must not contain '/', '\\', or '..'.`,
    };
  }
  return null;
}

function ledgerNotFoundResult(specId: string): VerifyResult {
  return {
    outcome: 'not-found',
    message: `no task ledger found at '${ledgerRelativePath(specId)}' (or it isn't valid YAML with a top-level 'tasks' array).`,
  };
}

function taskNotFoundResult(specId: string, taskId: string): VerifyResult {
  return {
    outcome: 'not-found',
    message: `no task '${taskId}' found in '${ledgerRelativePath(specId)}'.`,
  };
}

/** Internal phase-1 signal: either resolve immediately with `result`, or release the lock and fall through to phase 2. */
type Phase1Outcome = { proceed: false; result: VerifyResult } | { proceed: true };

/**
 * `verifyTask(repoRoot, specId, taskId)` — the sole write path for a task
 * ledger's `linked_commit`/`status: 'done'`/`verified_by_gate` fields. See
 * this story's Boundaries & Constraints for the full behavioral contract;
 * summarized:
 *
 * 0. Reject a path-unsafe `specId`/`taskId` (containing `/`, `\`, or `..`)
 *    before anything else -- both are used to build filesystem paths.
 * 1. Resolve `HEAD` -- a repo with no commits yet errors clearly (`no-head`),
 *    before anything else is even attempted.
 * 2. **Phase 1 (locked):** acquire the per-spec write lock, read the ledger,
 *    and resolve the target task. Ledger/task missing -> `not-found`. Task
 *    already `done` -> resolve via `resolveAlreadyDone` (lock-protected, so
 *    it can't race a sibling task's lock-protected `.gate-state` write) and
 *    return that result. Otherwise release the lock and fall through.
 * 3. **Phase 2 (unlocked, deliberate):** load `check_command` from config (a
 *    config problem is its own clear `check-failed` reason, distinct from a
 *    failing check) and run it. Failure -> `check-failed`, nothing written.
 *    Running this unlocked lets two sibling tasks' potentially-expensive
 *    checks run concurrently instead of needlessly serializing.
 * 4. **Phase 3 (locked):** re-acquire the lock and re-read the ledger fresh
 *    (never phase 1's snapshot -- a sibling call, or a second concurrent
 *    call on this exact task-id, may have completed in the meantime). If
 *    now `done`, resolve via `resolveAlreadyDone` again. Otherwise update
 *    the task's three fields, write the ledger, `git add` then `git commit
 *    --only` it. Any failure from the write through the commit rolls the
 *    ledger content and git index back to their captured originals and
 *    reports `commit-failed`. Only after the commit succeeds is the new
 *    integrity hash merge-written into `.gate-state` -> `verified` (a
 *    failure at just this last step doesn't undo the real, already-landed
 *    commit -- it's reported as a non-fatal `hashWriteWarning` instead).
 */
export async function verifyTask(repoRoot: string, specId: string, taskId: string): Promise<VerifyResult> {
  const idValidationError = validatePathSafeIds(specId, taskId);
  if (idValidationError) {
    return idValidationError;
  }

  const head = resolveHead(repoRoot);
  if (!head.ok) {
    return {
      outcome: 'no-head',
      message:
        "no commits found in this repository ('git rev-parse HEAD' failed) -- commit at least once before running 'waypoint verify'.",
    };
  }

  const ledgerAbsPath = path.join(repoRoot, ledgerRelativePath(specId));

  // Phase 1 (locked): every read of ledger/gate-state state must happen
  // under the lock, so this pre-check can't race a sibling task's
  // lock-protected write to the same shared `.gate-state/<spec-id>.json`.
  const phase1 = await withSpecLock(repoRoot, specId, async (): Promise<Phase1Outcome> => {
    const preCheck = await readLedgerFile(ledgerAbsPath);
    if (!preCheck) {
      return { proceed: false, result: ledgerNotFoundResult(specId) };
    }

    const preCheckTask = preCheck.parsed.tasks.find((t) => t && typeof t === 'object' && t.id === taskId);
    if (!preCheckTask) {
      return { proceed: false, result: taskNotFoundResult(specId, taskId) };
    }

    if (preCheckTask.status === 'done') {
      return { proceed: false, result: await resolveAlreadyDone(repoRoot, specId, taskId, preCheckTask) };
    }

    return { proceed: true };
  });

  if (!phase1.proceed) {
    return phase1.result;
  }

  // Phase 2 (unlocked, deliberate): running `check_command` outside the lock
  // lets two sibling tasks' checks run concurrently instead of serializing.
  const configResult = await loadCheckCommand(repoRoot);
  if (!configResult.ok) {
    return { outcome: 'check-failed', specId, taskId, reason: configResult.error };
  }

  const checkResult = runCheck({ checkCommand: configResult.checkCommand, repoRoot });
  if (!checkResult.ok) {
    return {
      outcome: 'check-failed',
      specId,
      taskId,
      reason: `check_command ('${configResult.checkCommand}') exited non-zero (or failed to run).`,
    };
  }

  // Phase 3 (locked): re-acquire the lock -- a separate acquisition from
  // phase 1's, not a re-entrant hold of the same one -- and re-read the
  // ledger fresh before writing.
  return withSpecLock(repoRoot, specId, async (): Promise<VerifyResult> => {
    const fresh = await readLedgerFile(ledgerAbsPath);
    if (!fresh) {
      return ledgerNotFoundResult(specId);
    }

    const freshTask = fresh.parsed.tasks.find((t) => t && typeof t === 'object' && t.id === taskId);
    if (!freshTask) {
      return taskNotFoundResult(specId, taskId);
    }

    if (freshTask.status === 'done') {
      // A sibling `verify` call -- or a second concurrent call on this exact
      // task-id -- already completed this task while we were running our
      // own check_command or waiting for this lock -- resolve exactly like
      // phase 1's already-done path instead of blindly overwriting it.
      return resolveAlreadyDone(repoRoot, specId, taskId, freshTask);
    }

    freshTask.linked_commit = head.sha;
    freshTask.status = 'done';
    freshTask.verified_by_gate = true;

    // Reuse `ledgerRelativePath(specId)` directly rather than re-deriving via
    // `path.relative(repoRoot, ledgerAbsPath)` — `path.relative`'s own output
    // is always OS-native-separated (backslash on Windows), which git accepts
    // as a pathspec but reports back forward-slash-normalized regardless
    // (e.g. via `git show --name-only`), corrupting the exact-string
    // comparisons this module's callers rely on.
    const relLedgerPath = ledgerRelativePath(specId);
    // `timeout` bounds every git call below (add/commit/reset) -- these run
    // inside `withSpecLock`'s critical section, so a hang here would
    // otherwise poison every future command contending on this same
    // per-spec lock, not just this one call (epic-1-5 MVP retrospective,
    // Finding 10). Matches `done-claim.ts`'s `gitStdio()` value.
    const gitStdio: { cwd: string; encoding: 'utf8'; stdio: ['pipe', 'pipe', 'pipe']; timeout: number } = {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    };

    try {
      await writeFile(ledgerAbsPath, stringify(fresh.parsed), 'utf8');
      // `git add` first is required even for an already-tracked file:
      // bare `--only` fails outright for a ledger that was never committed
      // before. `add` then `--only` handles both the never-committed and
      // already-tracked-and-modified cases identically, and leaves any
      // other already-staged file's own staged changes untouched.
      execFileSync('git', ['add', relLedgerPath], gitStdio);
      execFileSync(
        'git',
        ['commit', '--only', relLedgerPath, '-m', `chore(waypoint): verify ${taskId}`],
        gitStdio
      );
    } catch (err) {
      await writeFile(ledgerAbsPath, fresh.raw, 'utf8').catch(() => {
        // Best-effort: the caller's own commit-failed report below is the
        // real reason we're rolling back, and must still win.
      });
      try {
        execFileSync('git', ['reset', '--', relLedgerPath], gitStdio);
      } catch {
        // Best-effort: never let a stray staged diff survive a failed
        // verify, but a failure to reset must not mask the original error.
      }
      return { outcome: 'commit-failed', specId, taskId, reason: extractGitErrorMessage(err) };
    }

    // Only after the commit has succeeded is the integrity hash computed and
    // merge-written -- never before, so a crash between the two steps can't
    // leave an orphaned hash for a commit that never landed.
    const newHash = computeLedgerTaskHash({
      id: taskId,
      status: 'done',
      verified_by_gate: true,
      linked_commit: head.sha,
    });

    let hashWriteWarning: string | undefined;
    try {
      await mergeGateStateHashLocked(repoRoot, specId, taskId, newHash);
    } catch (err) {
      // The commit already landed -- this is a real, complete verification.
      // A failure here (disk full, permissions on `.waypoint/.gate-state/`,
      // ...) must not be reported as a failed verify, and must not silently
      // vanish either: without a stored hash, the *next* `verify` call's
      // already-done check will find no hash and report `corrupted`, even
      // though nothing was tampered with. Surface it as a non-fatal warning
      // instead.
      const reason = err instanceof Error ? err.message : String(err);
      hashWriteWarning =
        `the commit for '${taskId}' succeeded, but writing its integrity hash to '.gate-state' ` +
        `failed (${reason}) -- a future 'verify' run on this task may incorrectly report CORRUPTED.`;
    }

    return {
      outcome: 'verified',
      specId,
      taskId,
      linkedCommit: head.sha,
      ...(hashWriteWarning ? { hashWriteWarning } : {}),
    };
  });
}
