import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { computeLedgerTaskHash, verifyTask } from './verify.js';
import { scaffold } from './scaffold.js';
import { createFeatureSpec } from './new-spec.js';

// The built CLI entry point — used only by the real-installed-hook test below
// to prove `verifyTask`'s own commit actually passes through Story 3.2's real
// pre-commit hook (which shells to `gate()`), not just that it's designed to.
// Requires `npm run build` to have run first, same as Story 3.2's own
// analogous end-to-end test in packages/cli/src/gate.test.ts.
const CLI_DIST_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../cli/dist/index.js'
);

/**
 * `verifyTask` is inherently git-native end to end (unlike Story 3.1/3.2's
 * pure functions) -- there is no meaningful way to test it without a real
 * git repo, so every test below builds one directly with real `git`
 * invocations rather than mocking anything git-shaped.
 *
 * `scaffold()` is deliberately never used here: it would also install the
 * real pre-commit/pre-merge-commit hooks (`exec npx waypoint gate`), which
 * would fire on every `git commit` below and try to shell out to `npx` --
 * slow, network-dependent, and irrelevant to what this suite verifies.
 * Fixtures instead hand-write the minimal `.waypoint/config.yaml` and
 * `tasks/<spec-id>.ledger.yaml` this module actually reads.
 */

let tmpDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(cwd: string): void {
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
  // `scaffold()` is never used in this suite (see file header), so it never
  // gets a chance to add its own `.waypoint/.gate-state/` gitignore entry --
  // add it directly so `git status --porcelain` assertions below reflect
  // only tracked-file changes, not machine-local gate-state noise that a
  // real `waypoint install` would already have hidden.
  writeFileSync(path.join(cwd, '.gitignore'), '.waypoint/.gate-state/\n');
}

/** `git status --porcelain`, excluding the gitignored `.gate-state` directory's own untracked-dir noise. */
function trackedStatus(cwd: string): string {
  return git(['status', '--porcelain', '--ignored=no'], cwd).trim();
}

function writeConfig(cwd: string, checkCommand: string): void {
  mkdirSync(path.join(cwd, '.waypoint'), { recursive: true });
  writeFileSync(
    path.join(cwd, '.waypoint', 'config.yaml'),
    stringify({ check_command: checkCommand, tiers: { patch: ['tasks/**'] } })
  );
}

interface FixtureTask {
  id: string;
  description?: string;
  status: 'pending' | 'in-progress' | 'done';
  linked_commit: string | null;
  verified_by_gate: boolean;
}

function writeLedger(cwd: string, specId: string, tasks: FixtureTask[]): void {
  mkdirSync(path.join(cwd, 'tasks'), { recursive: true });
  writeFileSync(
    path.join(cwd, 'tasks', `${specId}.ledger.yaml`),
    stringify({
      spec_id: specId,
      tasks: tasks.map((t) => ({ description: 'a task', ...t })),
    })
  );
}

function readLedger(cwd: string, specId: string): { spec_id: string; tasks: FixtureTask[] } {
  const raw = readFileSync(path.join(cwd, 'tasks', `${specId}.ledger.yaml`), 'utf8');
  return parse(raw);
}

function gateStatePath(cwd: string, specId: string): string {
  return path.join(cwd, '.waypoint', '.gate-state', `${specId}.json`);
}

function readGateState(cwd: string, specId: string): Record<string, string> | null {
  try {
    return JSON.parse(readFileSync(gateStatePath(cwd, specId), 'utf8'));
  } catch {
    return null;
  }
}

function commitAll(cwd: string, message: string): void {
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
}

function headSha(cwd: string): string {
  return git(['rev-parse', 'HEAD'], cwd).trim();
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-verify-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const SPEC_ID = 'feat-2026-08-24-demo';

describe('verifyTask -- successful verify', () => {
  it('runs check_command, atomically writes the three fields, commits only the ledger, and re-running is a genuine no-op', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    // Commit the config alone first, so HEAD exists before the ledger file
    // is ever written -- exercising the "ledger never committed before"
    // case the Design Notes call out (`git add` then `--only`, not bare
    // `--only`).
    commitAll(tmpDir, 'init');
    const initialHead = headSha(tmpDir);

    writeLedger(tmpDir, SPEC_ID, [{ id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false }]);

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result).toEqual({
      outcome: 'verified',
      specId: SPEC_ID,
      taskId: 't1',
      linkedCommit: initialHead,
    });

    const ledger = readLedger(tmpDir, SPEC_ID);
    const task = ledger.tasks.find((t) => t.id === 't1')!;
    expect(task.status).toBe('done');
    expect(task.verified_by_gate).toBe(true);
    expect(task.linked_commit).toBe(initialHead);

    // Exactly one new commit landed, touching only the ledger file.
    const log = git(['log', '--oneline'], tmpDir).trim().split('\n');
    expect(log).toHaveLength(2);
    const changedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'], tmpDir).trim();
    // `git show`'s own path reporting is always forward-slash-normalized,
    // regardless of host OS -- compare against a literal, not `path.join`
    // (which would produce a backslash on Windows and never match).
    expect(changedFiles).toBe(`tasks/${SPEC_ID}.ledger.yaml`);
    expect(trackedStatus(tmpDir)).toBe('');

    const gateState = readGateState(tmpDir, SPEC_ID);
    expect(gateState).not.toBeNull();
    expect(gateState!['t1']).toBe(
      computeLedgerTaskHash({
        id: 't1',
        status: 'done',
        verified_by_gate: true,
        linked_commit: initialHead,
      })
    );

    // Re-running is a genuine no-op: no new commit, no changed gate-state.
    const secondResult = await verifyTask(tmpDir, SPEC_ID, 't1');
    expect(secondResult).toEqual({ outcome: 'already-verified', specId: SPEC_ID, taskId: 't1' });

    const logAfter = git(['log', '--oneline'], tmpDir).trim().split('\n');
    expect(logAfter).toHaveLength(2);
    expect(readGateState(tmpDir, SPEC_ID)).toEqual(gateState);
  });
});

describe('verifyTask -- check fails', () => {
  it('reports check-failed and writes nothing when check_command exits non-zero', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'false');
    writeLedger(tmpDir, SPEC_ID, [{ id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false }]);
    commitAll(tmpDir, 'init');

    const before = readFileSync(path.join(tmpDir, 'tasks', `${SPEC_ID}.ledger.yaml`), 'utf8');

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result.outcome).toBe('check-failed');
    expect(readFileSync(path.join(tmpDir, 'tasks', `${SPEC_ID}.ledger.yaml`), 'utf8')).toBe(before);
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toHaveLength(1);
    expect(existsSync(gateStatePath(tmpDir, SPEC_ID))).toBe(false);
  });

  it('reports a distinct config-error check-failed reason naming .waypoint/config.yaml when check_command is missing', async () => {
    initGitRepo(tmpDir);
    // No .waypoint/config.yaml written at all.
    writeLedger(tmpDir, SPEC_ID, [{ id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false }]);
    commitAll(tmpDir, 'init');

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result.outcome).toBe('check-failed');
    expect((result as { reason: string }).reason).toContain('.waypoint/config.yaml');
    expect((result as { reason: string }).reason).toContain('config error');
    expect(existsSync(gateStatePath(tmpDir, SPEC_ID))).toBe(false);
  });
});

describe('verifyTask -- commit step fails', () => {
  it('rolls the ledger content and git index back to their originals, leaves .gate-state untouched, and reports commit-failed', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [{ id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false }]);
    commitAll(tmpDir, 'init');

    const originalLedgerContent = readFileSync(path.join(tmpDir, 'tasks', `${SPEC_ID}.ledger.yaml`), 'utf8');

    // Force the commit step to fail deterministically: an always-rejecting
    // pre-commit hook -- verify's own commit must pass the same hooks every
    // other commit does (no --no-verify), so a failing hook is a faithful
    // way to simulate "the commit step fails for any reason."
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
    chmodSync(hookPath, 0o755);

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result.outcome).toBe('commit-failed');
    expect(readFileSync(path.join(tmpDir, 'tasks', `${SPEC_ID}.ledger.yaml`), 'utf8')).toBe(
      originalLedgerContent
    );
    expect(trackedStatus(tmpDir)).toBe('');
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toHaveLength(1);
    expect(existsSync(gateStatePath(tmpDir, SPEC_ID))).toBe(false);
  });
});

describe('verifyTask -- no commits yet', () => {
  it('errors clearly with no-head when git rev-parse HEAD fails', async () => {
    initGitRepo(tmpDir);
    // No commits at all -- config/ledger not even needed, HEAD is resolved
    // before anything else.

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result.outcome).toBe('no-head');
  });
});

describe('verifyTask -- unknown spec-id or task-id', () => {
  it('errors naming the missing ledger when the spec-id has no ledger', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    commitAll(tmpDir, 'init');

    const result = await verifyTask(tmpDir, 'feat-does-not-exist', 't1');

    expect(result.outcome).toBe('not-found');
    expect((result as { message: string }).message).toContain('feat-does-not-exist');
  });

  it('errors naming the missing task when the ledger exists but the task-id does not', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [{ id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false }]);
    commitAll(tmpDir, 'init');

    const result = await verifyTask(tmpDir, SPEC_ID, 't99');

    expect(result.outcome).toBe('not-found');
    expect((result as { message: string }).message).toContain('t99');
  });
});

describe('verifyTask -- already done, valid hash', () => {
  it('no-ops and reports already-verified without writing anything', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    const doneTask: FixtureTask = {
      id: 't1',
      status: 'done',
      linked_commit: 'deadbeef',
      verified_by_gate: true,
    };
    writeLedger(tmpDir, SPEC_ID, [doneTask]);
    commitAll(tmpDir, 'init');

    mkdirSync(path.join(tmpDir, '.waypoint', '.gate-state'), { recursive: true });
    const hash = computeLedgerTaskHash({
      id: 't1',
      status: 'done',
      verified_by_gate: true,
      linked_commit: 'deadbeef',
    });
    writeFileSync(gateStatePath(tmpDir, SPEC_ID), JSON.stringify({ t1: hash }));

    const before = readFileSync(path.join(tmpDir, 'tasks', `${SPEC_ID}.ledger.yaml`), 'utf8');
    const gateStateBefore = readFileSync(gateStatePath(tmpDir, SPEC_ID), 'utf8');

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result).toEqual({ outcome: 'already-verified', specId: SPEC_ID, taskId: 't1' });
    expect(readFileSync(path.join(tmpDir, 'tasks', `${SPEC_ID}.ledger.yaml`), 'utf8')).toBe(before);
    expect(readFileSync(gateStatePath(tmpDir, SPEC_ID), 'utf8')).toBe(gateStateBefore);
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toHaveLength(1);
  });
});

describe('verifyTask -- already done, missing/mismatched hash', () => {
  it('reports CORRUPTED and writes nothing when no hash is stored at all', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [
      { id: 't1', status: 'done', linked_commit: 'deadbeef', verified_by_gate: true },
    ]);
    commitAll(tmpDir, 'init');
    // No .gate-state file at all.

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result).toEqual({ outcome: 'corrupted', specId: SPEC_ID, taskId: 't1' });
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toHaveLength(1);
  });

  it('reports CORRUPTED and writes nothing when the stored hash does not match', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [
      { id: 't1', status: 'done', linked_commit: 'deadbeef', verified_by_gate: true },
    ]);
    commitAll(tmpDir, 'init');

    mkdirSync(path.join(tmpDir, '.waypoint', '.gate-state'), { recursive: true });
    writeFileSync(gateStatePath(tmpDir, SPEC_ID), JSON.stringify({ t1: 'not-the-right-hash' }));

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result).toEqual({ outcome: 'corrupted', specId: SPEC_ID, taskId: 't1' });
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toHaveLength(1);
  });
});

describe('verifyTask -- tamper detection survives type coercion', () => {
  it('reports CORRUPTED when verified_by_gate is hand-edited from the boolean true to the string "false"', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [{ id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false }]);
    commitAll(tmpDir, 'init');

    const first = await verifyTask(tmpDir, SPEC_ID, 't1');
    expect(first.outcome).toBe('verified');

    // Hand-edit `verified_by_gate` to the STRING "false", leaving the
    // previously-stored hash (computed from the real boolean `true`) stale.
    // `Boolean("false")` is `true` in JavaScript -- if the hash were computed
    // from a coerced value, this tamper would silently reproduce the
    // original hash and be missed entirely.
    const ledgerPath = path.join(tmpDir, 'tasks', `${SPEC_ID}.ledger.yaml`);
    const parsedLedger = parse(readFileSync(ledgerPath, 'utf8')) as { tasks: Record<string, unknown>[] };
    const tamperedTask = parsedLedger.tasks.find((t) => t.id === 't1')!;
    tamperedTask.verified_by_gate = 'false';
    writeFileSync(ledgerPath, stringify(parsedLedger));

    const result = await verifyTask(tmpDir, SPEC_ID, 't1');

    expect(result).toEqual({ outcome: 'corrupted', specId: SPEC_ID, taskId: 't1' });
    // Still nothing further written on top of the tampered file.
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toHaveLength(2);
  });
});

describe('verifyTask -- path-traversal guard on specId/taskId', () => {
  it('rejects spec-id/task-id values containing "/", "\\\\", or ".." as not-found, before touching the filesystem', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    commitAll(tmpDir, 'init');

    const badSpecSlash = await verifyTask(tmpDir, 'feat/x', 't1');
    expect(badSpecSlash.outcome).toBe('not-found');

    const badSpecTraversal = await verifyTask(tmpDir, '../escape', 't1');
    expect(badSpecTraversal.outcome).toBe('not-found');

    const badTaskBackslash = await verifyTask(tmpDir, SPEC_ID, 't1\\evil');
    expect(badTaskBackslash.outcome).toBe('not-found');

    const badTaskTraversal = await verifyTask(tmpDir, SPEC_ID, '../t1');
    expect(badTaskTraversal.outcome).toBe('not-found');
  });
});

describe('verifyTask -- concurrent verify, identical task-id', () => {
  it('resolves exactly one of two concurrent calls on the same pending task as verified and the other as already-verified', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [{ id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false }]);
    commitAll(tmpDir, 'init');

    const [resultA, resultB] = await Promise.all([
      verifyTask(tmpDir, SPEC_ID, 't1'),
      verifyTask(tmpDir, SPEC_ID, 't1'),
    ]);

    // Don't assume which call wins the race -- just that exactly one of each
    // outcome landed.
    expect([resultA.outcome, resultB.outcome].sort()).toEqual(['already-verified', 'verified']);

    // Exactly one new commit landed.
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toHaveLength(2);

    const ledger = readLedger(tmpDir, SPEC_ID);
    const t1 = ledger.tasks.find((t) => t.id === 't1')!;
    expect(t1.status).toBe('done');
    expect(t1.verified_by_gate).toBe(true);
    expect(typeof t1.linked_commit).toBe('string');

    // The stored hash matches the committed ledger content.
    const gateState = readGateState(tmpDir, SPEC_ID);
    expect(gateState).not.toBeNull();
    expect(gateState!['t1']).toBe(
      computeLedgerTaskHash({
        id: 't1',
        status: 'done',
        verified_by_gate: true,
        linked_commit: t1.linked_commit as string,
      })
    );
  });
});

describe('verifyTask -- concurrent verify, same/sibling tasks', () => {
  it('serializes two concurrent verify calls on sibling tasks without corrupting the ledger or .gate-state', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [
      { id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false },
      { id: 't2', status: 'pending', linked_commit: null, verified_by_gate: false },
    ]);
    commitAll(tmpDir, 'init');

    const [resultA, resultB] = await Promise.all([
      verifyTask(tmpDir, SPEC_ID, 't1'),
      verifyTask(tmpDir, SPEC_ID, 't2'),
    ]);

    expect(resultA.outcome).toBe('verified');
    expect(resultB.outcome).toBe('verified');

    const ledger = readLedger(tmpDir, SPEC_ID);
    const t1 = ledger.tasks.find((t) => t.id === 't1')!;
    const t2 = ledger.tasks.find((t) => t.id === 't2')!;

    expect(t1.status).toBe('done');
    expect(t1.verified_by_gate).toBe(true);
    expect(typeof t1.linked_commit).toBe('string');
    expect(t2.status).toBe('done');
    expect(t2.verified_by_gate).toBe(true);
    expect(typeof t2.linked_commit).toBe('string');

    const gateState = readGateState(tmpDir, SPEC_ID);
    expect(gateState).not.toBeNull();
    // Neither task's hash was lost/overwritten by the other's write.
    expect(gateState!['t1']).toBe(
      computeLedgerTaskHash({
        id: 't1',
        status: 'done',
        verified_by_gate: true,
        linked_commit: t1.linked_commit as string,
      })
    );
    expect(gateState!['t2']).toBe(
      computeLedgerTaskHash({
        id: 't2',
        status: 'done',
        verified_by_gate: true,
        linked_commit: t2.linked_commit as string,
      })
    );

    // Re-running both is a genuine no-op.
    const [reRunA, reRunB] = await Promise.all([
      verifyTask(tmpDir, SPEC_ID, 't1'),
      verifyTask(tmpDir, SPEC_ID, 't2'),
    ]);
    expect(reRunA).toEqual({ outcome: 'already-verified', specId: SPEC_ID, taskId: 't1' });
    expect(reRunB).toEqual({ outcome: 'already-verified', specId: SPEC_ID, taskId: 't2' });
  });
});

describe('verifyTask -- multiple tasks’ hashes', () => {
  it('preserves every other task’s stored hash when writing a new one', async () => {
    initGitRepo(tmpDir);
    writeConfig(tmpDir, 'true');
    writeLedger(tmpDir, SPEC_ID, [
      { id: 't1', status: 'pending', linked_commit: null, verified_by_gate: false },
      { id: 't2', status: 'pending', linked_commit: null, verified_by_gate: false },
      { id: 't3', status: 'pending', linked_commit: null, verified_by_gate: false },
    ]);
    commitAll(tmpDir, 'init');

    const resultT1 = await verifyTask(tmpDir, SPEC_ID, 't1');
    expect(resultT1.outcome).toBe('verified');
    const afterT1 = readGateState(tmpDir, SPEC_ID);
    expect(Object.keys(afterT1!)).toEqual(['t1']);

    const resultT2 = await verifyTask(tmpDir, SPEC_ID, 't2');
    expect(resultT2.outcome).toBe('verified');
    const afterT2 = readGateState(tmpDir, SPEC_ID);
    expect(afterT2!['t1']).toBe(afterT1!['t1']);
    expect(afterT2!['t2']).toBeDefined();
    expect(Object.keys(afterT2!).sort()).toEqual(['t1', 't2']);
  });
});

describe('verifyTask -- end-to-end through the real installed Story 3.2 gate hook', () => {
  it("its own commit passes the real pre-commit hook cleanly, proving tasks/**'s patch-tier classification actually prevents the self-blocking bootstrap problem", async () => {
    // Unlike every other test in this file, this one deliberately uses the
    // real `scaffold()` (which writes the real pre-commit/pre-merge-commit
    // hooks) instead of hand-writing a minimal fixture — the whole point here
    // is to prove `verifyTask`'s own ledger-only commit genuinely passes
    // through that real hook (which shells to Story 3.2's real `gate()`)
    // without needing any bypass, not just that the design intends it to.
    initGitRepo(tmpDir);

    const scaffoldResult = await scaffold(tmpDir);
    expect(scaffoldResult.warnings).toEqual([]);

    // The hook's `npx waypoint gate` line assumes the package is published or
    // linked; point it at this repo's own built CLI instead, same technique
    // Story 3.2's own end-to-end test uses.
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const hookContent = readFileSync(hookPath, 'utf8');
    writeFileSync(
      hookPath,
      hookContent.replace('exec npx waypoint gate', `exec node '${CLI_DIST_ENTRY}' gate`)
    );

    const created = await createFeatureSpec(tmpDir, 'demo-feature');
    const specId = created.id;

    // check_command defaults to `npm test`, which this scratch repo has no
    // package.json for — override to something trivially successful so this
    // test isolates the hook-interaction question, not check_command itself.
    const configPath = path.join(tmpDir, '.waypoint', 'config.yaml');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace('check_command: npm test', 'check_command: "true"')
    );

    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'scaffold + feature spec'], tmpDir);

    const result = await verifyTask(tmpDir, specId, 't1');

    expect(result.outcome).toBe('verified');
    const changedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'], tmpDir).trim();
    // See the "successful verify" test above for why this is a literal, not `path.join`.
    expect(changedFiles).toBe(`tasks/${specId}.ledger.yaml`);
  }, 20000);
});
