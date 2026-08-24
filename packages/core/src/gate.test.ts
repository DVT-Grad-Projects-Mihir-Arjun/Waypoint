import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { gate } from './gate.js';
import { scaffold } from './scaffold.js';
import { createFeatureSpec, createPatchSpec, createSystemSpec } from './new-spec.js';

// Partial mocks (wrapping the real implementation) so the
// "cost scales with batch size" test below can assert which paths
// existsSync/readFile were actually called with, without changing any
// behavior for every other test in this file.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-gate-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('gate — enforced file, no delta', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('reports one violation per enforced-tier file when no spec-tier delta is present', async () => {
    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts'],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        file: 'src/index.ts',
        reason: 'Feature/System-tier change with no spec delta in this commit',
      },
    ]);
    expect(result.violations[0]!.specId).toBeUndefined();
  });

  it('reports one violation per enforced-tier file when multiple are present', async () => {
    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', 'src/other.ts'],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.file)).toEqual(['src/index.ts', 'src/other.ts']);
    expect(
      result.violations.every(
        (v) => v.reason === 'Feature/System-tier change with no spec delta in this commit'
      )
    ).toBe(true);
  });
});

describe('gate — enforced file, with delta', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('passes when a specs/features/*.md delta accompanies the enforced-tier file', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when a system spec-set prd.md delta accompanies the enforced-tier file', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');
    const relPath = path.relative(tmpDir, created.prdPath).split(path.sep).join('/');

    const result = await gate({
      mode: 'full-diff',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('recognizes a delta path even when it is backslash-separated', async () => {
    const created = await createFeatureSpec(tmpDir, 'backslash-delta');
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');
    const backslashPath = relPath.split('/').join('\\');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', backslashPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when a system spec-set architecture.md delta accompanies the enforced-tier file', async () => {
    const created = await createSystemSpec(tmpDir, 'payments-platform');
    const relPath = path.relative(tmpDir, created.architecturePath).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when a system spec-set adr.md delta accompanies the enforced-tier file', async () => {
    const created = await createSystemSpec(tmpDir, 'ledger-platform');
    const relPath = path.relative(tmpDir, created.adrPath).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when a specs/patches/*.md spec overridden UP to tier: feature accompanies the enforced-tier file', async () => {
    const created = await createPatchSpec(tmpDir, 'upgraded-to-feature');
    const raw = readFileSync(created.path, 'utf8');
    const patched = raw.replace('tier: patch', 'tier: feature');
    writeFileSync(created.path, patched);
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when a specs/patches/*.md spec overridden UP to tier: system accompanies the enforced-tier file', async () => {
    const created = await createPatchSpec(tmpDir, 'upgraded-to-system');
    const raw = readFileSync(created.path, 'utf8');
    const patched = raw.replace('tier: patch', 'tier: system');
    writeFileSync(created.path, patched);
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('satisfies two or more distinct enforced-tier files with a single qualifying delta (whole-batch, not per-file)', async () => {
    const created = await createFeatureSpec(tmpDir, 'shared-delta');
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', 'src/other.ts', 'src/third.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe('gate — deletion, no delta', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('treats a removed enforced-tier path the same as a non-deletion change — still a violation', async () => {
    const removedPath = 'src/removed.ts';

    const result = await gate({
      mode: 'staged',
      changedFiles: [removedPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        file: removedPath,
        reason: 'Feature/System-tier change with no spec delta in this commit',
      },
    ]);
  });
});

describe('gate — deletion of the spec-tier delta itself', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('does not let a deleted spec-tier file satisfy the delta requirement for another enforced file', async () => {
    const created = await createFeatureSpec(tmpDir, 'deleted-delta');
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');

    // The spec file itself was deleted in this batch — it no longer exists
    // on disk, so it must not count as the delta for src/index.ts.
    unlinkSync(created.path);

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.file).sort()).toEqual(['src/index.ts', relPath].sort());
    expect(
      result.violations.every(
        (v) => v.reason === 'Feature/System-tier change with no spec delta in this commit'
      )
    ).toBe(true);
  });
});

describe('gate — patch-tier only', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('passes when every path in the batch classifies unenforced — no delta ever required', async () => {
    const result = await gate({
      mode: 'staged',
      changedFiles: ['docs/readme.md', 'CHANGELOG.md', 'tasks/some.ledger.yaml'],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe('gate — delta is itself patch-tier', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('does not count a spec-tier file overridden to patch tier as a delta', async () => {
    const created = await createFeatureSpec(tmpDir, 'downgraded-delta');
    const raw = readFileSync(created.path, 'utf8');
    const patched = raw.replace('tier: feature', 'tier: patch');
    writeFileSync(created.path, patched);
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        file: 'src/index.ts',
        reason: 'Feature/System-tier change with no spec delta in this commit',
      },
    ]);
  });

  it('does not count a specs/patches/** spec (patch-glob-matched, no override) as a delta', async () => {
    const created = await createPatchSpec(tmpDir, 'fix-typo');
    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', relPath],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        file: 'src/index.ts',
        reason: 'Feature/System-tier change with no spec delta in this commit',
      },
    ]);
  });
});

describe('gate — config missing/malformed', () => {
  it('reports exactly one violation naming .waypoint/config.yaml when config.yaml is missing', async () => {
    // Deliberately not scaffolded — no .waypoint/config.yaml at all.
    const result = await gate({
      mode: 'staged',
      changedFiles: ['src/index.ts', 'specs/features/looks-like-a-delta.md'],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.file).toBe('.waypoint/config.yaml');
    expect(result.violations[0]!.reason).toMatch(/config error/);
    // Distinct from the delta-missing message.
    expect(result.violations[0]!.reason).not.toBe(
      'Feature/System-tier change with no spec delta in this commit'
    );
  });

  it('reports the config-error violation regardless of a coincidentally spec-shaped path in the batch', async () => {
    await scaffold(tmpDir);
    writeFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), '');

    const result = await gate({
      mode: 'staged',
      changedFiles: ['specs/features/decoy.md', 'src/index.ts'],
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { file: '.waypoint/config.yaml', reason: expect.stringMatching(/config error/) },
    ]);
  });
});

describe('gate — empty batch', () => {
  it('passes with no violations when changedFiles is empty and config is valid — nothing to enforce', async () => {
    await scaffold(tmpDir);

    const result = await gate({ mode: 'staged', changedFiles: [], repoRoot: tmpDir });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('still reports the config-error violation for an empty batch when config is missing/malformed', async () => {
    // Deliberately not scaffolded — no .waypoint/config.yaml at all. Config-error
    // precedence applies regardless of batch size, even an empty one: a missing
    // config is a repo health problem independent of what's being committed.
    const result = await gate({ mode: 'staged', changedFiles: [], repoRoot: tmpDir });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.reason).toMatch(/config error/);
  });
});

describe('gate — Acceptance Criteria: cost scales with batch size, not repo size', () => {
  it('evaluates a batch of thousands of paths quickly, without reading anything beyond the batch', async () => {
    await scaffold(tmpDir);

    // Decoy repo content well outside the changed-files batch. If gate() (or
    // its classifyChangedFiles dependency) ever walked the working tree or
    // globbed the whole repo instead of scaling with changedFiles.length,
    // this would balloon the runtime and/or risk reading these files.
    const decoyDir = path.join(tmpDir, 'decoy');
    mkdirSync(decoyDir, { recursive: true });
    for (let i = 0; i < 3000; i++) {
      writeFileSync(path.join(decoyDir, `file-${i}.ts`), '// decoy, never in the batch\n');
    }
    // A decoy spec-shaped file with frontmatter that would throw if ever
    // parsed as YAML — proving it's never touched since it's not in the batch.
    mkdirSync(path.join(tmpDir, 'specs', 'features'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'specs', 'features', 'decoy-unparseable.md'),
      '---\ntier: [unterminated\n---\n'
    );

    const changedFiles = Array.from({ length: 5000 }, (_, i) => `src/generated-${i}.ts`);

    // I/O-scope assertion: spy on every fs primitive gate()/classifyChangedFiles()
    // actually use, and assert none of them is ever called with a path pointing
    // at the decoy directory or the decoy unparseable spec file. This catches an
    // implementation that stays fast (e.g. by short-circuiting) while still
    // reading extra files it has no business touching — something the
    // elapsed-time/violation-count checks alone would never notice.
    (existsSync as unknown as Mock).mockClear();
    (readFile as unknown as Mock).mockClear();

    const start = performance.now();
    const result = await gate({ mode: 'staged', changedFiles, repoRoot: tmpDir });
    const elapsedMs = performance.now() - start;

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(5000);
    expect(elapsedMs).toBeLessThan(3000);

    const decoySpecPath = path.join(tmpDir, 'specs', 'features', 'decoy-unparseable.md');
    const touchedDecoy = (calls: unknown[][]) =>
      calls.some((args) => {
        const arg0 = args[0];
        return typeof arg0 === 'string' && (arg0.startsWith(decoyDir) || arg0 === decoySpecPath);
      });

    expect(touchedDecoy((existsSync as unknown as Mock).mock.calls)).toBe(false);
    expect(touchedDecoy((readFile as unknown as Mock).mock.calls)).toBe(false);
  });
});
