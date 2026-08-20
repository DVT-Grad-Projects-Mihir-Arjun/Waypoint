import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCommand } from './commands/install.js';
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
  it('a not-yet-implemented stub command (new-patch) sets a non-zero exit code', async () => {
    const program = createProgram();
    program.exitOverride(); // don't let a Commander parse error call the real process.exit in this test

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['new-patch', 'sample-name'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not implemented yet'));

    errorSpy.mockRestore();
  });
});
