import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_COMMAND_REGISTRY } from '@waypoint/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCommand } from './commands/install.js';
import { setupAgentCommand } from './commands/setup-agent.js';

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-setup-agent-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

describe('setupAgentCommand', () => {
  it('sets a non-zero exit code and prints a clear message on an unknown agent name', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setupAgentCommand('not-a-real-agent', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('not-a-real-agent');
    expect(logged).toContain('claude-code');
    expect(logged).toContain('all');

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message when the repo is not installed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setupAgentCommand('claude-code', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('waypoint install');

    errorSpy.mockRestore();
  });

  it('leaves the exit code untouched, creates every file, and logs a per-agent created/kept report for a single agent', async () => {
    await installCommand(tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(setupAgentCommand('claude-code', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(tmpDir, '.claude', 'skills', 'waypoint-status', 'SKILL.md'))).toBe(true);

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain("Set up 'claude-code' commands:");
    expect(logged).toContain(path.join('.claude', 'skills', 'waypoint-status', 'SKILL.md'));

    logSpy.mockRestore();
  });

  it('the "all" shorthand sets up every agent target in one call, each under its own reported section', async () => {
    await installCommand(tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(setupAgentCommand('all', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(tmpDir, '.claude', 'skills', 'waypoint-status', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(tmpDir, '.agents', 'skills', 'waypoint-status.md'))).toBe(true);
    expect(existsSync(path.join(tmpDir, '.agents', 'skills', 'waypoint-status', 'SKILL.md'))).toBe(true);

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    for (const agent of ['claude-code', 'antigravity', 'cursor', 'codex']) {
      expect(logged).toContain(`Set up '${agent}' commands:`);
    }

    logSpy.mockRestore();
  });

  it('never sets up a command for approve under any agent target', async () => {
    await installCommand(tmpDir);
    await setupAgentCommand('all', tmpDir);

    expect(AGENT_COMMAND_REGISTRY.some((s) => s.verb === 'approve')).toBe(false);
    expect(existsSync(path.join(tmpDir, '.claude', 'skills', 'waypoint-approve'))).toBe(false);
  });

  it('sets a non-zero exit code and prints the underlying error on a non-domain failure', async () => {
    await installCommand(tmpDir);

    // Force setupAgentCommands's file-writing step to hit a raw filesystem
    // error (not one of the two domain error types): replace '.claude' --
    // the directory the claude-code renderer needs to create skill
    // subdirectories under -- with a plain file, so the later
    // `mkdir(..., { recursive: true })` on a path nested under it fails
    // (ENOTDIR on Linux, EEXIST on macOS -- either way, a raw fs error).
    // Mirrors install.test.ts's "sets a non-zero exit code and prints the
    // underlying error on a non-domain failure" test for newPatchCommand.
    writeFileSync(path.join(tmpDir, '.claude'), 'not a directory\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setupAgentCommand('claude-code', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    // The generic fallback branch prefixes with "Error: " (distinct from
    // the domain-error branch's own message), and includes the raw fs
    // error's own message, which names the conflicting path.
    expect(logged).toMatch(/^Error: /);
    expect(logged).not.toContain("waypoint setup-agent: this repo hasn't run");
    expect(logged).toContain(path.join(tmpDir, '.claude'));

    errorSpy.mockRestore();
  });

  it('logs a "kept" line naming a known path when a target path is already preserved on a second run', async () => {
    await installCommand(tmpDir);

    await setupAgentCommand('claude-code', tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(setupAgentCommand('claude-code', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(`  kept     ${path.join('.claude', 'skills', 'waypoint-status', 'SKILL.md')}`);

    logSpy.mockRestore();
  });
});
