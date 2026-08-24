import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

// Wraps `readFile` in a passthrough mock (default behavior: call straight
// through to the real implementation) so one targeted test below can
// temporarily intercept just the *second* read of a given path (the first,
// inside `findSpecById`'s directory scan, must still succeed) to exercise
// `approveCommand`'s generic (non-domain) fallback branch -- mirrors
// `update.test.ts`'s own `readFile` passthrough-mock pattern.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import * as fsPromises from 'node:fs/promises';
import { createFeatureSpec, createSystemSpec } from '@waypoint/core';
import { installCommand } from './commands/install.js';
import { approveCommand } from './commands/approve.js';
import { createProgram } from './program.js';

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-approve-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

function readFrontmatter(specPath: string): Record<string, unknown> {
  const raw = readFileSync(specPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return parse(match![1]!) as Record<string, unknown>;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(cwd: string): void {
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
}

describe('approveCommand', () => {
  it('sets a non-zero exit code and prints a clear message when the spec-id is not found', async () => {
    await installCommand(tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(approveCommand('feat-2026-01-01-nope', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint approve:');
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

    await expect(approveCommand(patchId, tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('waypoint approve:');

    errorSpy.mockRestore();
  });

  it('leaves the exit code untouched and logs an approved confirmation for a draft Feature spec', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(approveCommand(created.id, tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint approve:');
    expect(logged).toContain(created.id);
    expect(logged).toContain('approved');

    const frontmatter = readFrontmatter(created.path);
    expect(frontmatter.status).toBe('approved');

    logSpy.mockRestore();
  });

  it('reports an already-approved no-op message on a second run against a Feature spec, exit code 0', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await approveCommand(created.id, tmpDir);
    logSpy.mockClear();

    await expect(approveCommand(created.id, tmpDir)).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();

    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('already approved');

    logSpy.mockRestore();
  });

  it('records phase 1 without flipping status for a first call on a System spec', async () => {
    await installCommand(tmpDir);
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(approveCommand(created.id, tmpDir)).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();

    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('phase 1');
    expect(logged).toContain("remains 'draft'");

    const frontmatter = readFrontmatter(created.prdPath);
    expect(frontmatter.status).toBe('draft');

    logSpy.mockRestore();
  });

  it('flips status to approved on the second call (final phase boundary) on a System spec', async () => {
    await installCommand(tmpDir);
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await approveCommand(created.id, tmpDir);
    logSpy.mockClear();

    await expect(approveCommand(created.id, tmpDir)).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();

    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('phase 2');
    expect(logged).toContain("now 'approved'");

    const frontmatter = readFrontmatter(created.prdPath);
    expect(frontmatter.status).toBe('approved');

    logSpy.mockRestore();
  });

  it('reports an already-approved no-op once every System-tier phase is approved', async () => {
    await installCommand(tmpDir);
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await approveCommand(created.id, tmpDir);
    await approveCommand(created.id, tmpDir);
    logSpy.mockClear();

    await expect(approveCommand(created.id, tmpDir)).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();

    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('already approved');

    logSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a plain "Error:"-prefixed message on a genuine non-domain failure', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    // `findSpecById`'s own directory-scan read of this exact path must still
    // succeed (that's what lets `approveSpec` resolve the spec at all); only
    // the *second* read of the same path -- `approveFeatureSpec`'s own
    // direct re-read of the spec file, which has no surrounding try/catch --
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
      await expect(approveCommand(created.id, tmpDir)).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0]?.[0]);
      expect(logged).toMatch(/^Error: /);
      expect(logged).not.toContain('waypoint approve:');
    } finally {
      mockedReadFile.mockImplementation(actual.readFile as typeof fsPromises.readFile);
      errorSpy.mockRestore();
    }
  });
});

describe('CLI program — approve wiring', () => {
  it('wires "waypoint approve <spec-id>" through the real command-parsing path to approveSpec', async () => {
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'wired-feature');

    const program = createProgram();
    program.exitOverride();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['approve', created.id], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(created.path)).toBe(true);
    const frontmatter = readFrontmatter(created.path);
    expect(frontmatter.status).toBe('approved');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('waypoint approve:'));

    logSpy.mockRestore();
  });
});

// `approveCommand` legitimately shells out to git (`git config user.name`,
// to resolve `approved_by`) -- same reason `gate.ts`/`verify.ts` each have
// their own dedicated network-surface-neutrality test instead of being part
// of `vendor-neutrality.test.ts`'s "zero child_process calls" test. This
// mirrors those two commands' own test exactly, confirming git-shelling is
// the only outbound-capable surface `approveCommand` touches.
describe('approveCommand — network-surface neutrality', () => {
  it('makes zero network calls while still legitimately shelling out to git', async () => {
    initGitRepo(tmpDir);
    await installCommand(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');

    const httpRequestSpy = vi.spyOn(http, 'request').mockImplementation(() => {
      throw new Error('unexpected call to http.request');
    });
    const httpGetSpy = vi.spyOn(http, 'get').mockImplementation(() => {
      throw new Error('unexpected call to http.get');
    });
    const httpsRequestSpy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('unexpected call to https.request');
    });
    const httpsGetSpy = vi.spyOn(https, 'get').mockImplementation(() => {
      throw new Error('unexpected call to https.get');
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('unexpected call to fetch');
    });
    const netConnectSpy = vi.spyOn(net, 'connect').mockImplementation(() => {
      throw new Error('unexpected call to net.connect');
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(approveCommand(created.id, tmpDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBeUndefined();

      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(httpGetSpy).not.toHaveBeenCalled();
      expect(httpsRequestSpy).not.toHaveBeenCalled();
      expect(httpsGetSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(netConnectSpy).not.toHaveBeenCalled();
    } finally {
      httpRequestSpy.mockRestore();
      httpGetSpy.mockRestore();
      httpsRequestSpy.mockRestore();
      httpsGetSpy.mockRestore();
      fetchSpy.mockRestore();
      netConnectSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
