import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCommand } from './commands/install.js';
import { newFeatureCommand } from './commands/new-feature.js';
import { newPatchCommand } from './commands/new-patch.js';
import { newSystemCommand } from './commands/new-system.js';
import { createProgram } from './program.js';

// Mirrors @waypoint/core's own (unexported) `todayIsoDate()` — needed here
// to predict a feature spec's ledger filename (`tasks/<id>.ledger.yaml`,
// `id` embeds today's date) before it's created, e.g. to pre-seed a
// collision.
function todayIsoDateForTest(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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

  it('installs both hook files, executable, when .git is present, and logs nothing under a "warning" line', async () => {
    mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(installCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();

    const preCommitPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const preMergeCommitPath = path.join(tmpDir, '.git', 'hooks', 'pre-merge-commit');
    expect(existsSync(preCommitPath)).toBe(true);
    expect(existsSync(preMergeCommitPath)).toBe(true);
    // Windows' fs layer doesn't implement POSIX permission bits, so this
    // exact-mode assertion is POSIX-only — matches the scaffold.test.ts
    // precedent guarding the same underlying chmod call.
    if (process.platform !== 'win32') {
      expect(statSync(preCommitPath).mode & 0o777).toBe(0o755);
      expect(statSync(preMergeCommitPath).mode & 0o777).toBe(0o755);
    }

    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('created') && line.includes('pre-commit'))).toBe(
      true
    );
    expect(logged.some((line) => line.startsWith('  warning'))).toBe(false);

    logSpy.mockRestore();
  });

  it('prints a warning line naming the skipped hooks when .git is absent, without failing the install', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(installCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'))).toBe(false);

    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.startsWith('  warning') && line.includes('.git'))).toBe(
      true
    );

    logSpy.mockRestore();
  });

  it('reports both hooks as kept, plus a warning, when a foreign pre-existing hook is left untouched', async () => {
    mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\necho "foreign hook"\n'
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(installCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain(
      'foreign hook'
    );

    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('kept') && line.includes('pre-commit'))).toBe(true);
    expect(
      logged.some((line) => line.startsWith('  warning') && line.includes('pre-commit'))
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('reports both hooks as kept, with no warning, when re-installing over its own already-installed hooks', async () => {
    mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    await installCommand(tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(installCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('kept') && line.includes('pre-commit'))).toBe(true);
    expect(logged.some((line) => line.includes('kept') && line.includes('pre-merge-commit'))).toBe(
      true
    );
    expect(logged.some((line) => line.startsWith('  warning'))).toBe(false);

    logSpy.mockRestore();
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

describe('newFeatureCommand', () => {
  it('sets a non-zero exit code and prints a clear message when the repo is not installed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newFeatureCommand('demo-feature', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('waypoint install');

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on an invalid name', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newFeatureCommand('../escape', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on a spec-name collision, without overwriting either file', async () => {
    await installCommand(tmpDir);
    await newFeatureCommand('demo-feature', tmpDir);

    const specPath = path.join(tmpDir, 'specs', 'features', 'demo-feature.md');
    // Ledger filename is keyed by the spec's full `id` (embeds today's
    // date), not the bare name — locate it by scanning tasks/ rather than
    // hardcoding the name-based filename.
    const ledgerFiles = readdirSync(path.join(tmpDir, 'tasks')).filter((f) =>
      f.endsWith('.ledger.yaml')
    );
    expect(ledgerFiles).toHaveLength(1);
    const ledgerPath = path.join(tmpDir, 'tasks', ledgerFiles[0]!);

    const originalSpec = readFileSync(specPath, 'utf8');
    const originalLedger = readFileSync(ledgerPath, 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(newFeatureCommand('demo-feature', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(readFileSync(specPath, 'utf8')).toBe(originalSpec);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedger);

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on a ledger-name collision, without writing the spec', async () => {
    await installCommand(tmpDir);
    const id = `feat-${todayIsoDateForTest()}-demo-feature`;
    const ledgerPath = path.join(tmpDir, 'tasks', `${id}.ledger.yaml`);
    writeFileSync(ledgerPath, 'spec_id: other\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(newFeatureCommand('demo-feature', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(ledgerPath);
    expect(existsSync(path.join(tmpDir, 'specs', 'features', 'demo-feature.md'))).toBe(false);

    errorSpy.mockRestore();
  });

  it('leaves the exit code untouched, creates both the spec and ledger files, and logs a relative-path confirmation on a clean run', async () => {
    await installCommand(tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(newFeatureCommand('demo-feature', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(tmpDir, 'specs', 'features', 'demo-feature.md'))).toBe(true);

    const ledgerFiles = readdirSync(path.join(tmpDir, 'tasks')).filter((f) =>
      f.endsWith('.ledger.yaml')
    );
    expect(ledgerFiles).toHaveLength(1);
    expect(ledgerFiles[0]).toMatch(/^feat-\d{4}-\d{2}-\d{2}-demo-feature\.ledger\.yaml$/);
    const ledgerRelPath = path.join('tasks', ledgerFiles[0]!);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('Created feature spec');
    expect(logged).toContain(path.join('specs', 'features', 'demo-feature.md'));
    expect(logged).toContain(ledgerRelPath);
    // Relative, not absolute: must not contain the tmpDir prefix.
    expect(logged).not.toContain(tmpDir);

    logSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints the underlying error on a non-domain failure', async () => {
    await installCommand(tmpDir);

    // Force createFeatureSpec's spec write step to hit a raw filesystem
    // error (not one of the domain error types), mirroring
    // newPatchCommand's equivalent test: replace specs/features with a
    // plain file, so the `mkdir(..., { recursive: true })` on that path
    // fails (ENOTDIR on Linux, EEXIST on macOS) before either write is
    // even attempted — a raw fs error, not a domain error type, and not
    // the ledger-rollback path (that's specs/features, not tasks/).
    rmSync(path.join(tmpDir, 'specs', 'features'), { recursive: true, force: true });
    writeFileSync(path.join(tmpDir, 'specs', 'features'), 'not a directory\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newFeatureCommand('demo-feature', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toMatch(/^Error: /);
    expect(logged).not.toContain('waypoint new-feature:');
    expect(logged).toContain(path.join(tmpDir, 'specs', 'features'));

    errorSpy.mockRestore();
  });
});

describe('CLI program — new-feature wiring', () => {
  it('wires "waypoint new-feature <name>" through the real command-parsing path to createFeatureSpec', async () => {
    await installCommand(tmpDir);

    const program = createProgram();
    program.exitOverride(); // don't let a Commander parse error call the real process.exit in this test

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // program.ts's action calls newFeatureCommand(name) with the default
    // cwd (process.cwd()) — exercise that real wiring by pointing the
    // process at tmpDir for the duration of this call, restoring after.
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['new-feature', 'wired-feature'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(tmpDir, 'specs', 'features', 'wired-feature.md'))).toBe(true);

    const ledgerFiles = readdirSync(path.join(tmpDir, 'tasks')).filter((f) =>
      f.endsWith('.ledger.yaml')
    );
    expect(ledgerFiles).toHaveLength(1);
    expect(ledgerFiles[0]).toMatch(/^feat-\d{4}-\d{2}-\d{2}-wired-feature\.ledger\.yaml$/);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Created feature spec'));

    logSpy.mockRestore();
  });
});

describe('newSystemCommand', () => {
  it('sets a non-zero exit code and prints a clear message when the repo is not installed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newSystemCommand('demo-system', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('waypoint install');

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on an invalid name', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newSystemCommand('../escape', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on a spec-name collision, without overwriting any file', async () => {
    await installCommand(tmpDir);
    await newSystemCommand('demo-system', tmpDir);

    const specDir = path.join(tmpDir, 'specs', 'systems', 'demo-system');
    const prdPath = path.join(specDir, 'prd.md');
    const architecturePath = path.join(specDir, 'architecture.md');
    const adrPath = path.join(specDir, 'adr.md');
    const ledgerFiles = readdirSync(path.join(tmpDir, 'tasks')).filter((f) =>
      f.endsWith('.ledger.yaml')
    );
    expect(ledgerFiles).toHaveLength(1);
    const ledgerPath = path.join(tmpDir, 'tasks', ledgerFiles[0]!);

    const originalPrd = readFileSync(prdPath, 'utf8');
    const originalArchitecture = readFileSync(architecturePath, 'utf8');
    const originalAdr = readFileSync(adrPath, 'utf8');
    const originalLedger = readFileSync(ledgerPath, 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(newSystemCommand('demo-system', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(readFileSync(prdPath, 'utf8')).toBe(originalPrd);
    expect(readFileSync(architecturePath, 'utf8')).toBe(originalArchitecture);
    expect(readFileSync(adrPath, 'utf8')).toBe(originalAdr);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedger);

    errorSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints a clear message on a ledger-name collision, without writing the spec-set', async () => {
    await installCommand(tmpDir);
    const id = `system-${todayIsoDateForTest()}-demo-system`;
    const ledgerPath = path.join(tmpDir, 'tasks', `${id}.ledger.yaml`);
    writeFileSync(ledgerPath, 'spec_id: other\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(newSystemCommand('demo-system', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(ledgerPath);
    expect(existsSync(path.join(tmpDir, 'specs', 'systems', 'demo-system'))).toBe(false);

    errorSpy.mockRestore();
  });

  it('leaves the exit code untouched, creates all four files, and logs a relative-path confirmation on a clean run', async () => {
    await installCommand(tmpDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(newSystemCommand('demo-system', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    const specDir = path.join(tmpDir, 'specs', 'systems', 'demo-system');
    expect(existsSync(path.join(specDir, 'prd.md'))).toBe(true);
    expect(existsSync(path.join(specDir, 'architecture.md'))).toBe(true);
    expect(existsSync(path.join(specDir, 'adr.md'))).toBe(true);

    const ledgerFiles = readdirSync(path.join(tmpDir, 'tasks')).filter((f) =>
      f.endsWith('.ledger.yaml')
    );
    expect(ledgerFiles).toHaveLength(1);
    expect(ledgerFiles[0]).toMatch(/^system-\d{4}-\d{2}-\d{2}-demo-system\.ledger\.yaml$/);
    const ledgerRelPath = path.join('tasks', ledgerFiles[0]!);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('Created system spec');
    expect(logged).toContain(path.join('specs', 'systems', 'demo-system'));
    expect(logged).toContain(ledgerRelPath);
    // Relative, not absolute: must not contain the tmpDir prefix.
    expect(logged).not.toContain(tmpDir);

    logSpy.mockRestore();
  });

  it('sets a non-zero exit code and prints the underlying error on a non-domain failure', async () => {
    await installCommand(tmpDir);

    // Force createSystemSpec's own `mkdir(specDir, { recursive: true })` to
    // hit a raw filesystem error (not one of the domain error types):
    // replace specs/systems with a plain file, so that mkdir call — which
    // happens before any write is attempted, outside any try/catch that
    // would translate an EEXIST into a domain error — fails (ENOTDIR on
    // Linux, EEXIST on macOS) with the raw error. Mirrors
    // newFeatureCommand's/newPatchCommand's equivalent tests, which block
    // their own target's parent directory the same way.
    rmSync(path.join(tmpDir, 'specs', 'systems'), { recursive: true, force: true });
    writeFileSync(path.join(tmpDir, 'specs', 'systems'), 'not a directory\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(newSystemCommand('demo-system', tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toMatch(/^Error: /);
    expect(logged).not.toContain('waypoint new-system:');
    expect(logged).toContain(path.join(tmpDir, 'specs', 'systems'));

    errorSpy.mockRestore();
  });
});

describe('CLI program — new-system wiring', () => {
  it('wires "waypoint new-system <name>" through the real command-parsing path to createSystemSpec', async () => {
    await installCommand(tmpDir);

    const program = createProgram();
    program.exitOverride(); // don't let a Commander parse error call the real process.exit in this test

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // program.ts's action calls newSystemCommand(name) with the default
    // cwd (process.cwd()) — exercise that real wiring by pointing the
    // process at tmpDir for the duration of this call, restoring after.
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['new-system', 'wired-system'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBeUndefined();
    const specDir = path.join(tmpDir, 'specs', 'systems', 'wired-system');
    expect(existsSync(path.join(specDir, 'prd.md'))).toBe(true);
    expect(existsSync(path.join(specDir, 'architecture.md'))).toBe(true);
    expect(existsSync(path.join(specDir, 'adr.md'))).toBe(true);

    const ledgerFiles = readdirSync(path.join(tmpDir, 'tasks')).filter((f) =>
      f.endsWith('.ledger.yaml')
    );
    expect(ledgerFiles).toHaveLength(1);
    expect(ledgerFiles[0]).toMatch(/^system-\d{4}-\d{2}-\d{2}-wired-system\.ledger\.yaml$/);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Created system spec'));

    logSpy.mockRestore();
  });
});
