import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCommand } from './commands/install.js';
import { newPatchCommand } from './commands/new-patch.js';
import { createProgram } from './program.js';

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-install-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

describe('installCommand', () => {
  it('sets a non-zero exit code and prints a clear message on a path collision, without throwing', async () => {
    writeFileSync(path.join(tmpDir, 'tasks'), 'i am a file\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(installCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('tasks');

    errorSpy.mockRestore();
  });

  it('leaves the exit code untouched on a clean install', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(installCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
  });
});

describe('CLI program — stub commands', () => {
  it('a not-yet-implemented stub command (new-feature) sets a non-zero exit code', async () => {
    const program = createProgram();
    program.exitOverride(); // don't let a Commander parse error call the real process.exit in this test

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['new-feature', 'sample-name'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not implemented yet'));

    errorSpy.mockRestore();
  });
});

describe('newPatchCommand', () => {
  it('sets a non-zero exit code and prints a clear message when the repo is not installed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newPatchCommand('demo-change', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('waypoint install');

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on an invalid name', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newPatchCommand('../escape', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on a name collision, without overwriting', async () => {
    await installCommand(tmpDir);
    await newPatchCommand('demo-change', tmpDir);

    const targetPath = path.join(tmpDir, 'specs', 'patches', 'demo-change.md');
    const original = readFileSync(targetPath, 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(newPatchCommand('demo-change', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(readFileSync(targetPath, 'utf8')).toBe(original);

    errorSpy.mockRestore();
  });

  it('leaves the exit code untouched, creates the spec file, and logs a relative-path confirmation on a clean run', async () => {
    await installCommand(tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(newPatchCommand('demo-change', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(tmpDir, 'specs', 'patches', 'demo-change.md'))).toBe(true);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('Created patch spec');
    expect(logged).toContain(path.join('specs', 'patches', 'demo-change.md'));
    // Relative, not absolute: must not contain the tmpDir prefix.
    expect(logged).not.toContain(tmpDir);

    logSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints the underlying error on a non-domain failure', async () => {
    await installCommand(tmpDir);

    // Force createPatchSpec's write step to hit a raw filesystem error (not
    // one of the three domain error types): replace specs/patches — which
    // the collision check treats as simply absent-of-that-name, since a
    // path check under a non-directory parent just reports "doesn't exist"
    // — with a plain file, so the later `mkdir(..., { recursive: true })`
    // on that same path fails (ENOTDIR on Linux, EEXIST on macOS — either
    // way, a raw fs error, not a domain error type).
    rmSync(path.join(tmpDir, 'specs', 'patches'), { recursive: true, force: true });
    writeFileSync(path.join(tmpDir, 'specs', 'patches'), 'not a directory\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newPatchCommand('demo-change', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    // The generic fallback branch prefixes with "Error: " (distinct from
    // the domain-error branch's "waypoint new-patch: " prefix) and includes
    // the raw fs error's own message, which names the conflicting path.
    expect(logged).toMatch(/^Error: /);
    expect(logged).not.toContain('waypoint new-patch:');
    expect(logged).toContain(path.join(tmpDir, 'specs', 'patches'));

    errorSpy.mockRestore();
  });
});
