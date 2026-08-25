import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { approveSpec } from './approve.js';
import { createFeatureSpec, createSystemSpec } from './new-spec.js';
import { scaffold } from './scaffold.js';
import {
  DuplicateSpecIdError,
  findSpecById,
  LedgerNotFoundError,
  PatchTierUpdateNotSupportedError,
  SpecNotFoundError,
  updateSpec,
} from './update-spec.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-update-spec-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface ParsedLedger {
  spec_id: string;
  tasks: Array<Record<string, unknown>>;
}

function readLedger(ledgerPath: string): ParsedLedger {
  return parse(readFileSync(ledgerPath, 'utf8')) as ParsedLedger;
}

function readFrontmatter(specPath: string): Record<string, unknown> {
  const raw = readFileSync(specPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  expect(match).not.toBeNull();
  return parse(match![1]!) as Record<string, unknown>;
}

// -- I/O matrix row: "Spec not found" --------------------------------------

describe('updateSpec — spec not found', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('rejects with SpecNotFoundError naming the missing spec-id, without writing anything', async () => {
    let caught: unknown;
    try {
      await updateSpec(tmpDir, 'feat-2026-01-01-does-not-exist');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNotFoundError);
    expect((caught as SpecNotFoundError).specId).toBe('feat-2026-01-01-does-not-exist');
    expect((caught as Error).message).toContain('feat-2026-01-01-does-not-exist');
  });

  it('findSpecById itself returns null (not throwing) when nothing matches', async () => {
    const found = await findSpecById(tmpDir, 'nope');
    expect(found).toBeNull();
  });
});

// -- I/O matrix row: "Patch-tier spec-id" ------------------------------------

describe('updateSpec — patch-tier spec-id', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('rejects with PatchTierUpdateNotSupportedError, no write, when the spec-id resolves to a patch-tier spec', async () => {
    const patchPath = path.join(tmpDir, 'specs', 'patches', 'trivial-fix.md');
    const patchId = 'patch-2026-08-21-trivial-fix';
    writeFileSync(
      patchPath,
      `---\nid: ${patchId}\ntier: patch\nstatus: draft\ncreated_at: 2026-08-21\n---\n\n# trivial-fix\n\n## Summary\n\nA trivial patch.\n`
    );
    const originalContent = readFileSync(patchPath, 'utf8');

    let caught: unknown;
    try {
      await updateSpec(tmpDir, patchId);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PatchTierUpdateNotSupportedError);
    expect((caught as PatchTierUpdateNotSupportedError).specId).toBe(patchId);
    expect(readFileSync(patchPath, 'utf8')).toBe(originalContent);
  });
});

// -- I/O matrix row: "First run, nothing to sync" --------------------------

describe('updateSpec — first run, nothing to sync', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('appends a new delta heading and leaves the ledger untouched for a fresh feature spec', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const originalLedger = readFileSync(created.ledgerPath, 'utf8');

    const result = await updateSpec(tmpDir, created.id);

    expect(result.syncedTaskIds).toEqual([]);
    expect(readFileSync(created.ledgerPath, 'utf8')).toBe(originalLedger);

    const raw = readFileSync(created.path, 'utf8');
    expect(raw).toContain(result.deltaHeading);
    expect(raw).toContain('### ADDED');
    expect(raw).toContain('### MODIFIED');
    expect(raw).toContain('### REMOVED');

    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`;
    expect(result.deltaHeading).toBe(`## Delta — ${iso}`);
  });
});

// -- I/O matrix row: "Sync picks up hand-filled content" --------------------

describe('updateSpec — sync picks up hand-filled content', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('appends a new pending ledger row matching a hand-filled ADDED bullet, plus a new delta heading', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    // First run scaffolds an empty delta block.
    const first = await updateSpec(tmpDir, created.id);
    expect(first.syncedTaskIds).toEqual([]);

    // Hand-fill the ADDED section of that delta block with a new bullet.
    let raw = readFileSync(created.path, 'utf8');
    raw = raw.replace(
      `${first.deltaHeading}\n\n### ADDED\n`,
      `${first.deltaHeading}\n\n### ADDED\n- Add logout endpoint\n`
    );
    writeFileSync(created.path, raw, 'utf8');

    const second = await updateSpec(tmpDir, created.id);

    expect(second.syncedTaskIds).toHaveLength(1);
    const newTaskId = second.syncedTaskIds[0]!;

    const ledger = readLedger(created.ledgerPath);
    const newRow = ledger.tasks.find((t) => t.id === newTaskId);
    expect(newRow).toBeDefined();
    expect(newRow!.description).toBe('Add logout endpoint');
    expect(newRow!.status).toBe('pending');
    expect(newRow!.linked_commit).toBeNull();
    expect(newRow!.verified_by_gate).toBe(false);
    // Feature-tier rows never get a `phase` field (that's System-tier only).
    expect(newRow).not.toHaveProperty('phase');

    // Existing t1 placeholder row must survive untouched.
    expect(ledger.tasks.find((t) => t.id === 't1')).toBeDefined();

    // A fresh delta heading is also appended by this same run.
    const finalRaw = readFileSync(created.path, 'utf8');
    expect(finalRaw).toContain(second.deltaHeading);
    expect(second.deltaHeading).not.toBe(first.deltaHeading);
  });
});

// -- I/O matrix row: "Idempotent re-run" -------------------------------------

describe('updateSpec — idempotent re-run', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('does not re-add a bullet whose text already matches an existing ledger task description', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const first = await updateSpec(tmpDir, created.id);
    let raw = readFileSync(created.path, 'utf8');
    raw = raw.replace(
      `${first.deltaHeading}\n\n### ADDED\n`,
      `${first.deltaHeading}\n\n### ADDED\n- Add logout endpoint\n`
    );
    writeFileSync(created.path, raw, 'utf8');

    const second = await updateSpec(tmpDir, created.id);
    expect(second.syncedTaskIds).toHaveLength(1);
    const ledgerAfterSecond = readLedger(created.ledgerPath);
    expect(ledgerAfterSecond.tasks).toHaveLength(2);

    // Re-run without touching the ADDED bullet further: the same bullet
    // text is still sitting in the (now-previous) delta's ADDED section,
    // and must not be re-added.
    const third = await updateSpec(tmpDir, created.id);
    expect(third.syncedTaskIds).toEqual([]);

    const ledgerAfterThird = readLedger(created.ledgerPath);
    expect(ledgerAfterThird.tasks).toHaveLength(2);
  });
});

// -- I/O matrix row: "No-op re-run reuses empty heading" ---------------------

describe('updateSpec — no-op re-run reuses empty heading', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('does not append a second heading when the most recent one is still completely empty', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const first = await updateSpec(tmpDir, created.id);
    expect(first.deltaHeadingReused).toBe(false);

    const rawAfterFirst = readFileSync(created.path, 'utf8');

    const second = await updateSpec(tmpDir, created.id);

    expect(second.deltaHeadingReused).toBe(true);
    expect(second.deltaHeading).toBe(first.deltaHeading);
    expect(second.syncedTaskIds).toEqual([]);

    // The spec file is left completely untouched — no second heading, no
    // rewrite of any kind.
    const rawAfterSecond = readFileSync(created.path, 'utf8');
    expect(rawAfterSecond).toBe(rawAfterFirst);
    expect(rawAfterSecond.match(/^## Delta — /gm)).toHaveLength(1);

    // A third consecutive no-op run behaves the same way.
    const third = await updateSpec(tmpDir, created.id);
    expect(third.deltaHeadingReused).toBe(true);
    expect(third.deltaHeading).toBe(first.deltaHeading);
    expect(readFileSync(created.path, 'utf8')).toBe(rawAfterFirst);
  });
});

// -- I/O matrix row: "Second run same day, after content was added" ---------

describe('updateSpec — second run same day, after content was added', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('disambiguates a same-day second delta heading with a (2) suffix only once the most recent heading has content', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const first = await updateSpec(tmpDir, created.id);

    // A no-op re-run in between must not consume a heading.
    const noOp = await updateSpec(tmpDir, created.id);
    expect(noOp.deltaHeading).toBe(first.deltaHeading);
    expect(noOp.deltaHeadingReused).toBe(true);

    // Now fill in first's heading with content, and re-run: this is the
    // trigger that finally appends a fresh, disambiguated heading.
    let raw = readFileSync(created.path, 'utf8');
    raw = raw.replace(
      `${first.deltaHeading}\n\n### ADDED\n`,
      `${first.deltaHeading}\n\n### ADDED\n- Add logout endpoint\n`
    );
    writeFileSync(created.path, raw, 'utf8');

    const second = await updateSpec(tmpDir, created.id);
    expect(second.deltaHeadingReused).toBe(false);
    expect(second.deltaHeading).toBe(`${first.deltaHeading} (2)`);

    // Another no-op re-run reuses heading (2), still without appending a third.
    const noOp2 = await updateSpec(tmpDir, created.id);
    expect(noOp2.deltaHeading).toBe(second.deltaHeading);
    expect(noOp2.deltaHeadingReused).toBe(true);

    // Fill heading (2) with content too, and re-run: appends heading (3).
    raw = readFileSync(created.path, 'utf8');
    raw = raw.replace(
      `${second.deltaHeading}\n\n### ADDED\n`,
      `${second.deltaHeading}\n\n### ADDED\n- Add password-reset endpoint\n`
    );
    writeFileSync(created.path, raw, 'utf8');

    const third = await updateSpec(tmpDir, created.id);
    expect(third.deltaHeadingReused).toBe(false);
    expect(third.deltaHeading).toBe(`${first.deltaHeading} (3)`);

    const finalRaw = readFileSync(created.path, 'utf8');
    expect(finalRaw.match(/^## Delta — /gm)).toHaveLength(3);
  });
});

// -- I/O matrix row: "System-tier sync" --------------------------------------

describe('updateSpec — system-tier sync', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('gives a synced ADDED bullet a new row placed one phase past the highest phase already in the ledger, for a System-tier spec', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    const first = await updateSpec(tmpDir, created.id);
    expect(first.tier).toBe('system');

    let raw = readFileSync(created.prdPath, 'utf8');
    raw = raw.replace(
      `${first.deltaHeading}\n\n### ADDED\n`,
      `${first.deltaHeading}\n\n### ADDED\n- Add invoicing webhook\n`
    );
    writeFileSync(created.prdPath, raw, 'utf8');

    const second = await updateSpec(tmpDir, created.id);
    expect(second.syncedTaskIds).toHaveLength(1);
    const newTaskId = second.syncedTaskIds[0]!;

    const ledger = readLedger(created.ledgerPath);
    const newRow = ledger.tasks.find((t) => t.id === newTaskId);
    expect(newRow).toBeDefined();
    // The freshly-scaffolded ledger already has t1/phase 1 and t2/phase 2
    // (renderSystemLedgerYaml's two placeholder tasks) -- the newly-synced
    // task must land in phase 3, one past the highest existing phase, never
    // hardcoded back to phase 1 (Finding 7 of the epic-1-5 MVP
    // retrospective: a hardcoded phase 1 would silently land in a phase
    // that may already be fully approved, bypassing waypoint approve's
    // human-only gate for a task no human has ever reviewed).
    expect(newRow!.phase).toBe(3);
    expect(newRow!.description).toBe('Add invoicing webhook');
    expect(newRow!.status).toBe('pending');
  });
});

// -- Finding 7 regression (epic-1-5 MVP retrospective) -----------------------
//
// `updateSpec()`'s sync pass used to hardcode every newly-synced System-tier
// task to `phase: 1`, regardless of which phases were already approved. That
// silently bypassed `waypoint approve`'s human-only approval gate: once every
// existing phase is approved, `approveSystemSpec` decides what still needs
// review purely from which *phase numbers* exist in the ledger, not which
// task ids were ever reviewed -- so a task landing back in an
// already-approved phase 1 made `approveSpec()` report `already-approved`
// for a task no human had ever seen. This test reproduces that exact live
// scenario end to end (`createSystemSpec` -> approve both phases ->
// `updateSpec` an ADDED bullet -> `approveSpec` again) and asserts the new
// task's phase is never one already covered by an existing `phase_approvals`
// entry.

describe('updateSpec — Finding 7 regression: a task synced after full approval never lands in an already-approved phase', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it("assigns the newly-synced task to phase 3 (one past every phase already in phase_approvals), not the hardcoded phase 1", async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    // Scaffold the first Delta heading (no bullets yet -- nothing to sync).
    const scaffolded = await updateSpec(tmpDir, created.id);
    expect(scaffolded.syncedTaskIds).toHaveLength(0);

    // Fully approve both of the spec's original phases (1 and 2) --
    // `status` flips to `approved` on the second call.
    const approvedPhase1 = await approveSpec(tmpDir, created.id);
    expect(approvedPhase1.approvedPhase).toBe(1);
    const approvedPhase2 = await approveSpec(tmpDir, created.id);
    expect(approvedPhase2.approvedPhase).toBe(2);
    expect(approvedPhase2.statusApproved).toBe(true);

    const frontmatterAfterApproval = (() => {
      const raw = readFileSync(created.prdPath, 'utf8');
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(match).not.toBeNull();
      return parse(match![1]!) as Record<string, unknown>;
    })();
    expect(frontmatterAfterApproval.status).toBe('approved');
    const approvedPhaseNumbers = (
      frontmatterAfterApproval.phase_approvals as Array<Record<string, unknown>>
    ).map((entry) => entry.phase);
    expect(approvedPhaseNumbers.sort()).toEqual([1, 2]);

    // Add a brand-new '### ADDED' bullet to the now-fully-approved spec's
    // current Delta section -- the exact live-reproduction scenario from the
    // retrospective.
    let raw = readFileSync(created.prdPath, 'utf8');
    raw = raw.replace(
      `${scaffolded.deltaHeading}\n\n### ADDED\n`,
      `${scaffolded.deltaHeading}\n\n### ADDED\n- Add a refund webhook\n`
    );
    writeFileSync(created.prdPath, raw, 'utf8');

    const synced = await updateSpec(tmpDir, created.id);
    expect(synced.syncedTaskIds).toHaveLength(1);
    const newTaskId = synced.syncedTaskIds[0]!;

    const ledger = readLedger(created.ledgerPath);
    const newRow = ledger.tasks.find((t) => t.id === newTaskId);
    expect(newRow).toBeDefined();

    // The load-bearing assertion: the new task's phase must NOT be one of
    // the phases already present in `phase_approvals` (1 or 2) -- it must be
    // `Math.max(existing phases) + 1 = 3`, guaranteed to require a fresh
    // approval call.
    expect(approvedPhaseNumbers).not.toContain(newRow!.phase);
    expect(newRow!.phase).toBe(3);

    // Chain the rest of the way through the real approval gate: calling
    // `approveSpec()` again must NOT report `already-approved` -- it must
    // see the brand-new phase 3 as genuinely requiring review.
    const finalApproval = await approveSpec(tmpDir, created.id);
    expect(finalApproval.outcome).toBe('approved');
    expect(finalApproval.approvedPhase).toBe(3);
  });

  it('groups multiple ADDED bullets synced in the same updateSpec() call into one identical new phase, not one incremented per bullet', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    // Scaffold the first Delta heading (no bullets yet -- nothing to sync).
    const scaffolded = await updateSpec(tmpDir, created.id);
    expect(scaffolded.syncedTaskIds).toHaveLength(0);

    // Fully approve both of the spec's original phases (1 and 2), same as
    // the regression test above -- so a freshly-synced phase 3 is verifiably
    // brand new, not a coincidence of the freshly-scaffolded ledger's own
    // placeholder phases.
    const approvedPhase1 = await approveSpec(tmpDir, created.id);
    expect(approvedPhase1.approvedPhase).toBe(1);
    const approvedPhase2 = await approveSpec(tmpDir, created.id);
    expect(approvedPhase2.approvedPhase).toBe(2);

    // Two distinct, un-synced '### ADDED' bullets under the same current
    // Delta heading, added in one edit before updateSpec() ever runs.
    let raw = readFileSync(created.prdPath, 'utf8');
    raw = raw.replace(
      `${scaffolded.deltaHeading}\n\n### ADDED\n`,
      `${scaffolded.deltaHeading}\n\n### ADDED\n- Add a refund webhook\n- Add a chargeback webhook\n`
    );
    writeFileSync(created.prdPath, raw, 'utf8');

    const synced = await updateSpec(tmpDir, created.id);
    expect(synced.syncedTaskIds).toHaveLength(2);

    const ledger = readLedger(created.ledgerPath);
    const newRows = synced.syncedTaskIds.map((id) => ledger.tasks.find((t) => t.id === id));
    expect(newRows[0]).toBeDefined();
    expect(newRows[1]).toBeDefined();

    // Both bullets synced in this one call land in the identical new phase
    // (3) -- never incremented per-bullet (which would have put the second
    // bullet in phase 4).
    expect(newRows[0]!.phase).toBe(3);
    expect(newRows[1]!.phase).toBe(3);
    expect(newRows[0]!.phase).toBe(newRows[1]!.phase);
  });
});

// -- Acceptance criteria ------------------------------------------------------

describe('updateSpec — acceptance: frontmatter is byte-identical after update', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('leaves status/approved_by/approved_at (and the whole frontmatter block) byte-identical for an approved spec', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    // Simulate an approved spec by hand-editing the frontmatter directly
    // (waypoint approve is out of this story's scope).
    let raw = readFileSync(created.path, 'utf8');
    raw = raw
      .replace('status: draft', 'status: approved')
      .replace('approved_by: null', 'approved_by: alice')
      .replace('approved_at: null', 'approved_at: 2026-08-20');
    writeFileSync(created.path, raw, 'utf8');
    const frontmatterMatch = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
    const originalFrontmatterBlock = frontmatterMatch![1]!;

    await updateSpec(tmpDir, created.id);

    const afterRaw = readFileSync(created.path, 'utf8');
    expect(afterRaw.startsWith(originalFrontmatterBlock)).toBe(true);

    const frontmatter = readFrontmatter(created.path);
    expect(frontmatter.status).toBe('approved');
    expect(frontmatter.approved_by).toBe('alice');
    expect(String(frontmatter.approved_at)).toBe('2026-08-20');
  });
});

describe('updateSpec — acceptance: MODIFIED/REMOVED-only delta adds no ledger rows', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('adds zero ledger rows when a delta has MODIFIED/REMOVED content filled in but ADDED left empty', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const first = await updateSpec(tmpDir, created.id);
    let raw = readFileSync(created.path, 'utf8');
    raw = raw
      .replace(
        `${first.deltaHeading}\n\n### MODIFIED\n`,
        `${first.deltaHeading}\n\n### MODIFIED\n- FR7: (old wording) -> (new wording)\n`
      )
      .replace(
        `### REMOVED\n`,
        `### REMOVED\n- FR3 (superseded)\n`
      );
    writeFileSync(created.path, raw, 'utf8');

    const originalLedger = readFileSync(created.ledgerPath, 'utf8');
    const second = await updateSpec(tmpDir, created.id);

    expect(second.syncedTaskIds).toEqual([]);
    expect(readFileSync(created.ledgerPath, 'utf8')).toBe(originalLedger);
  });
});

// -- findSpecById cross-tier search behavior ---------------------------------

describe('findSpecById — cross-tier search', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('locates a feature spec by its frontmatter id, regardless of filename', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const found = await findSpecById(tmpDir, created.id);
    expect(found).not.toBeNull();
    expect(found!.path).toBe(created.path);
    expect(found!.tier).toBe('feature');
  });

  it('locates a system spec via its specs/systems/<name>/prd.md file', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');
    const found = await findSpecById(tmpDir, created.id);
    expect(found).not.toBeNull();
    expect(found!.path).toBe(created.prdPath);
    expect(found!.tier).toBe('system');
  });

  it('tolerates an unrelated malformed spec file elsewhere while still finding the real match', async () => {
    mkdirSync(path.join(tmpDir, 'specs', 'features'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'specs', 'features', 'broken.md'),
      'not even frontmatter, just text\n'
    );
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const found = await findSpecById(tmpDir, created.id);
    expect(found).not.toBeNull();
    expect(found!.path).toBe(created.path);
  });

  it('tolerates a spec file whose frontmatter tier is not patch/feature/system (treats it as no match)', async () => {
    const weirdPath = path.join(tmpDir, 'specs', 'features', 'weird-tier.md');
    writeFileSync(
      weirdPath,
      '---\nid: feat-2026-08-21-weird-tier\ntier: typo-tier\nstatus: draft\napproved_by: null\napproved_at: null\ncreated_at: 2026-08-21\n---\n\n# weird-tier\n'
    );

    const found = await findSpecById(tmpDir, 'feat-2026-08-21-weird-tier');
    expect(found).toBeNull();
  });

  it('throws DuplicateSpecIdError naming every colliding path when two files share the same id', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const dupePath = path.join(tmpDir, 'specs', 'features', 'auth-refresh-dupe.md');
    const originalRaw = readFileSync(created.path, 'utf8');
    // Same frontmatter id, different filename — a manual-editing/bug scenario.
    writeFileSync(dupePath, originalRaw);

    let caught: unknown;
    try {
      await findSpecById(tmpDir, created.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DuplicateSpecIdError);
    expect((caught as DuplicateSpecIdError).specId).toBe(created.id);
    expect((caught as DuplicateSpecIdError).paths.sort()).toEqual(
      [created.path, dupePath].sort()
    );
    expect((caught as Error).message).toContain(created.path);
    expect((caught as Error).message).toContain(dupePath);
  });
});

// -- Mechanical patch findings from code review -------------------------------

describe('updateSpec — missing/malformed ledger', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('throws LedgerNotFoundError, no write, when the ledger file is missing', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    rmSync(created.ledgerPath, { force: true });
    const originalSpec = readFileSync(created.path, 'utf8');

    let caught: unknown;
    try {
      await updateSpec(tmpDir, created.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LedgerNotFoundError);
    expect((caught as LedgerNotFoundError).ledgerPath).toBe(created.ledgerPath);
    expect(readFileSync(created.path, 'utf8')).toBe(originalSpec);
  });

  it('throws LedgerNotFoundError, no write, when the ledger file does not parse to an object with a tasks array', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    writeFileSync(created.ledgerPath, 'spec_id: something\n', 'utf8');
    const originalSpec = readFileSync(created.path, 'utf8');

    let caught: unknown;
    try {
      await updateSpec(tmpDir, created.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LedgerNotFoundError);
    expect(readFileSync(created.path, 'utf8')).toBe(originalSpec);
  });
});

describe('updateSpec — corrupted spec-id shape is treated as not found', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('rejects with SpecNotFoundError when the matched frontmatter id does not have the <tier>-<date>-<name> shape', async () => {
    const weirdPath = path.join(tmpDir, 'specs', 'features', 'weird-id.md');
    const weirdId = '../escape-attempt';
    writeFileSync(
      weirdPath,
      `---\nid: ${weirdId}\ntier: feature\nstatus: draft\napproved_by: null\napproved_at: null\ncreated_at: 2026-08-21\n---\n\n# weird-id\n\n## Task List\n\n- [ ] t1: placeholder\n`
    );

    let caught: unknown;
    try {
      await updateSpec(tmpDir, weirdId);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNotFoundError);
    expect((caught as SpecNotFoundError).specId).toBe(weirdId);
  });
});

describe('updateSpec — broadened ADDED-bullet marker recognition', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('picks up ADDED bullets written with *, +, or - markers', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const first = await updateSpec(tmpDir, created.id);

    let raw = readFileSync(created.path, 'utf8');
    raw = raw.replace(
      `${first.deltaHeading}\n\n### ADDED\n`,
      `${first.deltaHeading}\n\n### ADDED\n* Add logout endpoint\n+ Add password-reset endpoint\n- Add refresh endpoint\n`
    );
    writeFileSync(created.path, raw, 'utf8');

    const second = await updateSpec(tmpDir, created.id);
    expect(second.syncedTaskIds).toHaveLength(3);

    const ledger = parse(readFileSync(created.ledgerPath, 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    const descriptions = ledger.tasks.map((t) => t.description);
    expect(descriptions).toContain('Add logout endpoint');
    expect(descriptions).toContain('Add password-reset endpoint');
    expect(descriptions).toContain('Add refresh endpoint');
  });
});

describe('updateSpec — broadened delta-heading dash recognition', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('recognizes a hand-typed heading using a plain hyphen or en dash instead of the canonical em dash', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const first = await updateSpec(tmpDir, created.id);

    // Hand-rewrite the heading itself to use a plain hyphen, and fill in a
    // bullet, simulating a human who didn't copy the exact em dash.
    const dateOnly = first.deltaHeading.replace('## Delta — ', '');
    const hyphenHeading = `## Delta - ${dateOnly}`;
    let raw = readFileSync(created.path, 'utf8');
    raw = raw
      .replace(first.deltaHeading, hyphenHeading)
      .replace(`${hyphenHeading}\n\n### ADDED\n`, `${hyphenHeading}\n\n### ADDED\n- Add logout endpoint\n`);
    writeFileSync(created.path, raw, 'utf8');

    const second = await updateSpec(tmpDir, created.id);

    // The bullet under the hyphen-heading's ADDED subsection was still
    // recognized and synced...
    expect(second.syncedTaskIds).toHaveLength(1);
    // ...and the hyphen-heading itself was recognized as non-empty, so a
    // fresh (canonical em-dash) heading was appended rather than reused.
    expect(second.deltaHeadingReused).toBe(false);
  });
});
