import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wraps `readFile` in a passthrough mock (default behavior: call straight
// through to the real implementation) so one targeted test below can
// temporarily intercept just the *second* read of a given path (the first,
// inside `findSpecById`'s directory scan, must still succeed) to exercise
// `updateCommand`'s generic (non-domain) fallback branch — mirrors
// `new-spec.test.ts`'s own `writeFile` passthrough-mock pattern.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import * as fsPromises from 'node:fs/promises';
import { createFeatureSpec } from '@waypoint/core';
import { installCommand } from './commands/install.js';
import { updateCommand } from './commands/update.js';
import { createProgram } from './program.js';

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-update-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

describe('updateCommand', () => {
  it('sets a non-zero exit code and prints a clear message when the spec-id is not found', async () => {
    await installCommand(tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateCommand('feat-2026-01-01-nope', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint update:');
    expect(logged).toContain('feat-2026-01-01-nope');

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message when the spec-id resolves to a patch-tier spec', async () => {
    await installCommand(tmpDir);
    const patchId = 'patch-2026-08-21-trivial-fix';
    writeFileSync(
      path.join(tmpDir, 'specs', 'patches', 'trivial-fix.md'),
      `---\nid: ${patchId}\ntier: patch\nstatus: draft\ncreated_at: 2026-08-21\n---\n\n# trivial-fix\n\n## Summary\n\nA trivial patch.\n`
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateCommand(patchId, tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('waypoint update:');

    errorSpy.mockRestore();
  });

  it('leaves the exit code untouched, appends a delta heading, and logs a relative-path confirmation on a clean run', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(updateCommand(created.id, tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('Updated spec');
    expect(logged).toContain(path.join('specs', 'features', 'auth-refresh.md'));
    expect(logged).toContain('appended');
    expect(logged).toContain('Delta —');
    // Relative, not absolute: must not contain the tmpDir prefix.
    expect(logged).not.toContain(tmpDir);

    const raw = readFileSync(created.path, 'utf8');
    expect(raw).toContain('### ADDED');

    logSpy.mockRestore();
  });

  it('reports a reused-empty-delta message (not "appended") on a true no-op re-run', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateCommand(created.id, tmpDir);
    logSpy.mockClear();

    await expect(updateCommand(created.id, tmpDir)).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();

    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('reused existing empty delta');
    expect(logged).not.toContain('appended');

    // Running it a third time with no edits still doesn't litter a second
    // heading.
    const rawAfterSecond = readFileSync(created.path, 'utf8');
    logSpy.mockClear();
    await updateCommand(created.id, tmpDir);
    expect(readFileSync(created.path, 'utf8')).toBe(rawAfterSecond);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('reused existing empty delta');

    logSpy.mockRestore();
  });

  it('reports the synced task count in the confirmation message when a hand-filled ADDED bullet is picked up', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateCommand(created.id, tmpDir);
    logSpy.mockClear();

    let raw = readFileSync(created.path, 'utf8');
    raw = raw.replace('### ADDED\n', '### ADDED\n- Add logout endpoint\n');
    writeFileSync(created.path, raw, 'utf8');

    await expect(updateCommand(created.id, tmpDir)).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();

    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('synced 1 new task');

    logSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear "waypoint update:" message when the task ledger is missing', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    rmSync(created.ledgerPath, { force: true });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateCommand(created.id, tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint update:');
    expect(logged).toContain(created.ledgerPath);

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints the underlying error on a genuine non-domain failure', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    // `findSpecById`'s own directory-scan read of this exact path must
    // still succeed (that's what lets `updateSpec` resolve the spec at
    // all); only the *second* read of the same path — `updateSpec`'s own
    // direct re-read of the spec file, which has no surrounding try/catch —
    // is forced to fail with a raw, non-domain filesystem error.
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const mockedReadFile = vi.mocked(fsPromises.readFile);
    let callsForSpecPath = 0;

    mockedReadFile.mockImplementation(async (file: unknown, ...rest: unknown[]) => {
      if (file === created.path) {
        callsForSpecPath++;
        if (callsForSpecPath === 2) {
          const err = new Error('EACCES: permission denied, open') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(updateCommand(created.id, tmpDir)).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0]?.[0]);
      expect(logged).toMatch(/^Error: /);
      expect(logged).not.toContain('waypoint update:');
    } finally {
      mockedReadFile.mockImplementation(actual.readFile as typeof fsPromises.readFile);
      errorSpy.mockRestore();
    }
  });
});

describe('CLI program — update wiring', () => {
  it('wires "waypoint update <spec-id>" through the real command-parsing path to updateSpec', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'wired-feature');

    const program = createProgram();
    program.exitOverride();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['update', created.id], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(created.path)).toBe(true);
    const raw = readFileSync(created.path, 'utf8');
    expect(raw).toContain('### ADDED');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Updated spec'));

    logSpy.mockRestore();
  });
});
