import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { scaffold, ScaffoldConflictError } from './scaffold.js';
import { DEFAULT_PATCH_GLOBS } from './config-defaults.js';

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

    for (const role of ['planner', 'architect', 'implementer', 'reviewer']) {
      const p = path.join(tmpDir, 'roles', `${role}.md`);
      expect(existsSync(p), `${p} should exist`).toBe(true);
      expect(readFileSync(p, 'utf8').length).toBeGreaterThan(0);
    }

    expect(readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8').length).toBeGreaterThan(0);
  });

  it('generates .waypoint/config.yaml whose tiers.patch contains exactly the required globs', async () => {
    await scaffold(tmpDir);

    const raw = readFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), 'utf8');
    const parsed = parse(raw) as { check_command: string; tiers: { patch: string[] } };

    expect(parsed.tiers.patch).toEqual([...DEFAULT_PATCH_GLOBS]);
    expect(parsed.tiers.patch).toEqual(['specs/patches/**', 'docs/**', '*.md', 'tasks/**']);
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
    expect(parsed.tiers.patch).toEqual(['specs/patches/**', 'docs/**', '*.md', 'tasks/**']);

    const gitignore = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gitignore.split(/\r?\n/).filter((l) => l === '.waypoint/.gate-state/')).toHaveLength(1);

    // The lock is released, so a subsequent install still works.
    expect(existsSync(path.join(tmpDir, '.waypoint', '.install.lock'))).toBe(false);
    const followUp = await scaffold(tmpDir);
    expect(followUp.status).toBe('installed');
  });
});
