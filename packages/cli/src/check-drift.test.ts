import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeatureSpec } from '@waypoint/core';
import { checkDriftCommand } from './commands/check-drift.js';
import { installCommand } from './commands/install.js';
import { createProgram } from './program.js';

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-check-drift-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

function setStatus(specPath: string, status: string): void {
  const raw = readFileSync(specPath, 'utf8');
  writeFileSync(specPath, raw.replace(/^status: .*$/m, `status: ${status}`), 'utf8');
}

function appendBody(specPath: string, extra: string): void {
  const raw = readFileSync(specPath, 'utf8');
  writeFileSync(specPath, `${raw.trimEnd()}\n\n${extra}\n`, 'utf8');
}

describe('checkDriftCommand', () => {
  it('leaves the exit code untouched and reports nothing-to-check when there is nothing eligible', async () => {
    await installCommand(tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(checkDriftCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to check'));

    logSpy.mockRestore();
  });

  it('leaves the exit code untouched and prints a clean summary when every reference resolves', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See `AGENTS.md` for the agent contract.');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(checkDriftCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no drift found'));

    logSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a finding naming the spec and the stale path when drift is found', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See `packages/core/src/does-not-exist.ts` for context.');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkDriftCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain(created.id);
    expect(logged).toContain('packages/core/src/does-not-exist.ts');

    errorSpy.mockRestore();
  });

  it('prints one finding line per stale reference, across multiple specs', async () => {
    await installCommand(tmpDir);
    const first = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(first.path, 'approved');
    appendBody(first.path, 'See `packages/core/src/missing-one.ts` for context.');

    const second = await createFeatureSpec(tmpDir, 'billing-webhook');
    setStatus(second.path, 'approved');
    appendBody(second.path, 'See `packages/core/src/missing-two.ts` for context.');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkDriftCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    const loggedAll = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(loggedAll).toContain(first.id);
    expect(loggedAll).toContain(second.id);

    errorSpy.mockRestore();
  });
});

describe('CLI program — check-drift wiring', () => {
  it('wires "waypoint check-drift" through the real command-parsing path to checkDrift, exiting non-zero on drift', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See `packages/core/src/does-not-exist.ts` for context.');

    const program = createProgram();
    program.exitOverride();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['check-drift'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('wires "waypoint check-drift" cleanly (exit code untouched) when nothing is eligible', async () => {
    await installCommand(tmpDir);

    const program = createProgram();
    program.exitOverride();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['check-drift'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to check'));

    logSpy.mockRestore();
  });
});
