import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createFeatureSpec, createPatchSpec, createSystemSpec } from './new-spec.js';
import { scaffold } from './scaffold.js';
import { computeStatus, type TaskStatus } from './status.js';
import { computeLedgerTaskHash } from './verify.js';

/**
 * `computeStatus` is purely a filesystem reader — no git, no ledger writes —
 * so unlike `verify.test.ts`/`done-claim.test.ts`, no real git repo is
 * needed here at all: every fixture is a scaffolded tmp-dir repo with real
 * specs (via `createPatchSpec`/`createFeatureSpec`/`createSystemSpec`) and
 * hand-edited ledger/frontmatter/`.gate-state` files, mirroring
 * `approve.test.ts`'s/`done-claim.test.ts`'s own fixture style.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-status-'));
  await scaffold(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeLedger(specId: string, tasks: Array<Record<string, unknown>>): void {
  const ledgerPath = path.join(tmpDir, 'tasks', `${specId}.ledger.yaml`);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, stringify({ spec_id: specId, tasks }));
}

function writeGateState(specId: string, hashes: Record<string, string>): void {
  const gateStatePath = path.join(tmpDir, '.waypoint', '.gate-state', `${specId}.json`);
  mkdirSync(path.dirname(gateStatePath), { recursive: true });
  writeFileSync(gateStatePath, JSON.stringify(hashes));
}

function markApproved(specPath: string): void {
  const raw = readFileSync(specPath, 'utf8');
  writeFileSync(specPath, raw.replace('status: draft', 'status: approved'));
}

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

function doneTaskRow(id: string, linkedCommit = COMMIT_A): Record<string, unknown> {
  return {
    id,
    description: 'a task',
    status: 'done',
    linked_commit: linkedCommit,
    verified_by_gate: true,
  };
}

function correctHashFor(id: string, linkedCommit = COMMIT_A): string {
  return computeLedgerTaskHash({
    id,
    status: 'done',
    verified_by_gate: true,
    linked_commit: linkedCommit,
  });
}

function entryFor(result: Awaited<ReturnType<typeof computeStatus>>, id: string) {
  return result.entries.find((e) => e.id === id);
}

// -- I/O matrix row: "Several open specs across tiers" -----------------------

describe('computeStatus — a mix of open specs across tiers', () => {
  it('includes every spec, none closed, with correct per-tier counts', async () => {
    await createPatchSpec(tmpDir, 'p1');
    await createFeatureSpec(tmpDir, 'f1'); // draft, one pending task -> open
    await createSystemSpec(tmpDir, 's1'); // draft, two pending tasks -> open

    const result = await computeStatus(tmpDir);

    expect(result.entries).toHaveLength(3);
    expect(result.counts).toEqual({ patch: 1, feature: 1, system: 1 });

    const ids = result.entries.map((e) => e.id).sort();
    expect(ids).toHaveLength(3);
    expect(entryFor(result, ids.find((id) => id.startsWith('patch-'))!)).toBeDefined();
  });
});

// -- I/O matrix row: "Zero open specs" ---------------------------------------

describe('computeStatus — zero open specs', () => {
  it('returns an empty entries array and zero counts when no specs exist', async () => {
    const result = await computeStatus(tmpDir);

    expect(result).toEqual({ entries: [], counts: { patch: 0, feature: 0, system: 0 } });
  });

  it('returns an empty entries array when every existing spec has closed', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-closed');
    writeLedger(created.id, [doneTaskRow('t1')]);
    writeGateState(created.id, { t1: correctHashFor('t1') });
    markApproved(created.path);

    const result = await computeStatus(tmpDir);

    expect(result).toEqual({ entries: [], counts: { patch: 0, feature: 0, system: 0 } });
  });
});

// -- I/O matrix row: "Patch-tier spec" ---------------------------------------

describe('computeStatus — Patch-tier spec', () => {
  it('reports approval/task-completion as explicitly not applicable, and is always included', async () => {
    await createPatchSpec(tmpDir, 'p-any');

    const result = await computeStatus(tmpDir);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.tier).toBe('patch');
    expect(entry.approved).toBe('not-applicable');
    expect(entry.tasks).toBe('not-applicable');
    expect(entry.unapprovedInProgress).toBe(false);
    expect(result.counts).toEqual({ patch: 1, feature: 0, system: 0 });
  });
});

// -- I/O matrix row: "Unapproved Feature/System spec with an in-progress task" --

describe('computeStatus — unapproved spec with an in-progress task', () => {
  it('flags a Feature-tier spec explicitly', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-in-progress');
    writeLedger(created.id, [
      { id: 't1', description: 'a task', status: 'in-progress', linked_commit: null, verified_by_gate: false },
    ]);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    expect(entry!.approved).toBe(false);
    expect(entry!.unapprovedInProgress).toBe(true);
    expect(entry!.tasks).toEqual([{ id: 't1', state: 'in-progress' }]);
  });

  it('flags a System-tier spec explicitly', async () => {
    const created = await createSystemSpec(tmpDir, 's-in-progress');
    writeLedger(created.id, [
      { id: 't1', phase: 1, description: 'a task', status: 'in-progress', linked_commit: null, verified_by_gate: false },
      { id: 't2', phase: 2, description: 'a task', status: 'pending', linked_commit: null, verified_by_gate: false },
    ]);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry!.unapprovedInProgress).toBe(true);
  });

  it('never flags an approved spec even with an in-progress task', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-approved-in-progress');
    writeLedger(created.id, [
      { id: 't1', description: 'a task', status: 'in-progress', linked_commit: null, verified_by_gate: false },
    ]);
    markApproved(created.path);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry!.approved).toBe(true);
    expect(entry!.unapprovedInProgress).toBe(false);
  });
});

// -- I/O matrix row: "A CORRUPTED task" --------------------------------------

describe('computeStatus — a CORRUPTED task', () => {
  it('shows a done-claiming task with a missing stored hash as CORRUPTED, never done or pending', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-missing-hash');
    writeLedger(created.id, [doneTaskRow('t1')]);
    // No .gate-state file written at all.

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry!.tasks).toEqual([{ id: 't1', state: 'CORRUPTED' }]);
  });

  it('shows a done-claiming task with a mismatched stored hash as CORRUPTED', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-mismatched-hash');
    writeLedger(created.id, [doneTaskRow('t1')]);
    writeGateState(created.id, { t1: 'not-the-real-hash' });

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry!.tasks).toEqual([{ id: 't1', state: 'CORRUPTED' }]);
  });
});

// -- I/O matrix row: "Fully closed Feature/System spec" ----------------------

describe('computeStatus — a fully closed Feature/System spec', () => {
  it('excludes an approved Feature spec whose every task is genuinely done', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-fully-closed');
    writeLedger(created.id, [doneTaskRow('t1')]);
    writeGateState(created.id, { t1: correctHashFor('t1') });
    markApproved(created.path);

    const result = await computeStatus(tmpDir);

    expect(entryFor(result, created.id)).toBeUndefined();
    expect(result.entries).toHaveLength(0);
  });

  it('excludes an approved System spec whose every task is genuinely done', async () => {
    const created = await createSystemSpec(tmpDir, 's-fully-closed');
    writeLedger(created.id, [
      doneTaskRow('t1'),
      { ...doneTaskRow('t2', COMMIT_B) },
    ]);
    writeGateState(created.id, {
      t1: correctHashFor('t1'),
      t2: correctHashFor('t2', COMMIT_B),
    });
    markApproved(created.prdPath);

    const result = await computeStatus(tmpDir);

    expect(entryFor(result, created.id)).toBeUndefined();
  });

  it('keeps an unapproved spec listed even when every task is genuinely done', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-done-not-approved');
    writeLedger(created.id, [doneTaskRow('t1')]);
    writeGateState(created.id, { t1: correctHashFor('t1') });
    // Deliberately not approved.

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    expect(entry!.approved).toBe(false);
    expect(entry!.tasks).toEqual([{ id: 't1', state: 'done' }]);
  });
});

// -- I/O matrix row: "A CORRUPTED task in an otherwise-approved, all-done-claiming spec" --

describe('computeStatus — CORRUPTED task inside an approved, all-done-claiming spec', () => {
  it('keeps the spec in the result and shows the offending task as CORRUPTED', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-corrupted-but-approved');
    writeLedger(created.id, [
      doneTaskRow('t1'),
      doneTaskRow('t2', COMMIT_B), // this one's stored hash will be wrong below
    ]);
    writeGateState(created.id, {
      t1: correctHashFor('t1'),
      t2: 'a-tampered-hash',
    });
    markApproved(created.path);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    expect(entry!.approved).toBe(true);
    expect(entry!.tasks).toEqual(
      expect.arrayContaining([
        { id: 't1', state: 'done' },
        { id: 't2', state: 'CORRUPTED' },
      ])
    );
  });
});

// -- I/O matrix row: "Missing/unparseable ledger for a found Feature/System spec" --

describe('computeStatus — missing/unparseable ledger', () => {
  it('reports [LEDGER ERROR] for the affected spec while other specs are still reported normally', async () => {
    const broken = await createFeatureSpec(tmpDir, 'f-broken-ledger');
    // Overwrite the ledger with unparseable content.
    writeFileSync(path.join(tmpDir, 'tasks', `${broken.id}.ledger.yaml`), ': not: valid: yaml: [[[');

    const good = await createFeatureSpec(tmpDir, 'f-good-ledger');
    // Leave `good`'s ledger as scaffolded (one pending task).

    const result = await computeStatus(tmpDir);

    const brokenEntry = entryFor(result, broken.id);
    expect(brokenEntry).toBeDefined();
    expect(brokenEntry!.tasks).toBe('ledger-error');
    expect(brokenEntry!.unapprovedInProgress).toBe(false);

    const goodEntry = entryFor(result, good.id);
    expect(goodEntry).toBeDefined();
    expect(goodEntry!.tasks).toEqual([{ id: 't1', state: 'pending' }]);
  });

  it('reports [LEDGER ERROR] for a spec whose ledger file is entirely missing', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-no-ledger');
    rmSync(path.join(tmpDir, 'tasks', `${created.id}.ledger.yaml`));

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry!.tasks).toBe('ledger-error');
  });

  it('never excludes a [LEDGER ERROR] spec even if its frontmatter says approved', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-ledger-error-approved');
    rmSync(path.join(tmpDir, 'tasks', `${created.id}.ledger.yaml`));
    markApproved(created.path);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    expect(entry!.tasks).toBe('ledger-error');
  });
});

// -- Code-review patch: path-traversal guard on a spec's frontmatter `id` ---

/**
 * Writes a Feature spec file directly (not via `createFeatureSpec`, which
 * always generates a well-formed `id`), with a caller-supplied, potentially
 * path-unsafe frontmatter `id`, mirroring `templates/feature.ts`'s own
 * frontmatter shape closely enough for `findAllSpecs`'/`readFrontmatterStatus`'s
 * parsing to accept it.
 */
function writeFeatureSpecWithId(tmp: string, id: string, filename: string): string {
  const specPath = path.join(tmp, 'specs', 'features', `${filename}.md`);
  mkdirSync(path.dirname(specPath), { recursive: true });
  // Single-quoted YAML scalar: unlike double-quoted, it applies no
  // backslash-escape processing at all (only `''` for a literal single
  // quote), so a raw backslash in `id` round-trips exactly as written.
  writeFileSync(
    specPath,
    `---\nid: '${id}'\ntier: feature\nstatus: draft\napproved_by: null\napproved_at: null\ncreated_at: 2026-01-01\n---\n\n# ${filename}\n`
  );
  return specPath;
}

describe('computeStatus — path-unsafe spec id (path-traversal guard)', () => {
  it('never builds/uses a ledger path from an id containing ".." -- reports [LEDGER ERROR] even when a real ledger sits at the would-be traversal target', async () => {
    const maliciousId = '../../escaped-ledger';
    writeFeatureSpecWithId(tmpDir, maliciousId, 'traversal-dotdot');

    // The exact path this module's ledger reader builds:
    // `path.join(cwd, 'tasks', `${maliciousId}.ledger.yaml`)`. Confirm it
    // really does resolve outside `tmpDir`, then place a real, valid,
    // parseable ledger there. If the guard didn't trip *before* any read is
    // attempted, this spec would come back with a genuine task list instead
    // of 'ledger-error'.
    const decoyPath = path.join(tmpDir, 'tasks', `${maliciousId}.ledger.yaml`);
    expect(path.resolve(decoyPath).startsWith(path.resolve(tmpDir) + path.sep)).toBe(false);
    mkdirSync(path.dirname(decoyPath), { recursive: true });
    writeFileSync(decoyPath, stringify({ spec_id: maliciousId, tasks: [{ id: 't1', status: 'pending' }] }));

    try {
      const result = await computeStatus(tmpDir);

      const entry = entryFor(result, maliciousId);
      expect(entry).toBeDefined();
      expect(entry!.tasks).toBe('ledger-error');
    } finally {
      rmSync(decoyPath, { force: true });
    }
  });

  it('reports [LEDGER ERROR] for an id containing "/"', async () => {
    const maliciousId = 'feat/evil';
    writeFeatureSpecWithId(tmpDir, maliciousId, 'traversal-slash');

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, maliciousId);
    expect(entry).toBeDefined();
    expect(entry!.tasks).toBe('ledger-error');
    expect(entry!.unapprovedInProgress).toBe(false);
  });

  it('reports [LEDGER ERROR] for an id containing "\\\\"', async () => {
    const maliciousId = 'feat\\evil';
    writeFeatureSpecWithId(tmpDir, maliciousId, 'traversal-backslash');

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, maliciousId);
    expect(entry).toBeDefined();
    expect(entry!.tasks).toBe('ledger-error');
  });
});

// -- Code-review patch: a malformed (null/non-object, or id-less) task row --

describe('computeStatus — malformed ledger task rows', () => {
  it('does not crash computeStatus on a null task-row entry; the rest of that spec\'s real tasks, and every other spec, still report correctly', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-null-task-row');
    writeLedger(created.id, [
      null as unknown as Record<string, unknown>,
      { id: 't2', description: 'a real task', status: 'pending' },
    ]);
    const sibling = await createPatchSpec(tmpDir, 'p-sibling-of-null-task');

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    expect(entry!.tasks).not.toBe('ledger-error');
    const tasks = entry!.tasks as TaskStatus[];
    expect(tasks).toHaveLength(2);
    expect(tasks.some((t) => t.id === 't2' && t.state === 'pending')).toBe(true);
    // The malformed row is reported as its own honest, non-crashing entry.
    expect(tasks.some((t) => t.id === '?')).toBe(true);

    expect(entryFor(result, sibling.id)).toBeDefined();
  });

  it('does not crash computeStatus on a task row with a missing/non-string id', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-missing-task-id');
    writeLedger(created.id, [{ description: 'no id field at all', status: 'pending' }]);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    const tasks = entry!.tasks as TaskStatus[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.state).toBe('pending');
    // Never the confusing literal label "undefined".
    expect(tasks[0]!.id).not.toBe('undefined');
  });
});

// -- Code-review patch: an approved spec with a zero-task (but parseable) ledger --

describe('computeStatus — approved spec with a zero-task ledger', () => {
  it('keeps an approved Feature spec whose ledger parses to an empty tasks array (never vacuously closed)', async () => {
    const created = await createFeatureSpec(tmpDir, 'f-empty-tasks');
    writeLedger(created.id, []);
    markApproved(created.path);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    expect(entry!.approved).toBe(true);
    expect(entry!.tasks).toEqual([]);
  });

  it('keeps an approved System spec whose ledger parses to an empty tasks array (never vacuously closed)', async () => {
    const created = await createSystemSpec(tmpDir, 's-empty-tasks');
    writeLedger(created.id, []);
    markApproved(created.prdPath);

    const result = await computeStatus(tmpDir);

    const entry = entryFor(result, created.id);
    expect(entry).toBeDefined();
    expect(entry!.approved).toBe(true);
    expect(entry!.tasks).toEqual([]);
  });
});

// -- Code-review patch: deterministic, sorted-by-id output ordering ---------

describe('computeStatus — deterministic ordering', () => {
  it('returns entries sorted by id regardless of creation order', async () => {
    // Deliberately created out of alphabetical order.
    await createPatchSpec(tmpDir, 'zzz-last');
    await createPatchSpec(tmpDir, 'aaa-first');
    await createPatchSpec(tmpDir, 'mmm-middle');

    const result = await computeStatus(tmpDir);

    const ids = result.entries.map((e) => e.id);
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(ids).toEqual(sorted);
  });
});
