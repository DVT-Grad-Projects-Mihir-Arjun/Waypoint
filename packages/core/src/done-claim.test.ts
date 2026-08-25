import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { checkDoneClaims } from './done-claim.js';
import { gate } from './gate.js';
import { scaffold } from './scaffold.js';

/**
 * `checkDoneClaims` is inherently git-native (its sole check is `git
 * merge-base --is-ancestor`) -- like `verify.test.ts`/`gate.test.ts`'s own
 * fixtures, every test here builds a real git repo with real commits rather
 * than mocking git.
 */

let tmpDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(cwd: string): void {
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
}

function commitAll(cwd: string, message: string): void {
  git(['add', '-A'], cwd);
  git(['commit', '-m', message, '--allow-empty'], cwd);
}

function headSha(cwd: string): string {
  return git(['rev-parse', 'HEAD'], cwd).trim();
}

interface FixtureTask {
  id: string;
  status: 'pending' | 'in-progress' | 'done';
  linked_commit?: string | null;
}

function writeLedger(cwd: string, relPath: string, tasks: Array<Record<string, unknown>>): void {
  const abs = path.join(cwd, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, stringify({ tasks }));
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-done-claim-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('checkDoneClaims — no tasks/ directory at all', () => {
  it('passes trivially with no error on a fresh/uninstalled repo', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    const result = await checkDoneClaims(tmpDir);

    expect(result).toEqual({ ok: true, violations: [] });
  });
});

describe('checkDoneClaims — valid done-claims', () => {
  it('passes when every done task\'s linked_commit resolves and is an ancestor of HEAD', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');
    const initialSha = headSha(tmpDir);
    commitAll(tmpDir, 'second');

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: initialSha, verified_by_gate: true },
      { id: 't2', description: 'a task', status: 'pending', linked_commit: null, verified_by_gate: false },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('never treats a non-done task\'s bogus linked_commit as a violation', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'pending', linked_commit: 'totally-bogus' },
      { id: 't2', description: 'a task', status: 'in-progress', linked_commit: null },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result).toEqual({ ok: true, violations: [] });
  });
});

describe('checkDoneClaims — fabricated or unrelated linked_commit', () => {
  it('fails, naming the ledger and task, when linked_commit does not resolve to any real object', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    const fabricated = 'deadbeef'.repeat(5); // 40 hex chars, never a real object in this repo
    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: fabricated },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ledgerFile: 'tasks/feat-demo.ledger.yaml',
      taskId: 't1',
    });
    expect(result.violations[0]!.reason).toContain('t1');
    expect(result.violations[0]!.reason).toContain(fabricated);
  });

  it('fails, naming the ledger and task, when linked_commit resolves but is not an ancestor of HEAD', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    // A real commit object that exists in this repo's object store but has
    // no parent link into HEAD's own history — resolves fine, but is not an
    // ancestor of HEAD.
    const treeSha = git(['rev-parse', 'HEAD^{tree}'], tmpDir).trim();
    const unrelatedSha = git(['commit-tree', treeSha, '-m', 'unrelated'], tmpDir).trim();

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: unrelatedSha },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ledgerFile: 'tasks/feat-demo.ledger.yaml',
      taskId: 't1',
    });
  });
});

describe('checkDoneClaims — blank/missing linked_commit', () => {
  it('fails identically to the fabricated-commit case when linked_commit is null', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: null },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ledgerFile: 'tasks/feat-demo.ledger.yaml',
      taskId: 't1',
    });
    expect(result.violations[0]!.reason).toContain('blank or missing linked_commit');
  });

  it('fails identically when linked_commit is entirely absent from the task', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done' },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.reason).toContain('blank or missing linked_commit');
  });

  it('fails identically when linked_commit is a blank string', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: '   ' },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations[0]!.reason).toContain('blank or missing linked_commit');
  });
});

describe('checkDoneClaims — git-flag-shaped linked_commit (argument-injection guard)', () => {
  it('rejects a linked_commit shaped like a git flag as a violation, never passing it through to git as a flag', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    const maliciousValue = '--upload-pack=/tmp/x';
    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: maliciousValue },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ledgerFile: 'tasks/feat-demo.ledger.yaml',
      taskId: 't1',
    });
    expect(result.violations[0]!.reason).toContain('not a valid commit hash');
    expect(result.violations[0]!.reason).toContain(maliciousValue);
  });
});

describe('checkDoneClaims — missing/invalid task id', () => {
  it('reports a dedicated violation for a done task with a missing id, instead of coercing it to the string "undefined"', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { description: 'a task with no id', status: 'done', linked_commit: 'deadbeef'.repeat(5) },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.taskId).toBeUndefined();
    expect(result.violations[0]!.reason).toContain('missing or invalid id');
    expect(result.violations[0]!.reason).not.toContain('undefined');
  });

  it('reports a dedicated violation for a done task whose id is a non-string value', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 42, description: 'a task with a numeric id', status: 'done', linked_commit: 'deadbeef'.repeat(5) },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.taskId).toBeUndefined();
    expect(result.violations[0]!.reason).toContain('missing or invalid id');
  });
});

describe('checkDoneClaims — malformed ledger', () => {
  it('fails naming the specific unparseable ledger file, while a sibling valid ledger is still checked and passes', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');
    const initialSha = headSha(tmpDir);

    const malformedAbs = path.join(tmpDir, 'tasks', 'feat-broken.ledger.yaml');
    mkdirSync(path.dirname(malformedAbs), { recursive: true });
    writeFileSync(malformedAbs, 'tasks: [unterminated\n');

    writeLedger(tmpDir, 'tasks/feat-good.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: initialSha },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.ledgerFile).toBe('tasks/feat-broken.ledger.yaml');
    expect(result.violations[0]!.taskId).toBeUndefined();
    expect(result.violations[0]!.reason).toContain('failed to parse');
  });

  it('fails naming a ledger that parses as YAML but lacks a top-level tasks array', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    const abs = path.join(tmpDir, 'tasks', 'feat-no-tasks.ledger.yaml');
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, stringify({ spec_id: 'feat-no-tasks' }));

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.ledgerFile).toBe('tasks/feat-no-tasks.ledger.yaml');
    expect(result.violations[0]!.reason).toContain("'tasks' array");
  });

  it('checks every other ledger even when multiple ledgers are malformed', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');
    const initialSha = headSha(tmpDir);

    const brokenOneAbs = path.join(tmpDir, 'tasks', 'feat-broken-one.ledger.yaml');
    const brokenTwoAbs = path.join(tmpDir, 'tasks', 'feat-broken-two.ledger.yaml');
    mkdirSync(path.dirname(brokenOneAbs), { recursive: true });
    writeFileSync(brokenOneAbs, ': not: valid: yaml: [[[');
    writeFileSync(brokenTwoAbs, ': not: valid: yaml: [[[');

    writeLedger(tmpDir, 'tasks/feat-good.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: initialSha },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    const ledgerFiles = result.violations.map((v) => v.ledgerFile).sort();
    expect(ledgerFiles).toEqual(['tasks/feat-broken-one.ledger.yaml', 'tasks/feat-broken-two.ledger.yaml']);
  });
});

describe('checkDoneClaims — flat tasks/ layout only (nested support removed)', () => {
  it('never descends into a subdirectory of tasks/ — a ledger nested one level down is not found', async () => {
    // `collectLedgerFiles` used to recurse into subdirectories, but no other
    // ledger consumer (`update-spec.ts`, `approve.ts`, `status.ts`) or any
    // real scaffolding code ever produces or expects a nested layout — that
    // was speculative generality with no current producer (epic-1-5 MVP
    // retrospective, Finding 17). This test locks in the corrected, flat-only
    // scan: a nested ledger is silently invisible to this check, exactly as
    // it already is to every other command.
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');
    const initialSha = headSha(tmpDir);

    writeLedger(tmpDir, 'tasks/nested/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: initialSha },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('finds a ledger placed directly under tasks/ but not one nested a level deeper, in the same run', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');

    const fabricated = 'deadbeef'.repeat(5); // 40 hex chars, never a real object in this repo
    writeLedger(tmpDir, 'tasks/feat-flat.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: fabricated },
    ]);
    writeLedger(tmpDir, 'tasks/nested/feat-nested.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: fabricated },
    ]);

    const result = await checkDoneClaims(tmpDir);

    // Only the flat ledger's violation is reported -- the nested one is
    // never walked into at all.
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.ledgerFile).toBe('tasks/feat-flat.ledger.yaml');
  });
});

describe('checkDoneClaims — shallow checkout hint', () => {
  it('appends exactly one hint entry when the checkout is shallow and an ancestor-check violation was found', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'first');
    commitAll(tmpDir, 'second');
    commitAll(tmpDir, 'third');

    const treeSha = git(['rev-parse', 'HEAD^{tree}'], tmpDir).trim();
    const unrelatedSha = git(['commit-tree', treeSha, '-m', 'unrelated'], tmpDir).trim();
    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: unrelatedSha },
    ]);
    commitAll(tmpDir, 'add ledger');

    const shallowDir = mkdtempSync(path.join(tmpdir(), 'waypoint-done-claim-shallow-'));
    try {
      git(['clone', '--depth', '1', `file://${tmpDir}`, shallowDir], tmpDir);
      expect(git(['rev-parse', '--is-shallow-repository'], shallowDir).trim()).toBe('true');

      const result = await checkDoneClaims(shallowDir);

      expect(result.ok).toBe(false);
      const hintEntries = result.violations.filter((v) => v.ledgerFile === undefined);
      expect(hintEntries).toHaveLength(1);
      expect(hintEntries[0]!.reason).toContain('shallow');
    } finally {
      rmSync(shallowDir, { recursive: true, force: true });
    }
  });

  it('never appends the shallow hint when the checkout is shallow but every done-claim is clean', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');
    const initialSha = headSha(tmpDir);
    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: initialSha },
    ]);
    commitAll(tmpDir, 'add ledger');

    const shallowDir = mkdtempSync(path.join(tmpdir(), 'waypoint-done-claim-shallow-clean-'));
    try {
      // Depth 2 (not 1): the referenced linked_commit is the repo's *first*
      // commit, one behind the "add ledger" tip -- a depth-1 clone would
      // truncate it away, incorrectly making even this valid claim fail the
      // ancestor check. Depth 2 keeps the checkout genuinely shallow
      // (`--is-shallow-repository` is still true) while keeping the
      // referenced commit present, isolating "clean claims never get the
      // hint" from "an old claim can genuinely fail under a too-shallow
      // clone" (covered by the test above).
      git(['clone', '--depth', '2', `file://${tmpDir}`, shallowDir], tmpDir);
      expect(git(['rev-parse', '--is-shallow-repository'], shallowDir).trim()).toBe('true');

      const result = await checkDoneClaims(shallowDir);

      expect(result).toEqual({ ok: true, violations: [] });
    } finally {
      rmSync(shallowDir, { recursive: true, force: true });
    }
  });
});

describe('checkDoneClaims — Acceptance Criteria: perf budget for the combined --ci checks', () => {
  it(
    'completes gate()\'s full-diff check plus checkDoneClaims combined, at CI scale, well under the 60s budget',
    async () => {
      await scaffold(tmpDir);
      initGitRepo(tmpDir);

      // 2,000 decoy tracked files, all patch-tier (docs/**) so gate()'s
      // full-diff check passes cleanly without needing a spec delta —
      // this test measures speed at scale, not delta-enforcement logic
      // (already covered by gate.test.ts's own perf test and this file's
      // correctness tests above).
      const docsDir = path.join(tmpDir, 'docs', 'decoy');
      mkdirSync(docsDir, { recursive: true });
      const changedFiles: string[] = [];
      for (let i = 0; i < 2000; i++) {
        const relPath = `docs/decoy/file-${i}.md`;
        writeFileSync(path.join(tmpDir, relPath), `# decoy ${i}\n`);
        changedFiles.push(relPath);
      }

      // 50 ledgers, a realistic mix of done (with a real ancestor
      // linked_commit) and pending tasks.
      commitAll(tmpDir, 'init');
      const baseSha = headSha(tmpDir);
      for (let i = 0; i < 50; i++) {
        const tasks: Array<Record<string, unknown>> = [];
        for (let j = 0; j < 5; j++) {
          tasks.push(
            j % 2 === 0
              ? { id: `t${i}-${j}`, description: 'a task', status: 'done', linked_commit: baseSha, verified_by_gate: true }
              : { id: `t${i}-${j}`, description: 'a task', status: 'pending', linked_commit: null, verified_by_gate: false }
          );
        }
        writeLedger(tmpDir, `tasks/feat-${i}.ledger.yaml`, tasks);
      }
      commitAll(tmpDir, 'add ledgers');

      // Only the calls under test are timed — the 2,050-file fixture setup
      // and the two commits above (which can themselves take longer than
      // vitest's 5s default on a slower CI filesystem) are excluded, mirroring
      // gate.test.ts's own `start`/`elapsedMs` perf-test pattern.
      const start = performance.now();
      const gateResult = await gate({ mode: 'full-diff', changedFiles, repoRoot: tmpDir });
      const doneClaimResult = await checkDoneClaims(tmpDir);
      const elapsedMs = performance.now() - start;

      expect(gateResult.ok).toBe(true);
      expect(doneClaimResult.ok).toBe(true);
      expect(elapsedMs).toBeLessThan(60_000);
    },
    90_000
  );
});

// -- Fix 9(b) regression (epic-1-5 MVP retrospective, Batch 2) --------------
//
// `COMMIT_HASH_PATTERN` was tightened this batch from `/^[0-9a-f]{4,40}$/i`
// (any abbreviated hash from 4 characters up) to `/^[0-9a-f]{40}$/i` (exactly
// a full 40-character hex SHA, the only shape `waypoint verify` ever
// actually writes). This proves the boundary: a full 40-character hash is
// still accepted, and a 39-character hash -- previously accepted -- is now
// correctly rejected.

describe('checkDoneClaims — COMMIT_HASH_PATTERN boundary (tightened from {4,40} to exactly 40)', () => {
  it('accepts a full 40-character hex linked_commit that is a real ancestor of HEAD', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');
    const sha = headSha(tmpDir);
    expect(sha).toHaveLength(40);

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: sha, verified_by_gate: true },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('rejects a 39-character (abbreviated) linked_commit that the previous, looser {4,40} pattern used to accept', async () => {
    initGitRepo(tmpDir);
    commitAll(tmpDir, 'init');
    const sha = headSha(tmpDir);
    const abbreviated = sha.slice(0, 39);
    expect(abbreviated).toHaveLength(39);

    writeLedger(tmpDir, 'tasks/feat-demo.ledger.yaml', [
      { id: 't1', description: 'a task', status: 'done', linked_commit: abbreviated, verified_by_gate: true },
    ]);

    const result = await checkDoneClaims(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ledgerFile: 'tasks/feat-demo.ledger.yaml',
      taskId: 't1',
    });
    expect(result.violations[0]!.reason).toContain('not a valid commit hash');
    expect(result.violations[0]!.reason).toContain(abbreviated);
  });
});
