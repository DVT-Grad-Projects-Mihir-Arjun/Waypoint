import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { findAllSpecs, splitFrontmatter } from './update-spec.js';
import { computeLedgerTaskHash } from './verify.js';

/**
 * `waypoint status` (Story 5.1) — a read-only reporter that enumerates every
 * open spec across all three tiers and computes each Feature/System spec's
 * approval and task-completion state, reusing `verify.ts`'s own tamper-
 * detection hash to distinguish a genuinely `done` task from a `CORRUPTED`
 * one. `computeStatus()` is the pure core: it never writes to a ledger,
 * `.gate-state`, a spec file, or git — see this story's Boundaries &
 * Constraints. `packages/cli/src/commands/status.ts` is the thin wrapper
 * that renders its result as terminal output.
 *
 * This module reads its own ledger/`.gate-state` files directly (a
 * self-contained reader, mirroring `approve.ts`'s/`done-claim.ts`'s own
 * precedent of not reaching into another module's unexported internals),
 * but reuses `verify.ts`'s already-exported `computeLedgerTaskHash` for the
 * hash comparison itself, since that's the exact function that wrote the
 * stored hash in the first place.
 */

/** Per-task display state, per this story's Boundaries & Constraints. */
export type TaskDisplayState = 'pending' | 'in-progress' | 'done' | 'CORRUPTED';

/** One ledger task's id and computed display state. */
export interface TaskStatus {
  id: string;
  state: TaskDisplayState;
}

/**
 * One spec's reported status.
 *
 * - Patch tier has no approval or task-completion concept at all: `approved`
 *   and `tasks` are both the literal `'not-applicable'` — never a blank
 *   space, never an error, and never overloaded onto Feature/System's own
 *   value shapes.
 * - A Feature/System spec whose matching ledger couldn't be read/parsed gets
 *   `tasks: 'ledger-error'` — its own explicit `[LEDGER ERROR]` state,
 *   distinct from "an empty list of tasks" or any other ambiguous value.
 * - Otherwise (Feature/System, ledger read successfully) `tasks` is the full
 *   per-task display-state list.
 */
export interface SpecStatusEntry {
  /** The spec's frontmatter `id`. */
  id: string;
  /** The spec's frontmatter `tier`. */
  tier: 'patch' | 'feature' | 'system';
  /** Absolute path to the spec file (`<name>.md`, or a system's `prd.md`). */
  path: string;
  /**
   * `'not-applicable'` for Patch tier. For Feature/System tier, `true` iff
   * the spec's frontmatter `status` field is exactly `'approved'`.
   */
  approved: boolean | 'not-applicable';
  /**
   * `'not-applicable'` for Patch tier. `'ledger-error'` for a Feature/System
   * spec whose matching `tasks/<id>.ledger.yaml` failed to read or parse.
   * Otherwise the spec's per-task display states.
   */
  tasks: TaskStatus[] | 'not-applicable' | 'ledger-error';
  /**
   * `true` iff this is a Feature/System entry whose `approved` isn't `true`
   * and has at least one task displayed as `'in-progress'` — additive to,
   * not a replacement for, `approved`/`tasks`. Always `false` for Patch tier
   * and for a `[LEDGER ERROR]` entry (task states can't be determined, so
   * this flag can't be evaluated either).
   */
  unapprovedInProgress: boolean;
}

/** Result of a `computeStatus()` call. */
export interface StatusResult {
  /** Every open spec (closed Feature/System specs are excluded entirely — see the closing criterion). */
  entries: SpecStatusEntry[];
  /** How many of `entries` are of each tier. */
  counts: { patch: number; feature: number; system: number };
}

/** A single ledger task row, read generically — this module only ever inspects the four hashable fields plus `id`. */
interface LedgerTaskRow {
  id?: unknown;
  status?: unknown;
  linked_commit?: unknown;
  verified_by_gate?: unknown;
}

interface ParsedLedger {
  tasks: LedgerTaskRow[];
}

/**
 * Rejects a spec id that could escape its intended filesystem locations —
 * the task ledger path (`tasks/<specId>.ledger.yaml`) and the `.gate-state`
 * path (`.waypoint/.gate-state/<specId>.json`) are both built directly from
 * this string, by simple template interpolation, with no other validation.
 * Mirrors `verify.ts`'s own `validatePathSafeIds` guard on the identical
 * path-construction pattern, adapted to this module's "skip and report as
 * unreadable" style rather than a throwing/result-returning style: unlike
 * `verify.ts`'s `<spec-id>` (a CLI argument a human/agent typed), this
 * module's `spec.id` comes straight from a spec file's own frontmatter with
 * no shape validation upstream, so a hand-edited or adversarial frontmatter
 * `id` (e.g. containing `../`) must never reach `path.join`.
 */
function isPathUnsafeId(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('..');
}

/**
 * Reads and parses `tasks/<specId>.ledger.yaml`, returning `null` — never
 * throwing — if the file can't be read, isn't valid YAML, or doesn't parse
 * to an object with a top-level `tasks` array. The caller maps `null` to
 * this spec's own `[LEDGER ERROR]` state rather than letting one bad ledger
 * crash the whole `computeStatus` call.
 */
async function readLedgerForStatus(cwd: string, specId: string): Promise<ParsedLedger | null> {
  const ledgerPath = path.join(cwd, 'tasks', `${specId}.ledger.yaml`);

  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Record<string, unknown>).tasks)
  ) {
    return null;
  }

  return parsed as ParsedLedger;
}

/**
 * Reads the stored hash for `taskId` from `.waypoint/.gate-state/<specId>.json`,
 * or `null` if absent/unreadable/not a string — this module's own
 * self-contained equivalent of `verify.ts`'s unexported `readStoredHash`, per
 * this story's Boundaries & Constraints (a self-contained reader per module
 * is this codebase's established convention, not reaching into another
 * module's unexported internals).
 */
async function readStoredHash(cwd: string, specId: string, taskId: string): Promise<string | null> {
  const gateStatePath = path.join(cwd, '.waypoint', '.gate-state', `${specId}.json`);
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
 * Parses just the `status` field out of a spec file's frontmatter, returning
 * `null` if the file can't be read, has no well-formed frontmatter block, or
 * the field isn't a string. Reuses `update-spec.ts`'s exported
 * `splitFrontmatter` for the byte-fidelity block isolation, then parses that
 * block's YAML read-only here — mirroring how `approve.ts` re-reads a
 * `FoundSpec`'s file for its own additional frontmatter fields beyond what
 * `FoundSpec` itself carries.
 */
async function readFrontmatterStatus(specPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(specPath, 'utf8');
  } catch {
    return null;
  }

  const split = splitFrontmatter(raw);
  if (!split) return null;

  const inner = split.frontmatterBlock.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n$/, '');
  try {
    const parsed = parse(inner) as Record<string, unknown> | null;
    return parsed && typeof parsed.status === 'string' ? parsed.status : null;
  } catch {
    return null;
  }
}

/**
 * Determines one ledger task's display state:
 * - `'done'` (raw ledger `status`) is checked against its stored
 *   `.gate-state` hash, recomputed from the task's current
 *   `{id, status, verified_by_gate, linked_commit}` fields via
 *   `computeLedgerTaskHash` — missing or mismatched means `'CORRUPTED'`,
 *   never plain `'done'`. This is the identical detection `waypoint verify`
 *   itself already performs on an already-`done` task.
 * - `'in-progress'` passes through as-is.
 * - Anything else (including `'pending'`, or a malformed/missing `status`
 *   value) is reported as `'pending'` — the most conservative "not done, not
 *   corrupted" reading for a value this module doesn't recognize.
 */
async function computeTaskDisplayState(
  cwd: string,
  specId: string,
  taskId: string,
  task: LedgerTaskRow
): Promise<TaskDisplayState> {
  if (task.status === 'done') {
    const expectedHash = computeLedgerTaskHash({
      id: task.id,
      status: task.status,
      verified_by_gate: task.verified_by_gate,
      linked_commit: task.linked_commit,
    });
    const storedHash = await readStoredHash(cwd, specId, taskId);
    if (storedHash === null || storedHash !== expectedHash) {
      return 'CORRUPTED';
    }
    return 'done';
  }

  if (task.status === 'in-progress') {
    return 'in-progress';
  }

  return 'pending';
}

/**
 * Computes `waypoint status`'s full result: every open spec across all three
 * tiers, with each Feature/System spec's approval and per-task display
 * state, filtered by the closing criterion. Purely read-only — never writes
 * a ledger, `.gate-state`, a spec file, or touches git.
 *
 * - Patch tier: included unconditionally, with `approved`/`tasks` both
 *   `'not-applicable'` (no closing criterion applies).
 * - Feature/System tier: reads the spec's frontmatter `status` and its
 *   matching `tasks/<id>.ledger.yaml`. A path-unsafe frontmatter `id`
 *   (containing `/`, `\`, or `..`) is treated identically to a
 *   `[LEDGER ERROR]` spec — no path is ever built from it. A ledger that
 *   fails to read/parse reports this spec's own `[LEDGER ERROR]` state
 *   (`tasks: 'ledger-error'`) and moves on to the next spec, never crashing
 *   the whole call. Otherwise, each task's display state is computed via
 *   `computeTaskDisplayState` (a malformed — `null`/non-object — task row is
 *   reported as its own minimal entry rather than crashing), and the
 *   **closing criterion** is applied: a spec is excluded from the result
 *   entirely when `approved` is `true` AND it has at least one task AND
 *   every one of its tasks displays as `'done'` (a single `'CORRUPTED'`
 *   task, any non-`'done'` task, or a ledger with zero tasks, all keep the
 *   spec in the result). A `[LEDGER ERROR]` spec (including a path-unsafe-id
 *   spec) is never considered closed — its state can't be determined, so
 *   it's always included.
 *
 * `counts` reflects only the specs actually included in `entries` (i.e. how
 * many *open* specs of each tier are being shown), not every spec found.
 * `entries` is always sorted by `id` before being returned, for a
 * deterministic report regardless of filesystem traversal order.
 */
export async function computeStatus(cwd: string): Promise<StatusResult> {
  const specs = await findAllSpecs(cwd);
  const entries: SpecStatusEntry[] = [];
  const counts = { patch: 0, feature: 0, system: 0 };

  for (const spec of specs) {
    if (spec.tier === 'patch') {
      entries.push({
        id: spec.id,
        tier: 'patch',
        path: spec.path,
        approved: 'not-applicable',
        tasks: 'not-applicable',
        unapprovedInProgress: false,
      });
      counts.patch++;
      continue;
    }

    // `findAllSpecs` only ever returns 'patch' | 'feature' | 'system' (its
    // frontmatter parsing validates `tier` against exactly those three
    // values) — the branch above already handled 'patch'.
    const tier = spec.tier as 'feature' | 'system';

    const frontmatterStatus = await readFrontmatterStatus(spec.path);
    const approved = frontmatterStatus === 'approved';

    // A path-unsafe frontmatter `id` (containing '/', '\', or '..') must
    // never reach `path.join` for either the ledger or `.gate-state` path —
    // treat it exactly like the existing [LEDGER ERROR] case (its task state
    // genuinely can't be determined) rather than building a path from it.
    if (isPathUnsafeId(spec.id)) {
      entries.push({
        id: spec.id,
        tier,
        path: spec.path,
        approved,
        tasks: 'ledger-error',
        unapprovedInProgress: false,
      });
      if (tier === 'feature') counts.feature++;
      else counts.system++;
      continue;
    }

    const ledger = await readLedgerForStatus(cwd, spec.id);
    if (ledger === null) {
      entries.push({
        id: spec.id,
        tier,
        path: spec.path,
        approved,
        tasks: 'ledger-error',
        unapprovedInProgress: false,
      });
      if (tier === 'feature') counts.feature++;
      else counts.system++;
      continue;
    }

    const taskStates: TaskStatus[] = [];
    for (const task of ledger.tasks) {
      // A `null`/non-object task row (a plausible hand-edit mistake, e.g. a
      // stray blank list item) must never crash the whole `computeStatus`
      // call by accessing `.id`/`.status` on it — report it as its own
      // minimal, honestly-unknown entry and keep going.
      if (!task || typeof task !== 'object') {
        taskStates.push({ id: '?', state: 'pending' });
        continue;
      }

      // A missing/non-string `id` is handled the same defensively: fall
      // back to a string conversion only for a genuinely present non-string
      // value (e.g. a numeric id), and to the honest '?' placeholder rather
      // than the confusing literal label "undefined"/"null" otherwise.
      const taskId =
        typeof task.id === 'string' ? task.id : task.id !== undefined && task.id !== null ? String(task.id) : '?';
      const state = await computeTaskDisplayState(cwd, spec.id, taskId, task);
      taskStates.push({ id: taskId, state });
    }

    // Closing criterion: approved AND every task genuinely 'done' (a
    // CORRUPTED task never counts as done, even though its raw ledger
    // `status` field may still say 'done'). A ledger with zero tasks is
    // never considered closed either — every spec is scaffolded with at
    // least one placeholder task (Story 1.3), so an approved spec whose
    // ledger has genuinely zero tasks is itself an anomaly (most likely a
    // hand-edit that deleted every task), not a legitimately finished spec,
    // and must stay visible rather than vacuously satisfying "every task is
    // done."
    const closed = approved && taskStates.length > 0 && taskStates.every((t) => t.state === 'done');
    if (closed) {
      continue;
    }

    const hasInProgress = taskStates.some((t) => t.state === 'in-progress');
    const unapprovedInProgress = !approved && hasInProgress;

    entries.push({
      id: spec.id,
      tier,
      path: spec.path,
      approved,
      tasks: taskStates,
      unapprovedInProgress,
    });

    if (tier === 'feature') counts.feature++;
    else counts.system++;
  }

  // Deterministic ordering: `findAllSpecs`' own order follows whatever the
  // filesystem's `readdir` happens to return, which is not guaranteed
  // stable across machines/runs. A plain string sort by id keeps this
  // report's output reproducible and diff-friendly regardless of traversal
  // order.
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { entries, counts };
}
