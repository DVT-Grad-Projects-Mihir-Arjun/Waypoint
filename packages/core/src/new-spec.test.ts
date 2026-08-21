import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { scaffold } from './scaffold.js';
import {
  createPatchSpec,
  InvalidSpecNameError,
  SpecNameCollisionError,
  WaypointNotInstalledError,
} from './new-spec.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-new-spec-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createPatchSpec — not installed', () => {
  it('rejects with WaypointNotInstalledError when .waypoint/config.yaml is missing, without writing anything', async () => {
    await expect(createPatchSpec(tmpDir, 'my-change')).rejects.toBeInstanceOf(
      WaypointNotInstalledError
    );

    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
  });

  it('carries a message telling the user to run waypoint install first', async () => {
    await expect(createPatchSpec(tmpDir, 'my-change')).rejects.toThrow(/waypoint install/);
  });

  it('treats a directory at the config path the same as "not installed"', async () => {
    mkdirSync(path.join(tmpDir, '.waypoint', 'config.yaml'), { recursive: true });

    await expect(createPatchSpec(tmpDir, 'my-change')).rejects.toBeInstanceOf(
      WaypointNotInstalledError
    );
    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
  });
});

describe('createPatchSpec — happy path', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('writes specs/patches/<name>.md with patch frontmatter and no ledger/approval fields', async () => {
    const result = await createPatchSpec(tmpDir, 'fix-typo');

    const targetPath = path.join(tmpDir, 'specs', 'patches', 'fix-typo.md');
    expect(result.path).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);

    const raw = readFileSync(targetPath, 'utf8');
    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = parse(frontmatterMatch![1]) as Record<string, unknown>;

    expect(frontmatter.tier).toBe('patch');
    expect(frontmatter.status).toBe('draft');
    expect(typeof frontmatter.created_at).toBe('string');
    expect(frontmatter.id).toBe(result.id);
    expect(String(frontmatter.id)).toMatch(/^patch-\d{4}-\d{2}-\d{2}-fix-typo$/);

    // No approval fields, no ledger reference.
    expect(frontmatter).not.toHaveProperty('approved_by');
    expect(frontmatter).not.toHaveProperty('approved_at');
    expect(raw).not.toMatch(/ledger/i);
  });

  it('creates no task-ledger file anywhere under tasks/', async () => {
    await createPatchSpec(tmpDir, 'fix-typo');

    const tasksDir = path.join(tmpDir, 'tasks');
    expect(existsSync(tasksDir)).toBe(true);
    // tasks/ still exists from scaffold(), but nothing new-patch-related was
    // written into it.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(tasksDir)).toHaveLength(0);
  });

  it('completes in well under the 30s NFR2 budget', async () => {
    const start = Date.now();
    await createPatchSpec(tmpDir, 'quick-change');
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe('createPatchSpec — name collision', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('errors without overwriting when a same-named patch spec already exists', async () => {
    await createPatchSpec(tmpDir, 'dup-name');
    const targetPath = path.join(tmpDir, 'specs', 'patches', 'dup-name.md');
    const originalContent = readFileSync(targetPath, 'utf8');

    let caught: unknown;
    try {
      await createPatchSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).message).toContain(targetPath);
    expect(readFileSync(targetPath, 'utf8')).toBe(originalContent);
  });

  it('errors, naming the colliding path, when the name collides with an existing feature spec', async () => {
    const featurePath = path.join(tmpDir, 'specs', 'features', 'dup-name.md');
    writeFileSync(featurePath, 'existing feature spec\n');

    let caught: unknown;
    try {
      await createPatchSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(featurePath);
    expect((caught as SpecNameCollisionError).message).toContain(featurePath);
    expect(existsSync(path.join(tmpDir, 'specs', 'patches', 'dup-name.md'))).toBe(false);
  });

  it('errors, naming the colliding path, when the name collides with an existing system spec', async () => {
    const systemPath = path.join(tmpDir, 'specs', 'systems', 'dup-name.md');
    mkdirSync(path.dirname(systemPath), { recursive: true });
    writeFileSync(systemPath, 'existing system spec\n');

    await expect(createPatchSpec(tmpDir, 'dup-name')).rejects.toBeInstanceOf(
      SpecNameCollisionError
    );
    expect(existsSync(path.join(tmpDir, 'specs', 'patches', 'dup-name.md'))).toBe(false);
  });

  it('lets exactly one of two concurrent same-name calls win, the other erroring without clobbering the write (TOCTOU)', async () => {
    const [a, b] = await Promise.allSettled([
      createPatchSpec(tmpDir, 'race-name'),
      createPatchSpec(tmpDir, 'race-name'),
    ]);

    const results = [a, b];
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SpecNameCollisionError);

    // Exactly one well-formed file exists — no corruption from a lost write
    // racing an overwrite.
    const targetPath = path.join(tmpDir, 'specs', 'patches', 'race-name.md');
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toContain('tier: patch');
  });
});

describe('createPatchSpec — invalid name', () => {
  it.each([
    ['empty string', ''],
    ['contains forward slash', 'foo/bar'],
    ['contains backslash', 'foo\\bar'],
    ['path traversal', '../escape'],
    ['dotfile-style leading dot', '.hidden'],
    ['contains space', 'foo bar'],
    ['contains invalid punctuation', 'foo@bar'],
    ['exceeds the 100-character length cap', 'a'.repeat(101)],
  ])('rejects %s (%j) with InvalidSpecNameError before any filesystem check', async (_label, name) => {
    // Deliberately not installed (no scaffold()) — proves name validation
    // happens before the install check, per the story's Boundaries &
    // Constraints ordering.
    await expect(createPatchSpec(tmpDir, name)).rejects.toBeInstanceOf(InvalidSpecNameError);
    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
    expect(existsSync(path.join(tmpDir, '.waypoint'))).toBe(false);
  });

  it('accepts a name right at the 100-character length cap', async () => {
    await scaffold(tmpDir);
    const name = 'a'.repeat(100);
    const result = await createPatchSpec(tmpDir, name);
    expect(existsSync(result.path)).toBe(true);
  });

  it('rejects a missing/undefined-like name the same way', async () => {
    // @ts-expect-error -- intentionally passing a non-string to exercise the runtime guard
    await expect(createPatchSpec(tmpDir, undefined)).rejects.toBeInstanceOf(InvalidSpecNameError);
  });

  it('carries a message that explains the validation rule', async () => {
    await expect(createPatchSpec(tmpDir, 'foo bar')).rejects.toThrow(
      /letters, numbers, '_', and '-'/
    );
  });
});
