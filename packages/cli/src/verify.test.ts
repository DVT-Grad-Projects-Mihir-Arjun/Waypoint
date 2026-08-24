import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Wraps `verifyTask` in a passthrough mock (default behavior: call straight
// through to the real implementation) so most tests below can override its
// resolved value to exercise every outcome->message/exit-code mapping
// without spinning up a real git repo per case, while one dedicated
// end-to-end test still relies on the real implementation via this same
// passthrough (mirrors `gate.test.ts`'s own `gate` mocking pattern).
vi.mock('@waypoint/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/core')>();
  return { ...actual, verifyTask: vi.fn(actual.verifyTask) };
});
import * as waypointCore from '@waypoint/core';
import type { VerifyResult } from '@waypoint/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { verifyCommand } from './commands/verify.js';
import { createProgram } from './program.js';

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-verify-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
  // Each test above queues at most one `mockResolvedValueOnce`/
  // `mockImplementationOnce` override and consumes it with its own single
  // call, so nothing leaks across tests. Deliberately NOT `mockReset()`
  // here: that would also wipe the passthrough-to-the-real-implementation
  // default set up by `vi.mock(...)` above, which the real-git-repo wiring
  // test below depends on.
  vi.mocked(waypointCore.verifyTask).mockClear();
});

describe('verifyCommand -- outcome -> message/exit-code mapping', () => {
  it('verified: logs a confirmation and leaves the exit code untouched', async () => {
    vi.mocked(waypointCore.verifyTask).mockResolvedValueOnce({
      outcome: 'verified',
      specId: 'feat-x',
      taskId: 't1',
      linkedCommit: 'abc1234',
    } satisfies VerifyResult);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint verify:');
    expect(logged).toContain('t1');
    expect(logged).toContain('feat-x');
    expect(logged).toContain('abc1234');

    logSpy.mockRestore();
  });

  it('already-verified: logs a no-op confirmation and leaves the exit code untouched', async () => {
    vi.mocked(waypointCore.verifyTask).mockResolvedValueOnce({
      outcome: 'already-verified',
      specId: 'feat-x',
      taskId: 't1',
    } satisfies VerifyResult);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('already verified');

    logSpy.mockRestore();
  });

  it('check-failed: reports the reason and exits 1', async () => {
    vi.mocked(waypointCore.verifyTask).mockResolvedValueOnce({
      outcome: 'check-failed',
      specId: 'feat-x',
      taskId: 't1',
      reason: 'check_command (\'npm test\') exited non-zero.',
    } satisfies VerifyResult);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint verify:');
    expect(logged).toContain("exited non-zero");

    errorSpy.mockRestore();
  });

  it('commit-failed: reports the reason and exits 1', async () => {
    vi.mocked(waypointCore.verifyTask).mockResolvedValueOnce({
      outcome: 'commit-failed',
      specId: 'feat-x',
      taskId: 't1',
      reason: 'pre-commit hook exited 1',
    } satisfies VerifyResult);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('rolled back');
    expect(logged).toContain('pre-commit hook exited 1');

    errorSpy.mockRestore();
  });

  it('not-found: reports the message verbatim and exits 1', async () => {
    vi.mocked(waypointCore.verifyTask).mockResolvedValueOnce({
      outcome: 'not-found',
      message: "no task 't1' found in 'tasks/feat-x.ledger.yaml'.",
    } satisfies VerifyResult);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("no task 't1' found");

    errorSpy.mockRestore();
  });

  it('no-head: reports the message verbatim and exits 1', async () => {
    vi.mocked(waypointCore.verifyTask).mockResolvedValueOnce({
      outcome: 'no-head',
      message: "no commits found in this repository ('git rev-parse HEAD' failed).",
    } satisfies VerifyResult);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('no commits found');

    errorSpy.mockRestore();
  });

  it('corrupted: reports CORRUPTED naming the task and exits 1', async () => {
    vi.mocked(waypointCore.verifyTask).mockResolvedValueOnce({
      outcome: 'corrupted',
      specId: 'feat-x',
      taskId: 't1',
    } satisfies VerifyResult);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('CORRUPTED');
    expect(logged).toContain('t1');
    expect(logged).toContain('feat-x');

    errorSpy.mockRestore();
  });

  it('catches verifyTask itself throwing and reports a clear message instead of letting the exception escape', async () => {
    vi.mocked(waypointCore.verifyTask).mockImplementationOnce(() => {
      throw new Error('boom: simulated internal verify failure');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyCommand('feat-x', 't1', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint verify:');
    expect(logged).toContain('boom: simulated internal verify failure');

    errorSpy.mockRestore();
  });
});

describe('CLI program -- verify wiring, real git repo (not mocked)', () => {
  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  it('wires "waypoint verify <spec-id> <task-id>" end to end: a real commit lands with only the ledger file, and re-running is a genuine no-op', async () => {
    git(['init', '-q'], tmpDir);
    git(['config', 'user.email', 'test@example.com'], tmpDir);
    git(['config', 'user.name', 'Test'], tmpDir);

    mkdirSync(path.join(tmpDir, '.waypoint'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, '.waypoint', 'config.yaml'),
      stringify({ check_command: 'true', tiers: { patch: ['tasks/**'] } })
    );
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);
    const initialHead = git(['rev-parse', 'HEAD'], tmpDir).trim();

    const specId = 'feat-2026-08-24-wired-demo';
    mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'tasks', `${specId}.ledger.yaml`),
      stringify({
        spec_id: specId,
        tasks: [{ id: 't1', description: 'demo', status: 'pending', linked_commit: null, verified_by_gate: false }],
      })
    );

    const program = createProgram();
    program.exitOverride();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['verify', specId, 't1'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('verified'));

    const ledgerRaw = readFileSync(path.join(tmpDir, 'tasks', `${specId}.ledger.yaml`), 'utf8');
    expect(ledgerRaw).toContain('status: done');
    expect(ledgerRaw).toContain(initialHead);

    const changedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'], tmpDir).trim();
    expect(changedFiles).toBe(path.join('tasks', `${specId}.ledger.yaml`));
    expect(existsSync(path.join(tmpDir, '.waypoint', '.gate-state', `${specId}.json`))).toBe(true);

    const logCountBefore = logSpy.mock.calls.length;
    const logAfterFirst = git(['log', '--oneline'], tmpDir).trim().split('\n');

    const originalCwd2 = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['verify', specId, 't1'], { from: 'user' });
    } finally {
      process.chdir(originalCwd2);
    }

    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.length).toBeGreaterThan(logCountBefore);
    expect(String(logSpy.mock.calls[logSpy.mock.calls.length - 1]?.[0])).toContain('already verified');
    expect(git(['log', '--oneline'], tmpDir).trim().split('\n')).toEqual(logAfterFirst);

    logSpy.mockRestore();
  });
});
