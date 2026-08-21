import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { scaffold } from './scaffold.js';
import {
  createFeatureSpec,
  createPatchSpec,
  InvalidSpecNameError,
  LedgerNameCollisionError,
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

describe('createFeatureSpec — not installed', () => {
  it('rejects with WaypointNotInstalledError when .waypoint/config.yaml is missing, without writing anything', async () => {
    await expect(createFeatureSpec(tmpDir, 'my-feature')).rejects.toBeInstanceOf(
      WaypointNotInstalledError
    );

    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'tasks'))).toBe(false);
  });

  it('carries a message telling the user to run waypoint install first', async () => {
    await expect(createFeatureSpec(tmpDir, 'my-feature')).rejects.toThrow(/waypoint install/);
  });

  it('treats a directory at the config path the same as "not installed"', async () => {
    mkdirSync(path.join(tmpDir, '.waypoint', 'config.yaml'), { recursive: true });

    await expect(createFeatureSpec(tmpDir, 'my-feature')).rejects.toBeInstanceOf(
      WaypointNotInstalledError
    );
    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
  });
});

describe('createFeatureSpec — happy path', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('writes specs/features/<name>.md with feature frontmatter and a matching pending-task ledger', async () => {
    const result = await createFeatureSpec(tmpDir, 'auth-refresh');

    const specPath = path.join(tmpDir, 'specs', 'features', 'auth-refresh.md');
    expect(result.path).toBe(specPath);
    expect(existsSync(specPath)).toBe(true);

    const rawSpec = readFileSync(specPath, 'utf8');
    const frontmatterMatch = rawSpec.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = parse(frontmatterMatch![1]) as Record<string, unknown>;

    expect(frontmatter.tier).toBe('feature');
    expect(frontmatter.status).toBe('draft');
    expect(frontmatter.approved_by).toBeNull();
    expect(frontmatter.approved_at).toBeNull();
    expect(typeof frontmatter.created_at).toBe('string');
    expect(frontmatter.id).toBe(result.id);
    expect(String(frontmatter.id)).toMatch(/^feat-\d{4}-\d{2}-\d{2}-auth-refresh$/);

    expect(rawSpec).toContain('## Requirements');
    expect(rawSpec).toContain('## Design');
    expect(rawSpec).toContain('## Task List');
    // Exactly one placeholder task in the body.
    expect(rawSpec.match(/^- \[ \] /gm)).toHaveLength(1);

    // Ledger filename is keyed by the spec's full `id`
    // (`feat-<date>-auth-refresh`), not the bare name.
    const ledgerPath = path.join(tmpDir, 'tasks', `${result.id}.ledger.yaml`);
    expect(result.ledgerPath).toBe(ledgerPath);
    expect(String(result.id)).toMatch(/^feat-\d{4}-\d{2}-\d{2}-auth-refresh$/);
    expect(existsSync(ledgerPath)).toBe(true);

    const ledger = parse(readFileSync(ledgerPath, 'utf8')) as {
      spec_id: string;
      tasks: Array<Record<string, unknown>>;
    };
    expect(ledger.spec_id).toBe(frontmatter.id);
    expect(ledger.tasks).toHaveLength(1);
    expect(ledger.tasks[0]?.id).toBe('t1');
    expect(ledger.tasks[0]?.status).toBe('pending');
    expect(ledger.tasks[0]?.linked_commit).toBeNull();
    expect(ledger.tasks[0]?.verified_by_gate).toBe(false);
  });

  it('completes in well under the 30s NFR2 budget', async () => {
    const start = Date.now();
    await createFeatureSpec(tmpDir, 'quick-feature');
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe('createFeatureSpec — spec-name collision', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('errors, naming the colliding path, without writing either new file, when the name collides with an existing patch spec', async () => {
    const patchPath = path.join(tmpDir, 'specs', 'patches', 'dup-name.md');
    writeFileSync(patchPath, 'existing patch spec\n');

    let caught: unknown;
    try {
      await createFeatureSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(patchPath);
    expect((caught as SpecNameCollisionError).message).toContain(patchPath);
    expect(existsSync(path.join(tmpDir, 'specs', 'features', 'dup-name.md'))).toBe(false);
    // Spec-collision is caught before `id` (and therefore the ledger path)
    // is ever computed, so nothing new was written under tasks/ at all.
    expect(readdirSync(path.join(tmpDir, 'tasks'))).toHaveLength(0);
  });

  it('errors without overwriting either file when a same-named feature spec already exists', async () => {
    const firstResult = await createFeatureSpec(tmpDir, 'dup-name');
    const specPath = firstResult.path;
    const ledgerPath = firstResult.ledgerPath;
    const originalSpec = readFileSync(specPath, 'utf8');
    const originalLedger = readFileSync(ledgerPath, 'utf8');

    await expect(createFeatureSpec(tmpDir, 'dup-name')).rejects.toBeInstanceOf(
      SpecNameCollisionError
    );
    expect(readFileSync(specPath, 'utf8')).toBe(originalSpec);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedger);
  });

  it('errors, naming the colliding path, when the name collides with an existing system spec', async () => {
    const systemPath = path.join(tmpDir, 'specs', 'systems', 'dup-name.md');
    mkdirSync(path.dirname(systemPath), { recursive: true });
    writeFileSync(systemPath, 'existing system spec\n');

    let caught: unknown;
    try {
      await createFeatureSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(systemPath);
    expect(existsSync(path.join(tmpDir, 'specs', 'features', 'dup-name.md'))).toBe(false);
    expect(readdirSync(path.join(tmpDir, 'tasks'))).toHaveLength(0);
  });

  it('lets exactly one of two concurrent same-name calls win, the other erroring without a corrupted partial state', async () => {
    const [a, b] = await Promise.allSettled([
      createFeatureSpec(tmpDir, 'race-name'),
      createFeatureSpec(tmpDir, 'race-name'),
    ]);

    const results = [a, b];
    const fulfilled = results.filter(
      (r) => r.status === 'fulfilled'
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof createFeatureSpec>>>[];
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SpecNameCollisionError);

    // Both concurrent calls share the same `name` and (barring a midnight
    // rollover mid-test) the same date, so they'd compute the same `id` —
    // use the winner's own reported paths rather than reconstructing them.
    const winner = fulfilled[0]!.value;
    expect(existsSync(winner.path)).toBe(true);
    expect(existsSync(winner.ledgerPath)).toBe(true);
  });
});

describe('createFeatureSpec — ledger-write failure rolls back the spec file', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('rolls back the just-written spec file when tasks/ is blocked by a pre-existing plain file (non-EEXIST-safe rollback)', async () => {
    // Force the ledger write's own mkdir/writeFile step to fail for a
    // reason other than a plain ledger-path collision: `tasks/` itself is
    // blocked by a plain file, so `mkdir(path.dirname(ledgerPath), {
    // recursive: true })` fails (ENOTDIR on Linux, EEXIST on macOS) *after*
    // the spec file has already been written successfully. Whichever OS
    // error code surfaces, the spec file must not survive as an orphan.
    rmSync(path.join(tmpDir, 'tasks'), { recursive: true, force: true });
    writeFileSync(path.join(tmpDir, 'tasks'), 'not a directory\n');

    let caught: unknown;
    try {
      await createFeatureSpec(tmpDir, 'blocked-tasks');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(existsSync(path.join(tmpDir, 'specs', 'features', 'blocked-tasks.md'))).toBe(false);
  });
});

// Mirrors new-spec.ts's own (unexported) `todayIsoDate()` — needed here to
// predict the ledger filename (`tasks/<id>.ledger.yaml`, `id` embeds today's
// date) before calling `createFeatureSpec`, e.g. to pre-seed a collision.
function todayIsoDateForTest(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('createFeatureSpec — ledger-name collision', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('errors, naming the colliding ledger path, without writing the spec, when the spec path is free but the ledger file already exists', async () => {
    const id = `feat-${todayIsoDateForTest()}-dup-name`;
    const ledgerPath = path.join(tmpDir, 'tasks', `${id}.ledger.yaml`);
    writeFileSync(ledgerPath, 'spec_id: something-else\ntasks: []\n');

    let caught: unknown;
    try {
      await createFeatureSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LedgerNameCollisionError);
    expect((caught as LedgerNameCollisionError).collidingPath).toBe(ledgerPath);
    expect((caught as LedgerNameCollisionError).message).toContain(ledgerPath);
    expect(existsSync(path.join(tmpDir, 'specs', 'features', 'dup-name.md'))).toBe(false);
    // The pre-existing ledger content must survive untouched.
    expect(readFileSync(ledgerPath, 'utf8')).toBe('spec_id: something-else\ntasks: []\n');
  });
});

describe('createFeatureSpec — invalid name', () => {
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
    await expect(createFeatureSpec(tmpDir, name)).rejects.toBeInstanceOf(InvalidSpecNameError);
    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
    expect(existsSync(path.join(tmpDir, '.waypoint'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'tasks'))).toBe(false);
  });

  it('accepts a name right at the 100-character length cap', async () => {
    await scaffold(tmpDir);
    const name = 'a'.repeat(100);
    const result = await createFeatureSpec(tmpDir, name);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(result.ledgerPath)).toBe(true);
  });

  it('rejects a missing/undefined-like name the same way', async () => {
    // @ts-expect-error -- intentionally passing a non-string to exercise the runtime guard
    await expect(createFeatureSpec(tmpDir, undefined)).rejects.toBeInstanceOf(
      InvalidSpecNameError
    );
  });
});
