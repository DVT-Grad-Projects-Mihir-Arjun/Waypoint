import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * `checkDoneClaims(repoRoot): Promise<DoneClaimResult>` (Story 3.5) — the
 * done-claim-correctness primitive `waypoint gate --ci` needs alongside
 * `gate()`'s own full-diff spec-delta check: every task any ledger under
 * `tasks/**` claims is `done` must have a `linked_commit` that both resolves
 * to a real commit and is an ancestor of `HEAD`, catching a hand-typed
 * `status: done` that never went through `waypoint verify` on any machine.
 *
 * Read-only, like `gate()` itself: this module never writes to a ledger,
 * `.gate-state`, or anywhere else. `tasks/` is a fixed, non-configurable
 * location (unlike `check-drift.ts`'s full-repo `collectRepoFiles` walk, this
 * is a small, self-contained recursive walk scoped only to that one
 * directory — no glob dependency needed, and no reuse of `check-drift.ts`'s
 * walker, which is unexported and scoped to a different job).
 */

/** One violation (or the single shallow-checkout hint) in a `DoneClaimResult`. */
export interface DoneClaimViolation {
  /**
   * Repo-relative, forward-slash path to the ledger file this violation
   * concerns. Absent only for the one shallow-checkout hint entry, which
   * isn't about any specific ledger.
   */
  ledgerFile?: string;
  /**
   * The task id within `ledgerFile`. Absent for a violation naming the whole
   * ledger file (it failed to parse, or lacks a top-level `tasks` array) and
   * for the shallow-checkout hint.
   */
  taskId?: string;
  reason: string;
}

/** Result of a `checkDoneClaims()` call. */
export interface DoneClaimResult {
  ok: boolean;
  violations: DoneClaimViolation[];
}

/** Shared `execFileSync` options for every git shell-out in this module: never inherit a failing child's raw stderr, and never hang indefinitely. */
function gitStdio(): { stdio: ['pipe', 'pipe', 'pipe']; timeout: number } {
  return { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000 };
}

/**
 * Collects every `*.ledger.yaml` file directly under `<repoRoot>/tasks` (a
 * flat, single-level scan — no recursion into subdirectories), returning
 * repo-relative, forward-slash paths (e.g. `tasks/feat-demo.ledger.yaml`) —
 * built directly from `entry.name`, never via `path.relative` (whose own
 * output is OS-native-separated, backslash on Windows, which would corrupt
 * both the violation messages below and any future exact-string comparison
 * against these paths).
 *
 * Flat by design, matching the identical convention every other ledger
 * consumer (`update-spec.ts`, `approve.ts`, `status.ts`) already assumes —
 * each resolves a ledger only at the flat path `tasks/<id>.ledger.yaml`,
 * and no real scaffolding code ever produces a nested layout. This used to
 * recurse into subdirectories, but that was speculative generality with no
 * current producer: a ledger relocated into a subdirectory would have been
 * found here but reported as unreadable by every other command (epic-1-5
 * MVP retrospective, Finding 17).
 *
 * A `tasks/` directory that can't be read is silently treated as empty
 * rather than failing the whole scan — this mirrors `check-drift.ts`'s own
 * `collectRepoFiles` convention, without reusing that unexported,
 * full-repo-scoped walker. Two distinct cases share this one `catch`, and
 * they are not equally benign: a missing directory (no specs exist yet, or
 * none have ever been scaffolded) is the expected, common case this is
 * meant to handle gracefully. A directory that *exists* but became
 * transiently unreadable (permissions, an I/O fault, removed mid-walk) would
 * ALSO be silently treated as empty by this same `catch` — even though it
 * could hold real `done` ledgers a done-claim check should not silently skip.
 * That is a known, accepted limitation of this fail-open behavior, not a
 * case silently endorsed as equally fine as "missing" -- changing it to
 * fail closed instead is a bigger decision, deliberately out of scope here.
 */
async function collectLedgerFiles(repoRoot: string): Promise<string[]> {
  const tasksDirAbsPath = path.join(repoRoot, 'tasks');

  let entries;
  try {
    entries = await readdir(tasksDirAbsPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.ledger.yaml')) {
      results.push(`tasks/${entry.name}`);
    }
  }
  return results;
}

/** A single ledger task row, read generically — this module only ever inspects `id`, `status`, and `linked_commit`. */
type LedgerTaskRow = Record<string, unknown> & {
  id?: unknown;
  status?: unknown;
  linked_commit?: unknown;
};

/**
 * `linked_commit` is read straight out of a hand-editable YAML file inside
 * the very PR/checkout being checked — never trust its shape before treating
 * it as a positional argument to `git`. `waypoint verify` (the sole
 * legitimate writer of this field) always writes a full 40-character hex
 * SHA (`git rev-parse HEAD` in a standard SHA-1 repository), so that is the
 * *only* shape accepted here; anything else (including an abbreviated hash,
 * or something shaped like a git flag, e.g. `--upload-pack=/tmp/x`) is
 * rejected before ever reaching `execFileSync`.
 *
 * Exactly 40 hex characters, not `{4,40}` — the previous, looser pattern
 * accepted any abbreviated hash from 4 characters up, which was tighter than
 * nothing but looser than what this comment (and `waypoint verify`'s own
 * writer) actually document (epic-1-5 MVP retrospective, Finding 16).
 * Deliberately does NOT also accept a 64-character SHA-256 hash: this
 * codebase's own Technical Assumptions name git as the sole supported VCS
 * with no SHA-256 commitment either way, so widening this pattern for that
 * case is a separate, out-of-scope concern for now.
 */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Runs `git merge-base --is-ancestor -- <commit> HEAD` in `repoRoot`. Exit
 * code 0 means `commit` both resolves to a real object and is an ancestor of
 * `HEAD`; any nonzero exit (a fabricated hash git can't resolve at all, or a
 * real-but-unrelated commit that isn't an ancestor) is treated identically —
 * a single boolean, never a distinction between the two failure shapes.
 *
 * `commit` is validated against `COMMIT_HASH_PATTERN` *before* this function
 * is even called (see `checkDoneClaims` below) — a git-flag-shaped value is
 * never shelled out to git at all. The `--` separator here is a second,
 * defense-in-depth layer so this function is safe to call directly too.
 */
function isAncestorOfHead(repoRoot: string, commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', '--', commit, 'HEAD'], {
      cwd: repoRoot,
      ...gitStdio(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `git rev-parse --is-shallow-repository` in `repoRoot` — purely an
 * informational hint for the caller, never a hard failure. Any failure to
 * run this check itself (git unavailable, not a git repository, ...) is
 * treated as "not shallow": this function's only job is deciding whether to
 * append one extra hint line, never to block or alter the real violations
 * found above it.
 */
function isShallowRepository(repoRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: repoRoot,
      encoding: 'utf8',
      ...gitStdio(),
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Evaluates every `done` task in every `*.ledger.yaml` file under
 * `<repoRoot>/tasks`:
 *
 * - No `tasks/` directory at all -> trivially `{ ok: true, violations: [] }`,
 *   no error.
 * - A ledger file that fails to parse as YAML, or parses without a top-level
 *   `tasks` array, is its own single violation naming that file — checking
 *   continues over every other ledger found rather than aborting the run.
 * - For every task with `status === 'done'` in a successfully-parsed ledger:
 *   a missing/non-string `id` is its own dedicated violation (a malformed
 *   task, never silently coerced into a string and treated as a normal done
 *   claim). A blank/missing/non-string `linked_commit` is a violation,
 *   reported identically to an unresolvable/fabricated commit (never a
 *   softer case). A `linked_commit` that isn't shaped like a plausible
 *   commit hash (see `COMMIT_HASH_PATTERN`) is rejected as its own violation
 *   *before* ever being shelled out to git — this ledger field is always
 *   machine-written by `waypoint verify` as a full SHA, so anything else
 *   (including a git-flag-shaped string) is treated as invalid rather than
 *   passed to `git merge-base` as a positional argument. Otherwise `git
 *   merge-base --is-ancestor <linked_commit> HEAD` is the sole check — never
 *   a re-run of `check_command`.
 * - `git rev-parse --is-shallow-repository` is run once, before any task is
 *   checked. If it reports `true` AND at least one ancestor-check-based
 *   violation was found (not a blank-`linked_commit` or malformed-ledger
 *   violation), exactly one hint entry is appended at the end noting the
 *   checkout may be shallow.
 */
export async function checkDoneClaims(repoRoot: string): Promise<DoneClaimResult> {
  const tasksDirAbsPath = path.join(repoRoot, 'tasks');
  if (!existsSync(tasksDirAbsPath)) {
    return { ok: true, violations: [] };
  }

  // Run once, before checking any tasks — a purely informational hint,
  // decided (and appended, if applicable) only after every ledger has been
  // checked below.
  const shallow = isShallowRepository(repoRoot);

  const ledgerRelPaths = await collectLedgerFiles(repoRoot);
  const violations: DoneClaimViolation[] = [];
  let anyAncestorViolation = false;

  for (const ledgerRelPath of ledgerRelPaths) {
    const ledgerAbsPath = path.join(repoRoot, ledgerRelPath);

    let raw: string;
    try {
      raw = await readFile(ledgerAbsPath, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      violations.push({
        ledgerFile: ledgerRelPath,
        reason: `ledger file could not be read (${reason}).`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      violations.push({
        ledgerFile: ledgerRelPath,
        reason: `ledger file failed to parse as YAML (${reason}).`,
      });
      continue;
    }

    const tasks = (parsed as { tasks?: unknown } | null)?.tasks;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(tasks)) {
      violations.push({
        ledgerFile: ledgerRelPath,
        reason: "ledger file does not contain a top-level 'tasks' array.",
      });
      continue;
    }

    for (const task of tasks as LedgerTaskRow[]) {
      if (!task || task.status !== 'done') continue;

      // A missing/non-string `id` is a distinct, dedicated violation — a
      // malformed task, not an ordinary done-claim problem. Coercing it via
      // `String(task.id)` (e.g. into the literal string "undefined" or
      // "[object Object]") would silently mask that and let it fall through
      // to the linked_commit checks below as if it were a normal task.
      if (typeof task.id !== 'string' || task.id.trim().length === 0) {
        violations.push({
          ledgerFile: ledgerRelPath,
          reason: 'a task in this ledger is marked done but has a missing or invalid id.',
        });
        continue;
      }
      const taskId = task.id;
      const linkedCommit = task.linked_commit;

      if (typeof linkedCommit !== 'string' || linkedCommit.trim().length === 0) {
        violations.push({
          ledgerFile: ledgerRelPath,
          taskId,
          reason: `task '${taskId}' is marked done but has a blank or missing linked_commit.`,
        });
        continue;
      }

      // Reject anything not shaped like a plausible commit hash *before*
      // ever shelling out to git — this ledger field is machine-written by
      // `waypoint verify` as a full SHA, so a full-length hex string is the
      // only legitimate shape. A git-flag-shaped value (e.g.
      // `--upload-pack=/tmp/x`) is treated as a violation here, never passed
      // through to `git merge-base` as a positional argument.
      if (!COMMIT_HASH_PATTERN.test(linkedCommit)) {
        violations.push({
          ledgerFile: ledgerRelPath,
          taskId,
          reason: `task '${taskId}' claims done via linked_commit '${linkedCommit}', which is not a valid commit hash.`,
        });
        continue;
      }

      if (!isAncestorOfHead(repoRoot, linkedCommit)) {
        anyAncestorViolation = true;
        violations.push({
          ledgerFile: ledgerRelPath,
          taskId,
          reason: `task '${taskId}' claims done via linked_commit '${linkedCommit}', which does not resolve to a real commit that is an ancestor of HEAD.`,
        });
      }
    }
  }

  if (shallow && anyAncestorViolation) {
    violations.push({
      reason:
        'this checkout appears to be a shallow clone (git rev-parse --is-shallow-repository); an older linked_commit may fail the ancestor check purely because its history is unavailable here, not because the claim is actually invalid — use a full (non-shallow) checkout to verify with confidence.',
    });
  }

  return { ok: violations.length === 0, violations };
}
