import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createFeatureSpec, createPatchSpec, createSystemSpec } from '@waypoint/core';
import { installCommand } from './commands/install.js';
import { statusCommand } from './commands/status.js';
import { createProgram } from './program.js';

/**
 * `computeLedgerTaskHash` isn't part of `@waypoint/core`'s public index
 * (only `computeStatus`/`findAllSpecs`/`StatusResult`'s types were added
 * there per this story's Code Map) -- this reproduces the exact same
 * `sha256(canonicalJSON({id, status, verified_by_gate, linked_commit}))`
 * algorithm locally, purely so this CLI-level test can write a
 * `.gate-state` fixture with a hash that genuinely matches, without
 * reaching into `@waypoint/core/src/verify.ts` directly.
 */
function computeLedgerTaskHash(fields: {
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

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-status-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
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

function loggedLines(logSpy: ReturnType<typeof vi.spyOn>): string[] {
  return logSpy.mock.calls.map((call) => String(call[0]));
}

describe('statusCommand', () => {
  it('prints an explicit empty-state message when there are zero specs, and leaves the exit code untouched', async () => {
    await installCommand(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(statusCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    const lines = loggedLines(logSpy);
    expect(lines).toEqual(['waypoint status: no open specs.']);

    logSpy.mockRestore();
  });

  it("renders a Patch-tier spec's approval/task fields as explicitly not applicable", async () => {
    await installCommand(tmpDir);
    const created = await createPatchSpec(tmpDir, 'trivial-fix');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await statusCommand(tmpDir);

    const lines = loggedLines(logSpy);
    const specLine = lines.find((l) => l.includes(created.id));
    expect(specLine).toBeDefined();
    expect(specLine).toContain('approval: not applicable');
    expect(specLine).toContain('tasks: not applicable');

    logSpy.mockRestore();
  });

  it('renders the explicit unapproved+in-progress flag for a matching spec, distinct from an ordinary row', async () => {
    await installCommand(tmpDir);
    const inProgress = await createFeatureSpec(tmpDir, 'in-progress-feature');
    writeLedger(inProgress.id, [
      { id: 't1', description: 'a task', status: 'in-progress', linked_commit: null, verified_by_gate: false },
    ]);

    const ordinary = await createFeatureSpec(tmpDir, 'ordinary-feature');
    // Left with its scaffolded single pending task -- an ordinary open row.

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await statusCommand(tmpDir);

    const lines = loggedLines(logSpy);
    const flaggedLine = lines.find((l) => l.includes(inProgress.id));
    const ordinaryLine = lines.find((l) => l.includes(ordinary.id));

    expect(flaggedLine).toBeDefined();
    expect(ordinaryLine).toBeDefined();
    expect(flaggedLine).toMatch(/UNAPPROVED.*IN PROGRESS|IN PROGRESS.*UNAPPROVED/i);
    expect(ordinaryLine).not.toMatch(/UNAPPROVED/i);

    logSpy.mockRestore();
  });

  it('includes a tier-count summary line with correct counts', async () => {
    await installCommand(tmpDir);
    await createPatchSpec(tmpDir, 'p1');
    await createFeatureSpec(tmpDir, 'f1');
    await createSystemSpec(tmpDir, 's1');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await statusCommand(tmpDir);

    const lines = loggedLines(logSpy);
    const summaryLine = lines.find((l) => l.includes('waypoint status:') && l.includes('patch:'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain('patch: 1');
    expect(summaryLine).toContain('feature: 1');
    expect(summaryLine).toContain('system: 1');
    expect(summaryLine).toContain('3 open spec');

    logSpy.mockRestore();
  });

  it('never prints a fully closed spec (approved, every task genuinely done)', async () => {
    await installCommand(tmpDir);
    const closed = await createFeatureSpec(tmpDir, 'fully-closed');
    writeLedger(closed.id, [doneTaskRow('t1')]);
    writeGateState(closed.id, { t1: correctHashFor('t1') });
    markApproved(closed.path);

    const stillOpen = await createFeatureSpec(tmpDir, 'still-open');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await statusCommand(tmpDir);

    const lines = loggedLines(logSpy);
    const joined = lines.join('\n');
    expect(joined).not.toContain(closed.id);
    expect(joined).toContain(stillOpen.id);

    logSpy.mockRestore();
  });

  // -- Code-review patch: exit code, and the [CORRUPTED]/[LEDGER ERROR] renderings --

  it('renders both the count mention and the distinct [CORRUPTED] marker for a CORRUPTED task, and sets a non-zero exit code', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'corrupted-feature');
    writeLedger(created.id, [doneTaskRow('t1')]);
    // No .gate-state written at all -- missing stored hash -> CORRUPTED.

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await statusCommand(tmpDir);

    const lines = loggedLines(logSpy);
    const specLine = lines.find((l) => l.includes(created.id));
    expect(specLine).toBeDefined();
    expect(specLine).toContain('CORRUPTED');
    expect(specLine).toContain('[CORRUPTED]');
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it('renders [LEDGER ERROR] for a spec with a missing/unparseable ledger, and sets a non-zero exit code', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'broken-ledger-feature');
    writeFileSync(path.join(tmpDir, 'tasks', `${created.id}.ledger.yaml`), ': not: valid: yaml: [[[');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await statusCommand(tmpDir);

    const lines = loggedLines(logSpy);
    const specLine = lines.find((l) => l.includes(created.id));
    expect(specLine).toBeDefined();
    expect(specLine).toContain('[LEDGER ERROR]');
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it('leaves the exit code unset when the result has only ordinary open specs (no anomalies)', async () => {
    await installCommand(tmpDir);
    await createFeatureSpec(tmpDir, 'ordinary-only-feature');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await statusCommand(tmpDir);

    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
  });
});

describe('CLI program — status wiring (real Commander argv parsing)', () => {
  it('wires "waypoint status" through real argv parsing to computeStatus\'s rendered output', async () => {
    await installCommand(tmpDir);
    const created = await createPatchSpec(tmpDir, 'wiring-check');

    const program = createProgram();
    program.exitOverride();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['status'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    const lines = loggedLines(logSpy);
    const joined = lines.join('\n');
    expect(joined).toContain(created.id);
    expect(joined).toContain('approval: not applicable');
    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
  });
});
