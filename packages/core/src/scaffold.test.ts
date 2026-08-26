import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { acquireLock, scaffold, ScaffoldConflictError } from './scaffold.js';
import { gate } from './gate.js';
import { DEFAULT_PATCH_GLOBS } from './config-defaults.js';
import { renderAgentsMd } from './templates/agents-md.js';
import {
  renderPlannerPrompt,
  renderArchitectPrompt,
  renderImplementerPrompt,
  renderReviewerPrompt,
} from './templates/roles.js';

// The built CLI entry point — used only by the real-installed-hook test
// below, to prove `scaffold()`'s own first commit genuinely passes through
// the real pre-commit hook (which shells to Story 3.2's real `gate()`),
// mirroring `verify.test.ts`'s and `packages/cli/src/gate.test.ts`'s own
// analogous end-to-end tests. Requires `npm run build` to have run first.
const CLI_DIST_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../cli/dist/index.js'
);

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(cwd: string): void {
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-scaffold-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const SIX_SCAFFOLD_PATHS = ['specs', 'tasks', 'decisions', 'roles', 'AGENTS.md', path.join('.waypoint', 'config.yaml')];

describe('scaffold — fresh install', () => {
  it('creates all six scaffolded paths, plus subdirs and role files, with no errors', async () => {
    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');

    for (const rel of SIX_SCAFFOLD_PATHS) {
      expect(existsSync(path.join(tmpDir, rel)), `${rel} should exist`).toBe(true);
    }

    for (const sub of ['patches', 'features', 'systems']) {
      const p = path.join(tmpDir, 'specs', sub);
      expect(existsSync(p), `${p} should exist`).toBe(true);
      expect(statSync(p).isDirectory()).toBe(true);
    }

    const roleRenderers: Record<string, () => string> = {
      planner: renderPlannerPrompt,
      architect: renderArchitectPrompt,
      implementer: renderImplementerPrompt,
      reviewer: renderReviewerPrompt,
    };

    for (const [role, render] of Object.entries(roleRenderers)) {
      const p = path.join(tmpDir, 'roles', `${role}.md`);
      expect(existsSync(p), `${p} should exist`).toBe(true);
      const content = readFileSync(p, 'utf8');
      // Two checks, two different things: a role-specific heading-marker
      // check (matching the AGENTS.md precedent immediately below — a real,
      // role-specific marker rather than a mere non-empty length check), and
      // an exact-content-equality check against calling the corresponding
      // render function directly, confirming scaffold()'s ROLE_RENDERERS map
      // wires each role to the correct function (not, say, swapped or all
      // pointing at one renderer). The `approve`-exclusion property itself
      // is verified precisely (per-role, against each function's own return
      // value) by `templates/roles.test.ts` — not repeated here to avoid a
      // second, blunter whole-document substring check.
      const headingPattern = new RegExp(`^#\\s+${role.charAt(0).toUpperCase()}${role.slice(1)}`);
      expect(content).toMatch(headingPattern);
      expect(content).toBe(render());
    }

    const agentsMdContent = readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8');
    expect(agentsMdContent).toBe(renderAgentsMd());
    // Independently verify meaningful content directly (not just a raw
    // string comparison against renderAgentsMd()'s own output), matching the
    // rigor of the neighboring config.yaml assertion below which parses the
    // YAML and asserts on actual field values rather than a string compare.
    // The `approve`-exclusion property itself is verified precisely (scoped
    // to the Available Commands section, not a whole-document substring
    // check) by `templates/agents-md.test.ts` — not repeated here to avoid a
    // second, less precise copy of the same check.
    expect(agentsMdContent).toMatch(/#+\s*Tier Selection/);
    expect(agentsMdContent).toMatch(/#+\s*Available Commands/);
    expect(agentsMdContent).toMatch(/#+\s*Role Prompts/);
  });

  it('generates .waypoint/config.yaml whose tiers.patch contains exactly the required globs', async () => {
    await scaffold(tmpDir);

    const raw = readFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), 'utf8');
    const parsed = parse(raw) as { check_command: string; tiers: { patch: string[] } };

    expect(parsed.tiers.patch).toEqual([...DEFAULT_PATCH_GLOBS]);
    expect(parsed.tiers.patch).toEqual([
      'specs/patches/**',
      'docs/**',
      '*.md',
      'tasks/**',
      '.gitignore',
      '.waypoint/config.yaml',
      'roles/**',
    ]);
    expect(typeof parsed.check_command).toBe('string');
    expect(parsed.check_command.length).toBeGreaterThan(0);
  });

  it('adds .waypoint/.gate-state/ to .gitignore', async () => {
    await scaffold(tmpDir);

    const gitignore = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gitignore.split(/\r?\n/)).toContain('.waypoint/.gate-state/');
  });

  it('appends to an existing .gitignore idempotently instead of duplicating the entry', async () => {
    writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');

    await scaffold(tmpDir);
    await scaffold(tmpDir); // reinstall should not duplicate the line

    const gitignore = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const lines = gitignore.split(/\r?\n/).filter((l) => l === '.waypoint/.gate-state/');
    expect(lines).toHaveLength(1);
    expect(gitignore).toContain('node_modules/');
  });

  it('appends onto its own line when the existing .gitignore has no trailing newline', async () => {
    writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/'); // no trailing \n

    await scaffold(tmpDir);

    const gitignore = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const lines = gitignore.split(/\r?\n/);
    expect(lines).toContain('node_modules/');
    expect(lines).toContain('.waypoint/.gate-state/');
    // The two entries must not have been concatenated onto one line.
    expect(gitignore).not.toContain('node_modules/.waypoint/.gate-state/');
  });
});

describe('scaffold — partial pre-existing content is preserved', () => {
  it('leaves pre-existing /specs content untouched while still creating the rest', async () => {
    mkdirSync(path.join(tmpDir, 'specs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'specs', 'custom-notes.txt'), 'do not touch me\n');

    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    expect(readFileSync(path.join(tmpDir, 'specs', 'custom-notes.txt'), 'utf8')).toBe('do not touch me\n');
    // specs/patches etc. still get created underneath the preserved specs/ dir
    expect(existsSync(path.join(tmpDir, 'specs', 'patches'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'specs', 'features'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'specs', 'systems'))).toBe(true);
    // other top-level paths still created
    expect(existsSync(path.join(tmpDir, 'tasks'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'decisions'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'roles'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
  });

  it('does not overwrite a pre-existing AGENTS.md or config.yaml on reinstall', async () => {
    await scaffold(tmpDir);

    writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# my customized agents file\n');
    writeFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), 'check_command: "pytest"\ntiers:\n  patch: []\n');

    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    expect(readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8')).toBe('# my customized agents file\n');
    expect(readFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), 'utf8')).toContain('pytest');
    expect(result.preservedPaths).toContain('AGENTS.md');
    expect(result.preservedPaths).toContain(path.join('.waypoint', 'config.yaml'));
  });

  it('upgrades a stale pre-Epic-4 AGENTS.md/roles placeholder to real content on reinstall, but still preserves a genuine hand-edit', async () => {
    await scaffold(tmpDir);

    // Simulate a repo that ran `waypoint install` before Epic 4 shipped:
    // overwrite AGENTS.md and roles/planner.md with the exact one-line stub
    // Story 1.1 used to generate, and hand-edit roles/architect.md to
    // something a real user might have written instead.
    writeFileSync(
      path.join(tmpDir, 'AGENTS.md'),
      '<!-- Generated by `waypoint install`; content populated by Epic 4. -->\n'
    );
    writeFileSync(
      path.join(tmpDir, 'roles', 'planner.md'),
      '<!-- planner role prompt — generated by `waypoint install`; content populated by Epic 4. -->\n'
    );
    writeFileSync(path.join(tmpDir, 'roles', 'architect.md'), '# my own architect notes\n');

    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');

    // The two stale placeholders were upgraded to real, current content.
    expect(result.upgradedPaths).toContain('AGENTS.md');
    expect(result.upgradedPaths).toContain(path.join('roles', 'planner.md'));
    expect(result.preservedPaths).not.toContain('AGENTS.md');
    expect(result.preservedPaths).not.toContain(path.join('roles', 'planner.md'));
    const agentsMd = readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).not.toContain('content populated by Epic 4');
    expect(agentsMd).toContain('Available Commands');
    const plannerMd = readFileSync(path.join(tmpDir, 'roles', 'planner.md'), 'utf8');
    expect(plannerMd).not.toContain('content populated by Epic 4');

    // The genuine hand-edit was left completely untouched.
    expect(result.upgradedPaths).not.toContain(path.join('roles', 'architect.md'));
    expect(result.preservedPaths).toContain(path.join('roles', 'architect.md'));
    expect(readFileSync(path.join(tmpDir, 'roles', 'architect.md'), 'utf8')).toBe('# my own architect notes\n');
  });
});

describe('scaffold — path collision', () => {
  it('exits with a clear error naming the conflicting path when /tasks is a plain file, without partial writes', async () => {
    writeFileSync(path.join(tmpDir, 'tasks'), 'i am a file, not a directory\n');

    let caught: unknown;
    try {
      await scaffold(tmpDir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ScaffoldConflictError);
    expect((caught as ScaffoldConflictError).conflictingPath).toBe(path.join(tmpDir, 'tasks'));

    // No partial writes to other paths.
    expect(existsSync(path.join(tmpDir, 'decisions'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'roles'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(tmpDir, '.waypoint', 'config.yaml'))).toBe(false);

    // The conflicting file itself is untouched.
    expect(readFileSync(path.join(tmpDir, 'tasks'), 'utf8')).toBe('i am a file, not a directory\n');
  });

  it('releases the install lock even when a conflict is found, so a later fixed run can succeed', async () => {
    writeFileSync(path.join(tmpDir, 'decisions'), 'conflict\n');

    await expect(scaffold(tmpDir)).rejects.toThrow(ScaffoldConflictError);

    rmSync(path.join(tmpDir, 'decisions'));

    const result = await scaffold(tmpDir);
    expect(result.status).toBe('installed');
    expect(statSync(path.join(tmpDir, 'decisions')).isDirectory()).toBe(true);
  });
});

describe('scaffold — git hook installation', () => {
  const HOOK_PATHS = [
    path.join('.git', 'hooks', 'pre-commit'),
    path.join('.git', 'hooks', 'pre-merge-commit'),
  ];

  it('writes both hook files as executable and lists them under createdPaths when .git is present', async () => {
    mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    expect(result.warnings).toEqual([]);

    for (const rel of HOOK_PATHS) {
      const abs = path.join(tmpDir, rel);
      expect(existsSync(abs), `${rel} should exist`).toBe(true);
      expect(result.createdPaths).toContain(rel);

      const content = readFileSync(abs, 'utf8');
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain('Installed by waypoint install');
      expect(content).toContain('exec npx waypoint gate');

      // Windows' fs layer doesn't implement POSIX permission bits (only a
      // read-only attribute) — `chmod`/`stat().mode` there never reports
      // 0o755, so this exact-mode assertion is POSIX-only, matching the
      // Windows-awareness precedent elsewhere in this codebase.
      if (process.platform !== 'win32') {
        const mode = statSync(abs).mode & 0o777;
        expect(mode).toBe(0o755);
      }
    }
  });

  it('reports both hooks under preservedPaths, untouched, on re-install', async () => {
    mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

    await scaffold(tmpDir);
    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    expect(result.warnings).toEqual([]);
    for (const rel of HOOK_PATHS) {
      expect(result.preservedPaths).toContain(rel);
      expect(result.createdPaths).not.toContain(rel);
    }
  });

  it('preserves a foreign pre-existing hook untouched and warns about it by name', async () => {
    mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    const foreignHookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    writeFileSync(foreignHookPath, "#!/bin/sh\necho \"some other tool's hook\"\n");

    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    expect(readFileSync(foreignHookPath, 'utf8')).toContain('some other tool');
    expect(result.preservedPaths).toContain(path.join('.git', 'hooks', 'pre-commit'));
    expect(result.createdPaths).not.toContain(path.join('.git', 'hooks', 'pre-commit'));
    expect(result.warnings.some((w) => w.includes(path.join('.git', 'hooks', 'pre-commit')))).toBe(
      true
    );

    // The other hook (no foreign conflict) is still installed normally.
    expect(result.createdPaths).toContain(path.join('.git', 'hooks', 'pre-merge-commit'));
  });

  it('re-asserts the executable bit on a previously-installed Waypoint hook that lost it', async () => {
    // Windows' fs layer doesn't implement POSIX permission bits, so this
    // regression guard (like the exact-mode assertions above) is POSIX-only.
    if (process.platform === 'win32') return;

    mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    await scaffold(tmpDir);

    const hookAbsPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    chmodSync(hookAbsPath, 0o644);
    expect(statSync(hookAbsPath).mode & 0o777).toBe(0o644);

    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    expect(result.warnings).toEqual([]);
    expect(statSync(hookAbsPath).mode & 0o777).toBe(0o755);
  });

  it('skips hook installation with a warning, but still completes the rest of the scaffold, when .git is entirely absent', async () => {
    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    for (const rel of HOOK_PATHS) {
      expect(existsSync(path.join(tmpDir, rel))).toBe(false);
    }
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes('.git'))).toBe(true);

    // Rest of the scaffold still completed.
    for (const rel of SIX_SCAFFOLD_PATHS) {
      expect(existsSync(path.join(tmpDir, rel)), `${rel} should exist`).toBe(true);
    }
  });

  it('skips hook installation with a warning when .git exists but is not a plain directory (worktree/submodule)', async () => {
    writeFileSync(path.join(tmpDir, '.git'), 'gitdir: /elsewhere/.git/worktrees/example\n');

    const result = await scaffold(tmpDir);

    expect(result.status).toBe('installed');
    for (const rel of HOOK_PATHS) {
      expect(existsSync(path.join(tmpDir, rel))).toBe(false);
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('scaffold — concurrent install', () => {
  it('leaves a fully correct, non-corrupted scaffold when two installs run at once', async () => {
    const [resultA, resultB] = await Promise.all([scaffold(tmpDir), scaffold(tmpDir)]);

    expect(['installed', 'skipped-lock-contention']).toContain(resultA.status);
    expect(['installed', 'skipped-lock-contention']).toContain(resultB.status);
    // At least one of the two actually did the work.
    expect([resultA.status, resultB.status]).toContain('installed');

    for (const rel of SIX_SCAFFOLD_PATHS) {
      expect(existsSync(path.join(tmpDir, rel)), `${rel} should exist`).toBe(true);
    }

    const raw = readFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), 'utf8');
    const parsed = parse(raw) as { tiers: { patch: string[] } };
    expect(parsed.tiers.patch).toEqual([...DEFAULT_PATCH_GLOBS]);

    const gitignore = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gitignore.split(/\r?\n/).filter((l) => l === '.waypoint/.gate-state/')).toHaveLength(1);

    // The lock is released, so a subsequent install still works.
    expect(existsSync(path.join(tmpDir, '.waypoint', '.install.lock'))).toBe(false);
    const followUp = await scaffold(tmpDir);
    expect(followUp.status).toBe('installed');
  });
});

describe('scaffold — its own first commit passes the real installed gate hook (Finding 1 regression)', () => {
  it("a fresh install's own scaffolded output (.gitignore, .waypoint/config.yaml, roles/*.md included) commits cleanly through the real pre-commit hook with no spec delta needed", async () => {
    // Unlike every other test in this file, this one deliberately uses a
    // real git repo and the real installed pre-commit hook (which shells to
    // Story 3.2's real `gate()`) instead of just inspecting scaffold()'s
    // return value — the whole point is to prove the very first
    // `git add -A && git commit` a fresh `waypoint install` invites actually
    // succeeds, not merely that DEFAULT_PATCH_GLOBS contains the right
    // strings. Mirrors verify.test.ts's and packages/cli/src/gate.test.ts's
    // own "real installed hook" end-to-end tests.
    initGitRepo(tmpDir);

    const scaffoldResult = await scaffold(tmpDir);
    expect(scaffoldResult.warnings).toEqual([]);

    // The hook's `npx waypoint gate` line assumes the package is
    // published/linked; point it at this repo's own built CLI instead, same
    // technique the other real-hook tests use.
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const hookContent = readFileSync(hookPath, 'utf8');
    // Guard the replace below: if the hook template's exact wording ever
    // changes, fail loudly right here instead of the replace silently
    // no-op'ing and the real `npx` shell-out failing later for a confusing,
    // unrelated reason.
    expect(hookContent).toContain('exec npx waypoint gate');
    writeFileSync(
      hookPath,
      hookContent.replace('exec npx waypoint gate', `exec node '${CLI_DIST_ENTRY}' gate`)
    );

    git(['add', '-A'], tmpDir);

    expect(() => git(['commit', '-m', 'init'], tmpDir)).not.toThrow();

    const log = git(['log', '--oneline'], tmpDir);
    expect(log).toContain('init');

    const changedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'], tmpDir)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    // `git show`'s own path reporting is always forward-slash-normalized,
    // regardless of host OS -- compare against literals, not `path.join`
    // (which would produce a backslash on Windows and never match; this
    // exact pattern has already broken CI three times this session).
    expect(changedFiles).toContain('.gitignore');
    expect(changedFiles).toContain('.waypoint/config.yaml');
    expect(changedFiles).toContain('roles/planner.md');
    expect(changedFiles).toContain('AGENTS.md');

    // Also call gate() directly against the same changed-file list, so a
    // future regression that only breaks classification for one specific
    // path (e.g. `roles/**` stops matching but `.gitignore` still does)
    // names which violation fired in this test's own failure output, rather
    // than the assertion above just reporting "the commit threw."
    const gateResult = await gate({ mode: 'staged', changedFiles, repoRoot: tmpDir });
    expect(gateResult.violations).toEqual([]);
    expect(gateResult.ok).toBe(true);
  }, 20000);
});

describe('scaffold — lock staleness is decoupled from lock wait timeout (epic-1-5 MVP retrospective, Batch 2 fix)', () => {
  // `LOCK_STALE_MS` used to equal `LOCK_MAX_WAIT_MS` (5s): a waiter that
  // timed out waiting for the lock would immediately conclude it was stale
  // and forcibly reclaim it, even though a legitimate holder whose critical
  // section takes as little as 5 seconds (now plausible for `update`/
  // `approve`, which route their entire command bodies through this same
  // lock via `verify.ts`'s `withSpecLock`) would still be genuinely working.
  // These two tests prove the fix directly against the exported
  // `acquireLock` primitive: a lock older than the 5s wait but younger than
  // the new, much larger `LOCK_STALE_MS` (60s) must NOT be reclaimed, while
  // one genuinely older than 60s still is.

  it('does not reclaim a lock held past the 5s wait but under the 60s staleness threshold -- reports contention instead', async () => {
    const lockDir = path.join(tmpDir, '.held.lock');
    mkdirSync(lockDir);
    // 10s old: past `LOCK_MAX_WAIT_MS` (5s) -- a waiter will time out -- but
    // nowhere near `LOCK_STALE_MS` (60s) -- a legitimate holder plausibly
    // still working, not abandoned.
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    utimesSync(lockDir, tenSecondsAgo, tenSecondsAgo);

    const acquired = await acquireLock(lockDir);

    expect(acquired).toBe(false);
    // The lock must survive untouched -- the still-running "holder" (this
    // test's own pre-created directory, standing in for it) must not have
    // been reaped out from under it just because a waiter's wait timed out.
    expect(existsSync(lockDir)).toBe(true);
  }, 8000);

  it('does reclaim a lock genuinely older than the 60s staleness threshold, once the 5s wait also times out', async () => {
    const lockDir = path.join(tmpDir, '.abandoned.lock');
    mkdirSync(lockDir);
    // 70s old: past both `LOCK_MAX_WAIT_MS` and `LOCK_STALE_MS` -- almost
    // certainly abandoned by a crashed/killed process.
    const seventySecondsAgo = new Date(Date.now() - 70_000);
    utimesSync(lockDir, seventySecondsAgo, seventySecondsAgo);

    const acquired = await acquireLock(lockDir);

    expect(acquired).toBe(true);
    // Reclaimed and re-acquired by this same call -- the directory exists
    // again, freshly created and now held by this caller.
    expect(existsSync(lockDir)).toBe(true);
  }, 8000);
});
