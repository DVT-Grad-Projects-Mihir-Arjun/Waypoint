import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Wraps `gate` and `checkDoneClaims` in passthrough mocks (default behavior:
// call straight through to the real implementation) so targeted tests below
// can temporarily make either one throw, to prove `gateCommand` catches that
// cleanly instead of letting a raw exception escape -- and, for the `--ci`
// path, that one throwing still lets the other check's result be computed
// and reported. Every other test in this file relies on the real behavior of
// both via these same passthroughs.
vi.mock('@waypoint/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/core')>();
  return {
    ...actual,
    gate: vi.fn(actual.gate),
    checkDoneClaims: vi.fn(actual.checkDoneClaims),
  };
});
import * as waypointCore from '@waypoint/core';
import { scaffold } from '@waypoint/core';

// Passthrough-wraps `execFileSync` so the `--ci`/`--base` usage-error tests
// below can assert zero git calls were attempted, without changing behavior
// for any other test in this file (including this file's own `git()` fixture
// helper, which goes through this same wrapped export).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import * as childProcess from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateCommand } from './commands/gate.js';
import { createProgram } from './program.js';

// The built CLI entry point — used only to prove the *actual installed hook
// file* (not a direct gateCommand() call) triggers correctly through a real
// `git commit`. Requires `npm run build` to have run first, same as every
// other test in this suite that exercises compiled output indirectly.
const CLI_DIST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(cwd: string): void {
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-gate-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

describe('gateCommand — real git repo fixture', () => {
  it('blocks and prints a clear message when an enforced-tier file is staged with no spec delta', async () => {
    initGitRepo(tmpDir);
    await scaffold(tmpDir);

    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');
    git(['add', 'src/index.ts'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint gate:');
    expect(logged).toContain('src/index.ts');
    expect(logged).toContain('no spec delta');

    errorSpy.mockRestore();
  });

  it('passes silently when a qualifying spec delta is staged alongside the enforced-tier file', async () => {
    initGitRepo(tmpDir);
    await scaffold(tmpDir);

    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');

    mkdirSync(path.join(tmpDir, 'specs', 'features'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'specs', 'features', 'demo.md'),
      '---\ntitle: demo\ntier: feature\n---\n\nSome delta.\n'
    );

    git(['add', 'src/index.ts', 'specs/features/demo.md'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(gateCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('exits 0 silently when only patch-tier files are staged', async () => {
    initGitRepo(tmpDir);
    await scaffold(tmpDir);

    writeFileSync(path.join(tmpDir, 'README.md'), '# hello\n');
    git(['add', 'README.md'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('catches a non-git-repo cwd and reports a clear, single-line message instead of throwing', async () => {
    // tmpDir is never `git init`-ed here.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint gate:');
    expect(logged).toContain('unable to resolve staged changes');
    // Regression guard: git's own stderr for this case is a multi-hundred-line
    // usage dump (its --no-index fallback rejects `--cached`) — the logged
    // message must stay a single line, not embed that whole dump.
    expect(logged.split('\n')).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it('never leaks the child git process\'s raw stderr to this process\'s own real stderr', async () => {
    // Without an explicit `stdio` option, execFileSync inherits a failing
    // child's stderr straight through to the parent's real stderr in
    // addition to capturing it into `err.stderr` — confirmed by direct
    // reproduction. That bypasses console.error entirely, so the previous
    // test's assertion on the logged *message* wouldn't catch it; this test
    // spies on the raw fd-level write instead.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(gateCommand(tmpDir)).resolves.toBeUndefined();

    const rawWrites = stderrWriteSpy.mock.calls.map((call) => String(call[0]));
    expect(rawWrites.some((chunk) => chunk.includes('usage: git diff'))).toBe(false);

    stderrWriteSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('correctly recognizes a staged file whose name contains a non-ASCII character (the -z/quote-escape regression guard)', async () => {
    // Without `-z`, git's default `core.quotepath=true` C-style-escapes a
    // non-ASCII filename (e.g. `caf\303\251.ts` instead of the literal
    // `café.ts`) in `--name-only` output, corrupting the path before it
    // reaches `gate()`. With `-z`, the raw literal path is always emitted.
    initGitRepo(tmpDir);
    await scaffold(tmpDir);

    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const nonAsciiName = 'café.ts';
    writeFileSync(path.join(tmpDir, 'src', nonAsciiName), 'export const x = 1;\n');
    git(['add', path.join('src', nonAsciiName)], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    // The literal, unescaped filename must appear — not a quoted/escaped
    // form (which would contain a `"` or backslash-octal sequence instead).
    expect(logged).toContain(nonAsciiName);
    expect(logged).not.toContain('\\303\\251');

    errorSpy.mockRestore();
  });

  it('catches gate() itself throwing and reports a clear internal-error message instead of letting the exception escape', async () => {
    initGitRepo(tmpDir);
    await scaffold(tmpDir);

    writeFileSync(path.join(tmpDir, 'README.md'), '# hello\n');
    git(['add', 'README.md'], tmpDir);

    const mockedGate = vi.mocked(waypointCore.gate);
    mockedGate.mockImplementationOnce(() => {
      throw new Error('boom: simulated internal gate failure');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(gateCommand(tmpDir)).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0]?.[0]);
      expect(logged).toContain('waypoint gate:');
      expect(logged).toContain('internal error while evaluating the gate');
      expect(logged).toContain('boom: simulated internal gate failure');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('gateCommand — network-surface neutrality', () => {
  it('makes zero network calls while still legitimately shelling out to git', async () => {
    initGitRepo(tmpDir);
    await scaffold(tmpDir);

    writeFileSync(path.join(tmpDir, 'README.md'), '# hello\n');
    git(['add', 'README.md'], tmpDir);

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

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(gateCommand(tmpDir)).resolves.toBeUndefined();
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
      errorSpy.mockRestore();
    }
  });
});

describe('end-to-end — the actual installed hook, invoked by a real git commit', () => {
  // This is the AC that matters most: not that gateCommand() returns the
  // right thing when called directly, but that the *hook file scaffold()
  // actually writes* is what git *actually runs* on a real commit attempt.
  // The only adjustment from a real install: the hook's `npx waypoint gate`
  // line is rewritten to invoke this repo's own built CLI entry directly,
  // since this package isn't published/linked — gateCommand's logic and
  // scaffold()'s hook-writing logic are otherwise exercised unmodified.
  function pointHookAtLocalBuild(hookAbsPath: string): void {
    const content = readFileSync(hookAbsPath, 'utf8');
    writeFileSync(
      hookAbsPath,
      content.replace('exec npx waypoint gate', `exec node '${CLI_DIST_ENTRY}' gate`)
    );
  }

  it('actually rejects a real commit when staged enforced-tier code has no delta, and allows it once a delta is added', async () => {
    initGitRepo(tmpDir);
    const scaffoldResult = await scaffold(tmpDir);
    expect(scaffoldResult.warnings).toEqual([]);

    pointHookAtLocalBuild(path.join(tmpDir, '.git', 'hooks', 'pre-commit'));

    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');
    git(['add', 'src/index.ts'], tmpDir);

    expect(() => git(['commit', '-m', 'no delta'], tmpDir)).toThrow();

    mkdirSync(path.join(tmpDir, 'specs', 'features'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'specs', 'features', 'demo.md'),
      '---\ntitle: demo\ntier: feature\n---\n\nSome delta.\n'
    );
    git(['add', 'specs/features/demo.md'], tmpDir);

    expect(() => git(['commit', '-m', 'with delta'], tmpDir)).not.toThrow();

    const log = git(['log', '--oneline'], tmpDir);
    expect(log).toContain('with delta');
  }, 20000);
});

describe('gateCommand — --ci/--base usage errors', () => {
  it('reports a clear usage error and makes zero git calls when --ci is passed without --base', async () => {
    const execSpy = vi.mocked(childProcess.execFileSync);
    execSpy.mockClear();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir, { ci: true })).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('usage error');
    expect(logged).toContain('--ci');
    expect(logged).toContain('--base');
    expect(execSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('reports a clear usage error and makes zero git calls when --base is passed without --ci', async () => {
    const execSpy = vi.mocked(childProcess.execFileSync);
    execSpy.mockClear();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir, { base: 'main' })).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('usage error');
    expect(execSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('gateCommand — --ci/--base full PR diff (real two-branch fixture)', () => {
  function setUpMainWithScaffold(): void {
    initGitRepo(tmpDir);
    git(['checkout', '-b', 'main'], tmpDir);
  }

  // `scaffold()` installs the real pre-commit/pre-merge-commit hooks (`exec
  // npx waypoint gate`), which would otherwise fire on every plain `git
  // commit` below and try to shell out to `npx` -- slow, network-dependent,
  // and irrelevant to what these `--ci`/`--base` tests exercise (they call
  // `gateCommand` directly, never through the hook). Mirrors
  // `verify.test.ts`'s own reasoning for avoiding this, applied here by
  // removing the hooks right after `scaffold()` instead of hand-writing
  // config, so these fixtures still get the real default config/globs.
  function removeGateHooks(cwd: string): void {
    rmSync(path.join(cwd, '.git', 'hooks', 'pre-commit'), { force: true });
    rmSync(path.join(cwd, '.git', 'hooks', 'pre-merge-commit'), { force: true });
  }

  it('fails, naming the file, when a Feature-tier change between base and HEAD has no spec delta', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'add feature code'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir, { ci: true, base: 'main' })).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('src/index.ts');
    expect(logged).toContain('no spec delta');

    errorSpy.mockRestore();
  });

  it('passes (exit 0, silent) once a qualifying spec delta is added alongside the Feature-tier change', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');
    mkdirSync(path.join(tmpDir, 'specs', 'features'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'specs', 'features', 'demo.md'),
      '---\ntitle: demo\ntier: feature\n---\n\nSome delta.\n'
    );
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'add feature code + delta'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir, { ci: true, base: 'main' })).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('reports both a spec-delta violation and a done-claim violation when both fail in the same run', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');

    // A hand-typed status: done with a blank linked_commit -- never went
    // through `waypoint verify` -- committed alongside the delta-less code
    // change above, in the same PR diff.
    mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'tasks', 'feat-demo.ledger.yaml'),
      'tasks:\n  - id: t1\n    status: done\n    linked_commit: null\n'
    );

    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'add feature code + bad ledger'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir, { ci: true, base: 'main' })).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('src/index.ts');
    expect(logged).toContain('no spec delta');
    expect(logged).toContain('feat-demo.ledger.yaml');
    expect(logged).toContain('t1');

    errorSpy.mockRestore();
  });

  it('reports a clear error and exits 1 when --base does not resolve in this checkout', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      gateCommand(tmpDir, { ci: true, base: 'this-ref-does-not-exist' })
    ).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('waypoint gate:');
    expect(logged).toContain('this-ref-does-not-exist');

    errorSpy.mockRestore();
  });

  it('still reports checkDoneClaims\' violations when gate() itself throws unexpectedly', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'tasks', 'feat-demo.ledger.yaml'),
      'tasks:\n  - id: t1\n    status: done\n    linked_commit: null\n'
    );
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'add bad ledger'], tmpDir);

    const mockedGate = vi.mocked(waypointCore.gate);
    mockedGate.mockImplementationOnce(() => {
      throw new Error('boom: simulated internal gate failure');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(gateCommand(tmpDir, { ci: true, base: 'main' })).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // gate()'s own internal-error message is reported...
      expect(logged).toContain('internal error while evaluating the gate');
      expect(logged).toContain('boom: simulated internal gate failure');
      // ...and checkDoneClaims' own (unrelated, already-available) violation
      // is still printed too -- neither check's failure silently swallows
      // the other's result.
      expect(logged).toContain('feat-demo.ledger.yaml');
      expect(logged).toContain('t1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still reports gate()\'s violations when checkDoneClaims() itself throws unexpectedly', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'add feature code, no delta'], tmpDir);

    const mockedCheckDoneClaims = vi.mocked(waypointCore.checkDoneClaims);
    mockedCheckDoneClaims.mockImplementationOnce(() => {
      throw new Error('boom: simulated internal done-claim failure');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(gateCommand(tmpDir, { ci: true, base: 'main' })).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // The spec-delta violation (gate()'s own, already-available result) is
      // still printed...
      expect(logged).toContain('src/index.ts');
      expect(logged).toContain('no spec delta');
      // ...and checkDoneClaims' own internal-error message is reported too.
      expect(logged).toContain('internal error while checking done-claims');
      expect(logged).toContain('boom: simulated internal done-claim failure');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('prints a non-blocking note, and still exits cleanly, when --base resolves to a ref with zero diff against HEAD', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // --base HEAD: a realistic copy-paste mistake -- HEAD trivially has zero
    // diff against itself.
    await expect(gateCommand(tmpDir, { ci: true, base: 'HEAD' })).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('note:');
    expect(logged).toContain('0 files differ');
    expect(logged).toContain('HEAD');

    errorSpy.mockRestore();
  });

  it('sanitizes control characters from a ledger-sourced linked_commit before printing it', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    // A control character (ESC, as part of an ANSI color-escape sequence)
    // embedded in the task id -- crafted CI log injection. Written as a YAML
    // double-quoted `\x1B` escape (not a raw byte in the file) so the YAML
    // parser itself produces the actual ESC character in the parsed string,
    // exactly as a hand-crafted malicious ledger would.
    writeFileSync(
      path.join(tmpDir, 'tasks', 'feat-demo.ledger.yaml'),
      'tasks:\n  - id: "t1\\x1B[31m"\n    status: done\n    linked_commit: null\n'
    );
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'add ledger with control char in id'], tmpDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gateCommand(tmpDir, { ci: true, base: 'main' })).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('\x1b');
    expect(logged).toContain('t1?[31m');

    errorSpy.mockRestore();
  });
});

describe('CLI program — gate --ci/--base wiring (real Commander argv parsing)', () => {
  function setUpMainWithScaffold(): void {
    initGitRepo(tmpDir);
    git(['checkout', '-b', 'main'], tmpDir);
  }

  function removeGateHooks(cwd: string): void {
    rmSync(path.join(cwd, '.git', 'hooks', 'pre-commit'), { force: true });
    rmSync(path.join(cwd, '.git', 'hooks', 'pre-merge-commit'), { force: true });
  }

  it('wires "waypoint gate --ci --base <ref>" through real argv parsing to a genuine spec-delta violation', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;\n');
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'add feature code, no delta'], tmpDir);

    const program = createProgram();
    program.exitOverride();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['gate', '--ci', '--base', 'main'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBe(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('src/index.ts');
    expect(logged).toContain('no spec delta');

    errorSpy.mockRestore();
  });

  it('wires "waypoint gate --ci --base <ref>" through real argv parsing to a clean pass', async () => {
    setUpMainWithScaffold();
    await scaffold(tmpDir);
    removeGateHooks(tmpDir);
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    git(['checkout', '-b', 'feature'], tmpDir);
    writeFileSync(path.join(tmpDir, 'README.md'), '# hello\n');
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'docs only'], tmpDir);

    const program = createProgram();
    program.exitOverride();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await program.parseAsync(['gate', '--ci', '--base', 'main'], { from: 'user' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
