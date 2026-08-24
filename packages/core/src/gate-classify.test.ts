import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyChangedFiles } from './gate-classify.js';
import { scaffold } from './scaffold.js';
import { createFeatureSpec, createPatchSpec, createSystemSpec } from './new-spec.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-gate-classify-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('classifyChangedFiles — patch-glob match', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('classifies a path matching a default tiers.patch glob as unenforced', async () => {
    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md']);

    expect(result.configError).toBeNull();
    expect(result.classifications).toEqual([
      { path: 'docs/readme.md', tier: 'unenforced', reason: 'patch-glob-match' },
    ]);
  });

  it('classifies a path under specs/patches/** as unenforced', async () => {
    const result = await classifyChangedFiles(tmpDir, ['specs/patches/anything.md']);

    expect(result.classifications[0]).toMatchObject({
      tier: 'unenforced',
      reason: 'patch-glob-match',
    });
  });
});

describe('classifyChangedFiles — no glob match (default)', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('classifies a path matching no tiers.patch glob as enforced, reason marking it the default', async () => {
    const result = await classifyChangedFiles(tmpDir, ['src/index.ts']);

    expect(result.configError).toBeNull();
    expect(result.classifications).toEqual([
      { path: 'src/index.ts', tier: 'enforced', reason: 'no-glob-match-default' },
    ]);
  });
});

describe('classifyChangedFiles — config missing/empty/malformed', () => {
  it('classifies every path enforced with exactly one config-error message when config.yaml is missing', async () => {
    // Deliberately not scaffolded — no .waypoint/config.yaml at all.
    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md', 'src/index.ts']);

    expect(result.configError).not.toBeNull();
    expect(result.configError).toMatch(/config error/);
    expect(result.classifications).toEqual([
      { path: 'docs/readme.md', tier: 'enforced', reason: 'config-error' },
      { path: 'src/index.ts', tier: 'enforced', reason: 'config-error' },
    ]);
  });

  it('classifies every path enforced with exactly one config-error message when config.yaml is empty', async () => {
    await scaffold(tmpDir);
    writeFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), '');

    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md', 'src/index.ts']);

    expect(result.configError).not.toBeNull();
    expect(result.classifications.every((c) => c.tier === 'enforced')).toBe(true);
    expect(result.classifications.every((c) => c.reason === 'config-error')).toBe(true);
  });

  it('classifies every path enforced with exactly one config-error message when config.yaml is not valid YAML', async () => {
    await scaffold(tmpDir);
    writeFileSync(
      path.join(tmpDir, '.waypoint', 'config.yaml'),
      'tiers:\n  patch: [unterminated\n'
    );

    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md']);

    expect(result.configError).not.toBeNull();
    expect(result.classifications).toEqual([
      { path: 'docs/readme.md', tier: 'enforced', reason: 'config-error' },
    ]);
  });

  it('classifies every path enforced with exactly one config-error message when tiers.patch is not an array of strings', async () => {
    await scaffold(tmpDir);
    writeFileSync(
      path.join(tmpDir, '.waypoint', 'config.yaml'),
      'check_command: npm test\ntiers:\n  patch: "not-an-array"\n'
    );

    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md']);

    expect(result.configError).not.toBeNull();
    expect(result.classifications).toEqual([
      { path: 'docs/readme.md', tier: 'enforced', reason: 'config-error' },
    ]);
  });

  it('also treats a completely missing tiers.patch key as a config error', async () => {
    await scaffold(tmpDir);
    writeFileSync(path.join(tmpDir, '.waypoint', 'config.yaml'), 'check_command: npm test\n');

    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md']);

    expect(result.configError).not.toBeNull();
    expect(result.classifications[0]?.tier).toBe('enforced');
    expect(result.classifications[0]?.reason).toBe('config-error');
  });
});

describe('classifyChangedFiles — deletion', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('classifies a removed path by globs only, with the frontmatter-override step skipped entirely', async () => {
    // Shaped like a spec-tier path (would be override-eligible if it
    // existed), but never created — simulates a deletion.
    const removedPath = 'specs/features/never-existed.md';
    expect(existsSync(path.join(tmpDir, removedPath))).toBe(false);

    const result = await classifyChangedFiles(tmpDir, [removedPath]);

    // specs/features/** is not a default patch glob, so the no-match
    // default applies. If the (nonexistent) file's content were somehow
    // consulted despite not existing, this would be the only way an
    // override could have flipped it to unenforced — proving the skip.
    expect(result.classifications).toEqual([
      { path: removedPath, tier: 'enforced', reason: 'no-glob-match-default' },
    ]);
  });

  it('classifies a removed patch-tier path as unenforced via glob alone', async () => {
    const removedPath = 'specs/patches/deleted-spec.md';
    expect(existsSync(path.join(tmpDir, removedPath))).toBe(false);

    const result = await classifyChangedFiles(tmpDir, [removedPath]);

    expect(result.classifications).toEqual([
      { path: removedPath, tier: 'unenforced', reason: 'patch-glob-match' },
    ]);
  });
});

describe('classifyChangedFiles — rename (new path)', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('classifies using the new path and its current content, applying the frontmatter override there', async () => {
    // Simulates a rename landing at a new features/ path whose content
    // (post-rename) carries a patch frontmatter tier — the override must
    // apply at the new location based on what's actually there now.
    const newPath = 'specs/features/renamed-in.md';
    const absPath = path.join(tmpDir, newPath);
    writeFileSync(
      absPath,
      '---\nid: patch-2026-08-21-renamed-in\ntier: patch\nstatus: draft\ncreated_at: 2026-08-21\n---\n\n# renamed-in\n'
    );

    const result = await classifyChangedFiles(tmpDir, [newPath]);

    expect(result.classifications).toEqual([
      { path: newPath, tier: 'unenforced', reason: 'frontmatter-override' },
    ]);
  });
});

describe('classifyChangedFiles — spec frontmatter override', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it("overrides an otherwise-enforced feature spec to unenforced when its frontmatter tier is 'patch'", async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const raw = readFileSync(created.path, 'utf8');
    const patched = raw.replace('tier: feature', 'tier: patch');
    writeFileSync(created.path, patched);

    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');
    const result = await classifyChangedFiles(tmpDir, [relPath]);

    expect(result.classifications).toEqual([
      { path: relPath, tier: 'unenforced', reason: 'frontmatter-override' },
    ]);
  });

  it("overrides an otherwise-unenforced patch spec to enforced when its frontmatter tier is 'feature'", async () => {
    const created = await createPatchSpec(tmpDir, 'fix-typo');
    const raw = readFileSync(created.path, 'utf8');
    const patched = raw.replace('tier: patch', 'tier: feature');
    writeFileSync(created.path, patched);

    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');
    const result = await classifyChangedFiles(tmpDir, [relPath]);

    // specs/patches/** matches the default patch glob, so without the
    // override this would be unenforced — the override must win.
    expect(result.classifications).toEqual([
      { path: relPath, tier: 'enforced', reason: 'frontmatter-override' },
    ]);
  });

  it("applies the override to a system spec-set's prd.md with frontmatter tier 'system'", async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');
    const relPath = path.relative(tmpDir, created.prdPath).split(path.sep).join('/');

    const result = await classifyChangedFiles(tmpDir, [relPath]);

    // tier: system on a path not matching any default patch glob -> still
    // enforced, but via the override path (not the plain no-match default).
    expect(result.classifications).toEqual([
      { path: relPath, tier: 'enforced', reason: 'frontmatter-override' },
    ]);
  });
});

describe("classifyChangedFiles — override doesn't extend to code", () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('never consults frontmatter-shaped content in an ordinary file outside the three spec-tier locations', async () => {
    const codePath = 'src/weird.ts';
    const absPath = path.join(tmpDir, codePath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, '---\ntier: patch\nid: not-a-real-spec\n---\n\nexport const x = 1;\n');

    const result = await classifyChangedFiles(tmpDir, [codePath]);

    // No default patch glob matches src/**, and the frontmatter-like content
    // must never be consulted since this path isn't under specs/.
    expect(result.classifications).toEqual([
      { path: codePath, tier: 'enforced', reason: 'no-glob-match-default' },
    ]);
  });
});

describe('classifyChangedFiles — Acceptance Criteria', () => {
  it('AC1: a valid config with zero tiers.patch patterns classifies every path enforced by the normal no-match default, not a config error', async () => {
    await scaffold(tmpDir);
    writeFileSync(
      path.join(tmpDir, '.waypoint', 'config.yaml'),
      'check_command: npm test\ntiers:\n  patch: []\n'
    );

    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md', 'src/index.ts']);

    expect(result.configError).toBeNull();
    expect(result.classifications).toEqual([
      { path: 'docs/readme.md', tier: 'enforced', reason: 'no-glob-match-default' },
      { path: 'src/index.ts', tier: 'enforced', reason: 'no-glob-match-default' },
    ]);
  });

  it('AC2: a batch of 10 changed paths with one config error reports the single config-error message exactly once, not 10 times', async () => {
    // Deliberately not scaffolded.
    const paths = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);

    const result = await classifyChangedFiles(tmpDir, paths);

    expect(result.configError).not.toBeNull();
    expect(typeof result.configError).toBe('string');
    expect(result.classifications).toHaveLength(10);
    for (const classification of result.classifications) {
      expect(classification.tier).toBe('enforced');
      expect(classification.reason).toBe('config-error');
    }
  });
});

describe('classifyChangedFiles — glob matcher semantics', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('matches *.md only at the top level, not nested under a directory', async () => {
    const result = await classifyChangedFiles(tmpDir, ['readme.md', 'src/nested/readme.md']);

    expect(result.classifications[0]).toMatchObject({ tier: 'unenforced' }); // *.md
    // src/nested/readme.md isn't covered by any other default glob, so this
    // one path alone proves *.md doesn't also match nested files.
    expect(result.classifications[1]).toEqual({
      path: 'src/nested/readme.md',
      tier: 'enforced',
      reason: 'no-glob-match-default',
    });
  });

  it('*.md does not match a nested path that no other default glob also covers', async () => {
    const result = await classifyChangedFiles(tmpDir, ['src/nested/readme.md']);

    expect(result.classifications).toEqual([
      { path: 'src/nested/readme.md', tier: 'enforced', reason: 'no-glob-match-default' },
    ]);
  });

  it('tasks/** matches the bare directory path itself (zero trailing segments)', async () => {
    const result = await classifyChangedFiles(tmpDir, ['tasks']);

    expect(result.classifications).toEqual([
      { path: 'tasks', tier: 'unenforced', reason: 'patch-glob-match' },
    ]);
  });

  it('tasks/** matches a deeply nested path', async () => {
    const result = await classifyChangedFiles(tmpDir, ['tasks/a/b/c.ledger.yaml']);

    expect(result.classifications[0]).toMatchObject({ tier: 'unenforced' });
  });

  it('a leading **/ glob matches both the bare suffix and a nested path (zero or more segments)', async () => {
    writeFileSync(
      path.join(tmpDir, '.waypoint', 'config.yaml'),
      'check_command: npm test\ntiers:\n  patch: ["**/gen.ts"]\n'
    );

    const result = await classifyChangedFiles(tmpDir, ['gen.ts', 'src/gen.ts', 'src/a/gen.ts']);

    expect(result.classifications).toEqual([
      { path: 'gen.ts', tier: 'unenforced', reason: 'patch-glob-match' },
      { path: 'src/gen.ts', tier: 'unenforced', reason: 'patch-glob-match' },
      { path: 'src/a/gen.ts', tier: 'unenforced', reason: 'patch-glob-match' },
    ]);
  });

  it('a mid-pattern **/ glob never fuses across the boundary slash it requires', async () => {
    writeFileSync(
      path.join(tmpDir, '.waypoint', 'config.yaml'),
      'check_command: npm test\ntiers:\n  patch: ["src/**/gen.ts"]\n'
    );

    const result = await classifyChangedFiles(tmpDir, [
      'srcgen.ts',
      'src/gen.ts',
      'src/a/gen.ts',
    ]);

    expect(result.classifications).toEqual([
      { path: 'srcgen.ts', tier: 'enforced', reason: 'no-glob-match-default' },
      { path: 'src/gen.ts', tier: 'unenforced', reason: 'patch-glob-match' },
      { path: 'src/a/gen.ts', tier: 'unenforced', reason: 'patch-glob-match' },
    ]);
  });
});

describe('classifyChangedFiles — additional config and frontmatter edge cases', () => {
  it('classifies every path enforced with exactly one config-error message when tiers.patch has a non-string entry mixed with valid ones', async () => {
    await scaffold(tmpDir);
    writeFileSync(
      path.join(tmpDir, '.waypoint', 'config.yaml'),
      'check_command: npm test\ntiers:\n  patch: ["docs/**", 42]\n'
    );

    const result = await classifyChangedFiles(tmpDir, ['docs/readme.md']);

    expect(result.configError).not.toBeNull();
    expect(result.classifications).toEqual([
      { path: 'docs/readme.md', tier: 'enforced', reason: 'config-error' },
    ]);
  });

  it('falls back to glob classification when an override-eligible spec has an unrecognized frontmatter tier value', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'weird-tier');
    const raw = readFileSync(created.path, 'utf8');
    const patched = raw.replace('tier: feature', 'tier: obsolete');
    writeFileSync(created.path, patched);

    const relPath = path.relative(tmpDir, created.path).split(path.sep).join('/');
    const result = await classifyChangedFiles(tmpDir, [relPath]);

    // specs/features/** isn't a default patch glob, so the no-match default
    // applies -- proving the invalid tier value was never treated as a win.
    expect(result.classifications).toEqual([
      { path: relPath, tier: 'enforced', reason: 'no-glob-match-default' },
    ]);
  });
});
