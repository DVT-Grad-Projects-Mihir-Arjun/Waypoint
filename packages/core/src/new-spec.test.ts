import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { scaffold } from './scaffold.js';

// Wraps `writeFile` in a passthrough mock (default behavior: call straight
// through to the real implementation) so individual tests below can
// temporarily intercept just one targeted call — e.g. to fail
// `architecture.md`'s write after `prd.md`'s own write has already
// genuinely succeeded — without affecting every other test in this file,
// which never overrides the default passthrough.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
import {
  createFeatureSpec,
  createPatchSpec,
  createSystemSpec,
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

  it('errors, naming the colliding path, when the name collides with an existing system-tier spec directory', async () => {
    // System tier's own output is a spec-set directory
    // (`specs/systems/<name>/`), not a `<name>.md` file — the cross-tier
    // collision check must still detect it.
    const systemDir = path.join(tmpDir, 'specs', 'systems', 'dup-name');
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(path.join(systemDir, 'prd.md'), 'existing system spec\n');

    let caught: unknown;
    try {
      await createPatchSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(systemDir);
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

  it('errors, naming the colliding path, when the name collides with an existing system-tier spec directory', async () => {
    // Same directory-shape rationale as createPatchSpec's equivalent test
    // above.
    const systemDir = path.join(tmpDir, 'specs', 'systems', 'dup-name');
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(path.join(systemDir, 'prd.md'), 'existing system spec\n');

    let caught: unknown;
    try {
      await createFeatureSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(systemDir);
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

describe('createSystemSpec — not installed', () => {
  it('rejects with WaypointNotInstalledError when .waypoint/config.yaml is missing, without writing anything', async () => {
    await expect(createSystemSpec(tmpDir, 'my-system')).rejects.toBeInstanceOf(
      WaypointNotInstalledError
    );

    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'tasks'))).toBe(false);
  });

  it('carries a message telling the user to run waypoint install first', async () => {
    await expect(createSystemSpec(tmpDir, 'my-system')).rejects.toThrow(/waypoint install/);
  });

  it('treats a directory at the config path the same as "not installed"', async () => {
    mkdirSync(path.join(tmpDir, '.waypoint', 'config.yaml'), { recursive: true });

    await expect(createSystemSpec(tmpDir, 'my-system')).rejects.toBeInstanceOf(
      WaypointNotInstalledError
    );
    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
  });
});

describe('createSystemSpec — happy path', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('writes specs/systems/<name>/{prd.md,architecture.md,adr.md} with system frontmatter and a matching two-phase pending-task ledger', async () => {
    const result = await createSystemSpec(tmpDir, 'billing-platform');

    const specDir = path.join(tmpDir, 'specs', 'systems', 'billing-platform');
    expect(result.specDir).toBe(specDir);
    expect(result.prdPath).toBe(path.join(specDir, 'prd.md'));
    expect(result.architecturePath).toBe(path.join(specDir, 'architecture.md'));
    expect(result.adrPath).toBe(path.join(specDir, 'adr.md'));
    expect(existsSync(result.prdPath)).toBe(true);
    expect(existsSync(result.architecturePath)).toBe(true);
    expect(existsSync(result.adrPath)).toBe(true);

    const rawPrd = readFileSync(result.prdPath, 'utf8');
    const frontmatterMatch = rawPrd.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = parse(frontmatterMatch![1]) as Record<string, unknown>;

    expect(frontmatter.tier).toBe('system');
    expect(frontmatter.status).toBe('draft');
    expect(frontmatter.approved_by).toBeNull();
    expect(frontmatter.approved_at).toBeNull();
    expect(typeof frontmatter.created_at).toBe('string');
    expect(frontmatter.id).toBe(result.id);
    expect(String(frontmatter.id)).toMatch(/^system-\d{4}-\d{2}-\d{2}-billing-platform$/);

    expect(rawPrd).toContain('## Requirements');
    expect(rawPrd).toContain('## Phase 1');
    expect(rawPrd).toContain('## Phase 2');
    // Exactly one placeholder task per phase, two total.
    expect(rawPrd.match(/^- \[ \] /gm)).toHaveLength(2);

    // architecture.md/adr.md are stubs with no frontmatter.
    const rawArchitecture = readFileSync(result.architecturePath, 'utf8');
    const rawAdr = readFileSync(result.adrPath, 'utf8');
    expect(rawArchitecture.startsWith('---')).toBe(false);
    expect(rawAdr.startsWith('---')).toBe(false);

    // Ledger filename is keyed by the spec's full `id`
    // (`system-<date>-billing-platform`), not the bare name.
    const ledgerPath = path.join(tmpDir, 'tasks', `${result.id}.ledger.yaml`);
    expect(result.ledgerPath).toBe(ledgerPath);
    expect(existsSync(ledgerPath)).toBe(true);

    const ledger = parse(readFileSync(ledgerPath, 'utf8')) as {
      spec_id: string;
      tasks: Array<Record<string, unknown>>;
    };
    expect(ledger.spec_id).toBe(frontmatter.id);
    expect(ledger.tasks).toHaveLength(2);
    expect(ledger.tasks[0]?.id).toBe('t1');
    expect(ledger.tasks[0]?.phase).toBe(1);
    expect(ledger.tasks[0]?.status).toBe('pending');
    expect(ledger.tasks[0]?.linked_commit).toBeNull();
    expect(ledger.tasks[0]?.verified_by_gate).toBe(false);
    expect(ledger.tasks[1]?.id).toBe('t2');
    expect(ledger.tasks[1]?.phase).toBe(2);
    expect(ledger.tasks[1]?.status).toBe('pending');
    expect(ledger.tasks[1]?.linked_commit).toBeNull();
    expect(ledger.tasks[1]?.verified_by_gate).toBe(false);
    // Distinct phase numbers, per the story's acceptance criteria.
    expect(ledger.tasks[0]?.phase).not.toBe(ledger.tasks[1]?.phase);
  });

  it('completes in well under the 30s NFR2 budget', async () => {
    const start = Date.now();
    await createSystemSpec(tmpDir, 'quick-system');
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe('createSystemSpec — spec-name collision', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('errors, naming the colliding path, without writing any of the four files, when the name collides with an existing patch spec', async () => {
    const patchPath = path.join(tmpDir, 'specs', 'patches', 'dup-name.md');
    writeFileSync(patchPath, 'existing patch spec\n');

    let caught: unknown;
    try {
      await createSystemSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(patchPath);
    expect(existsSync(path.join(tmpDir, 'specs', 'systems', 'dup-name'))).toBe(false);
    expect(readdirSync(path.join(tmpDir, 'tasks'))).toHaveLength(0);
  });

  it('errors, naming the colliding path, without writing any of the four files, when the name collides with an existing feature spec', async () => {
    const featurePath = path.join(tmpDir, 'specs', 'features', 'dup-name.md');
    writeFileSync(featurePath, 'existing feature spec\n');

    let caught: unknown;
    try {
      await createSystemSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(featurePath);
    expect(existsSync(path.join(tmpDir, 'specs', 'systems', 'dup-name'))).toBe(false);
  });

  it('errors without overwriting any file when a same-named system spec-set already exists', async () => {
    const firstResult = await createSystemSpec(tmpDir, 'dup-name');
    const originalPrd = readFileSync(firstResult.prdPath, 'utf8');
    const originalArchitecture = readFileSync(firstResult.architecturePath, 'utf8');
    const originalAdr = readFileSync(firstResult.adrPath, 'utf8');
    const originalLedger = readFileSync(firstResult.ledgerPath, 'utf8');

    await expect(createSystemSpec(tmpDir, 'dup-name')).rejects.toBeInstanceOf(
      SpecNameCollisionError
    );

    expect(readFileSync(firstResult.prdPath, 'utf8')).toBe(originalPrd);
    expect(readFileSync(firstResult.architecturePath, 'utf8')).toBe(originalArchitecture);
    expect(readFileSync(firstResult.adrPath, 'utf8')).toBe(originalAdr);
    expect(readFileSync(firstResult.ledgerPath, 'utf8')).toBe(originalLedger);
  });

  it('errors, naming the colliding directory, when the name collides with an existing bare (empty) system spec directory', async () => {
    // The systems-tier collision check is directory-or-file, keyed only on
    // the path existing — an empty directory (no prd.md written yet) must
    // still be treated as a collision.
    const systemDir = path.join(tmpDir, 'specs', 'systems', 'dup-name');
    mkdirSync(systemDir, { recursive: true });

    await expect(createSystemSpec(tmpDir, 'dup-name')).rejects.toBeInstanceOf(
      SpecNameCollisionError
    );
    expect(readdirSync(systemDir)).toHaveLength(0);
  });

  it('lets exactly one of two concurrent same-name calls win, the other erroring without a corrupted partial state', async () => {
    const [a, b] = await Promise.allSettled([
      createSystemSpec(tmpDir, 'race-name'),
      createSystemSpec(tmpDir, 'race-name'),
    ]);

    const results = [a, b];
    const fulfilled = results.filter(
      (r) => r.status === 'fulfilled'
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof createSystemSpec>>>[];
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SpecNameCollisionError);

    const winner = fulfilled[0]!.value;
    expect(existsSync(winner.prdPath)).toBe(true);
    expect(existsSync(winner.architecturePath)).toBe(true);
    expect(existsSync(winner.adrPath)).toBe(true);
    expect(existsSync(winner.ledgerPath)).toBe(true);
  });
});

// Mirrors new-spec.ts's own (unexported) `todayIsoDate()` — needed here to
// predict the ledger filename (`tasks/<id>.ledger.yaml`, `id` embeds today's
// date) before calling `createSystemSpec`, e.g. to pre-seed a collision.
function todayIsoDateForSystemTest(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('createSystemSpec — ledger-name collision', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('errors, naming the colliding ledger path, without writing the spec-set, when the spec-set path is free but the ledger file already exists', async () => {
    const id = `system-${todayIsoDateForSystemTest()}-dup-name`;
    const ledgerPath = path.join(tmpDir, 'tasks', `${id}.ledger.yaml`);
    writeFileSync(ledgerPath, 'spec_id: something-else\ntasks: []\n');

    let caught: unknown;
    try {
      await createSystemSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LedgerNameCollisionError);
    expect((caught as LedgerNameCollisionError).collidingPath).toBe(ledgerPath);
    expect((caught as LedgerNameCollisionError).message).toContain(ledgerPath);
    expect(existsSync(path.join(tmpDir, 'specs', 'systems', 'dup-name'))).toBe(false);
    // The pre-existing ledger content must survive untouched.
    expect(readFileSync(ledgerPath, 'utf8')).toBe('spec_id: something-else\ntasks: []\n');
  });
});

describe('createSystemSpec — mid-write failure rolls back the whole spec-set directory', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('rolls back prd.md and architecture.md when tasks/ is blocked by a pre-existing plain file (ledger step fails after all three spec-set files succeeded)', async () => {
    rmSync(path.join(tmpDir, 'tasks'), { recursive: true, force: true });
    writeFileSync(path.join(tmpDir, 'tasks'), 'not a directory\n');

    let caught: unknown;
    try {
      await createSystemSpec(tmpDir, 'blocked-tasks');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const specDir = path.join(tmpDir, 'specs', 'systems', 'blocked-tasks');
    expect(existsSync(specDir)).toBe(false);
  });

  it('rolls back prd.md and the whole spec-set directory when architecture.md fails to write after prd.md already succeeded', async () => {
    // Neither the collision check nor `mkdir(specDir, ...)` can be tripped
    // by pre-seeding a real file at `architecturePath` — any pre-existing
    // path at `specs/systems/<name>` is, by design, already caught by the
    // earlier cross-tier collision check, before `prd.md` is ever written.
    // Reaching "architecture.md's own write fails after prd.md already
    // succeeded" therefore requires intercepting the second write call
    // directly (via the module-level `vi.mock` above), forwarding every
    // other call through to the real implementation unchanged.
    const specDir = path.join(tmpDir, 'specs', 'systems', 'mid-write-arch-fail');
    const architecturePath = path.join(specDir, 'architecture.md');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const mockedWriteFile = vi.mocked(fsPromises.writeFile);

    mockedWriteFile.mockImplementation(async (file: unknown, ...rest: unknown[]) => {
      if (file === architecturePath) {
        const err = new Error(
          'EISDIR: illegal operation on a directory, write'
        ) as NodeJS.ErrnoException;
        err.code = 'EISDIR';
        throw err;
      }
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(file, ...rest);
    });

    let caught: unknown;
    try {
      await createSystemSpec(tmpDir, 'mid-write-arch-fail');
    } catch (err) {
      caught = err;
    } finally {
      mockedWriteFile.mockImplementation(actual.writeFile);
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe('EISDIR');
    // The whole directory — including the already-written prd.md — must be
    // rolled back, not just left as a partial spec-set.
    expect(existsSync(specDir)).toBe(false);
    expect(existsSync(path.join(specDir, 'prd.md'))).toBe(false);
  });

  it("rolls back the whole spec-set directory (not left as an orphaned empty directory) when prd.md's own write fails for a non-EEXIST reason", async () => {
    // Same rationale as the architecture.md test above: a pre-existing real
    // file/directory at `prdPath` would itself trip the earlier collision
    // check (since it lives under `specDir`), so the non-EEXIST failure on
    // `prd.md`'s own write has to be injected directly via the mock.
    const specDir = path.join(tmpDir, 'specs', 'systems', 'mid-write-prd-fail');
    const prdPath = path.join(specDir, 'prd.md');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const mockedWriteFile = vi.mocked(fsPromises.writeFile);

    mockedWriteFile.mockImplementation(async (file: unknown, ...rest: unknown[]) => {
      if (file === prdPath) {
        const err = new Error('EACCES: permission denied, open') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(file, ...rest);
    });

    let caught: unknown;
    try {
      await createSystemSpec(tmpDir, 'mid-write-prd-fail');
    } catch (err) {
      caught = err;
    } finally {
      mockedWriteFile.mockImplementation(actual.writeFile);
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
    // `mkdir(specDir, ...)` already succeeded before this write was
    // attempted — the empty directory it created must not survive as an
    // orphan (which would otherwise permanently collide on every retry).
    expect(existsSync(specDir)).toBe(false);
  });
});

describe('createSystemSpec — invalid name', () => {
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
    await expect(createSystemSpec(tmpDir, name)).rejects.toBeInstanceOf(InvalidSpecNameError);
    expect(existsSync(path.join(tmpDir, 'specs'))).toBe(false);
    expect(existsSync(path.join(tmpDir, '.waypoint'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'tasks'))).toBe(false);
  });

  it('accepts a name right at the 100-character length cap', async () => {
    await scaffold(tmpDir);
    const name = 'a'.repeat(100);
    const result = await createSystemSpec(tmpDir, name);
    expect(existsSync(result.prdPath)).toBe(true);
    expect(existsSync(result.ledgerPath)).toBe(true);
  });

  it('rejects a missing/undefined-like name the same way', async () => {
    // @ts-expect-error -- intentionally passing a non-string to exercise the runtime guard
    await expect(createSystemSpec(tmpDir, undefined)).rejects.toBeInstanceOf(
      InvalidSpecNameError
    );
  });
});

describe('specTierCollisionPath refactor — patch/feature own-tier collision regression', () => {
  // Confirms the shared helper introduced for system-tier support didn't
  // change patch/feature's own observable collision behavior for their own
  // tiers: still a `<name>.md` file path, not a directory.
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('createPatchSpec still reports its own-tier collision as the exact specs/patches/<name>.md file path', async () => {
    await createPatchSpec(tmpDir, 'dup-name');

    let caught: unknown;
    try {
      await createPatchSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(
      path.join(tmpDir, 'specs', 'patches', 'dup-name.md')
    );
  });

  it('createFeatureSpec still reports its own-tier collision as the exact specs/features/<name>.md file path', async () => {
    await createFeatureSpec(tmpDir, 'dup-name');

    let caught: unknown;
    try {
      await createFeatureSpec(tmpDir, 'dup-name');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNameCollisionError);
    expect((caught as SpecNameCollisionError).collidingPath).toBe(
      path.join(tmpDir, 'specs', 'features', 'dup-name.md')
    );
  });
});

describe('path-separator sensitivity (NFR5 cross-platform verification)', () => {
  // The happy-path tests above already assert `result.path`/`result.ledgerPath`
  // equal `path.join(...)`-built expectations, but only implicitly, as one
  // assertion among several. This test exists solely to name that pattern
  // explicitly as this story's path-separator-sensitivity check: on Windows,
  // a path built by naive string concatenation (`${cwd}/specs/...`) would
  // diverge from one built by `path.join` (which uses `\`), so asserting
  // exact `path.join(...)` equality — rather than e.g. a substring or
  // POSIX-style check — is what actually exercises path-separator handling
  // across `ubuntu-latest`/`macos-latest`/`windows-latest`.
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it("createPatchSpec's returned path equals a path.join(...)-built expectation exactly", async () => {
    const result = await createPatchSpec(tmpDir, 'separator-check');
    const expected = path.join(tmpDir, 'specs', 'patches', 'separator-check.md');
    expect(result.path).toBe(expected);
  });

  it("createFeatureSpec's returned path and ledgerPath equal path.join(...)-built expectations exactly", async () => {
    const result = await createFeatureSpec(tmpDir, 'separator-check');
    const expectedSpecPath = path.join(tmpDir, 'specs', 'features', 'separator-check.md');
    const expectedLedgerPath = path.join(tmpDir, 'tasks', `${result.id}.ledger.yaml`);
    expect(result.path).toBe(expectedSpecPath);
    expect(result.ledgerPath).toBe(expectedLedgerPath);
  });

  it("createSystemSpec's returned paths equal path.join(...)-built expectations exactly", async () => {
    const result = await createSystemSpec(tmpDir, 'separator-check');
    const expectedSpecDir = path.join(tmpDir, 'specs', 'systems', 'separator-check');
    expect(result.specDir).toBe(expectedSpecDir);
    expect(result.prdPath).toBe(path.join(expectedSpecDir, 'prd.md'));
    expect(result.architecturePath).toBe(path.join(expectedSpecDir, 'architecture.md'));
    expect(result.adrPath).toBe(path.join(expectedSpecDir, 'adr.md'));
    expect(result.ledgerPath).toBe(path.join(tmpDir, 'tasks', `${result.id}.ledger.yaml`));
  });
});
