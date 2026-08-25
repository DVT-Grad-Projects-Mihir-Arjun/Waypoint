import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  approveSpec,
  FrontmatterFieldNotFoundError,
  NoPhaseTrackedTasksError,
  PatchTierApprovalNotSupportedError,
} from './approve.js';
import { createFeatureSpec, createSystemSpec } from './new-spec.js';
import { scaffold } from './scaffold.js';
import { DuplicateSpecIdError, LedgerNotFoundError, SpecNotFoundError } from './update-spec.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-approve-'));
  await scaffold(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(cwd: string): void {
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
}

function readFrontmatter(specPath: string): Record<string, unknown> {
  const raw = readFileSync(specPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  expect(match).not.toBeNull();
  return parse(match![1]!) as Record<string, unknown>;
}

// -- I/O matrix row: "Feature spec, draft" -----------------------------------

describe('approveSpec — Feature tier, draft', () => {
  it('sets status: approved, stamps approved_at, and leaves the rest of the file byte-identical', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const originalRaw = readFileSync(created.path, 'utf8');
    const originalFrontmatterMatch = originalRaw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
    const originalFrontmatterBlock = originalFrontmatterMatch![1]!;
    const originalBody = originalRaw.slice(originalFrontmatterBlock.length);

    const result = await approveSpec(tmpDir, created.id);

    expect(result.outcome).toBe('approved');
    expect(result.tier).toBe('feature');
    expect(result.statusApproved).toBe(true);
    expect(result.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const frontmatter = readFrontmatter(created.path);
    expect(frontmatter.status).toBe('approved');
    expect(String(frontmatter.approved_at)).toBe(result.approvedAt);

    // Everything outside the touched fields (the body, in particular) is
    // byte-identical -- verified by diffing the full file content, not just
    // the changed fields in isolation.
    const afterRaw = readFileSync(created.path, 'utf8');
    const afterFrontmatterMatch = afterRaw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
    const afterBody = afterRaw.slice(afterFrontmatterMatch![1]!.length);
    expect(afterBody).toBe(originalBody);

    // Every untouched frontmatter line is unchanged too.
    expect(afterRaw).toContain(`id: ${created.id}`);
    expect(afterRaw).toContain('tier: feature');
  });

  it('records approved_by when git identity is resolvable, or leaves it null otherwise', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const result = await approveSpec(tmpDir, created.id);

    const frontmatter = readFrontmatter(created.path);
    // Either a resolved identity or explicit null -- never undefined/missing.
    expect(frontmatter).toHaveProperty('approved_by');
    expect(result.approvedBy === null || typeof result.approvedBy === 'string').toBe(true);
    expect(frontmatter.approved_by === null || typeof frontmatter.approved_by === 'string').toBe(true);
  });

  it('round-trips a git identity containing special characters (colon, quote, apostrophe) exactly, via correct YAML escaping', async () => {
    // A controlled, deterministic identity -- a real repo with a specific
    // `user.name` set, same fixture pattern `verify.test.ts`/`gate.test.ts`
    // already use for their own git-identity-dependent tests. Proves
    // `yamlScalar` JSON-quotes the value (rather than interpolating it raw)
    // by asserting the *exact* string round-trips, not just its type.
    initGitRepo(tmpDir);
    const specialIdentity = `O'Brien: Test`;
    git(['config', 'user.name', specialIdentity], tmpDir);

    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const result = await approveSpec(tmpDir, created.id);

    expect(result.approvedBy).toBe(specialIdentity);

    const frontmatter = readFrontmatter(created.path);
    expect(frontmatter.approved_by).toBe(specialIdentity);
  });
});

// -- I/O matrix row: "Unknown spec-id" ---------------------------------------

describe('approveSpec — unknown spec-id', () => {
  it('rejects with SpecNotFoundError naming the missing id, without writing anything', async () => {
    let caught: unknown;
    try {
      await approveSpec(tmpDir, 'feat-2026-01-01-does-not-exist');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNotFoundError);
    expect((caught as SpecNotFoundError).specId).toBe('feat-2026-01-01-does-not-exist');
    expect((caught as Error).message).toContain('feat-2026-01-01-does-not-exist');
  });
});

// -- I/O matrix row: "Patch-tier spec" ---------------------------------------

describe('approveSpec — patch-tier spec', () => {
  it('rejects with PatchTierApprovalNotSupportedError, no write', async () => {
    const patchPath = path.join(tmpDir, 'specs', 'patches', 'trivial-fix.md');
    const patchId = 'patch-2026-08-21-trivial-fix';
    writeFileSync(
      patchPath,
      `---\nid: ${patchId}\ntier: patch\nstatus: draft\ncreated_at: 2026-08-21\n---\n\n# trivial-fix\n\n## Summary\n\nA trivial patch.\n`
    );
    const originalContent = readFileSync(patchPath, 'utf8');

    let caught: unknown;
    try {
      await approveSpec(tmpDir, patchId);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PatchTierApprovalNotSupportedError);
    expect((caught as PatchTierApprovalNotSupportedError).specId).toBe(patchId);
    expect((caught as Error).message).not.toContain("isn't supported by 'update'");
    expect(readFileSync(patchPath, 'utf8')).toBe(originalContent);
  });
});

// -- I/O matrix row: "Feature spec, already approved" ------------------------

describe('approveSpec — Feature tier, already approved', () => {
  it('no-ops and reports already-approved, without writing anything', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const first = await approveSpec(tmpDir, created.id);
    expect(first.outcome).toBe('approved');

    const rawAfterFirst = readFileSync(created.path, 'utf8');

    const second = await approveSpec(tmpDir, created.id);

    expect(second.outcome).toBe('already-approved');
    expect(second.tier).toBe('feature');
    expect(second.statusApproved).toBe(true);
    expect(second.approvedAt).toBe(first.approvedAt);
    expect(second.approvedBy).toBe(first.approvedBy);
    expect(second.approvedPhase).toBeNull();

    expect(readFileSync(created.path, 'utf8')).toBe(rawAfterFirst);
  });
});

// -- I/O matrix row: "System spec, first phase boundary" ---------------------

describe('approveSpec — System tier, first phase boundary', () => {
  it('records phase 1 as its own entry; status stays draft', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    const result = await approveSpec(tmpDir, created.id);

    expect(result.tier).toBe('system');
    expect(result.outcome).toBe('approved');
    expect(result.approvedPhase).toBe(1);
    expect(result.statusApproved).toBe(false);

    const frontmatter = readFrontmatter(created.prdPath);
    expect(frontmatter.status).toBe('draft');
    expect(frontmatter.approved_by).toBeNull();
    expect(frontmatter.approved_at).toBeNull();

    const approvals = frontmatter.phase_approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.phase).toBe(1);
    expect(String(approvals[0]!.approved_at)).toBe(result.approvedAt);
  });

  it('leaves the rest of the file byte-identical outside the frontmatter fields it writes', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');
    const originalRaw = readFileSync(created.prdPath, 'utf8');
    const originalBody = originalRaw.slice(originalRaw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)![0].length);

    await approveSpec(tmpDir, created.id);

    const afterRaw = readFileSync(created.prdPath, 'utf8');
    const afterBody = afterRaw.slice(afterRaw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)![0].length);
    expect(afterBody).toBe(originalBody);
    expect(afterRaw).toContain(`id: ${created.id}`);
    expect(afterRaw).toContain('created_at:');
  });
});

// -- I/O matrix row: "System spec, final phase boundary" ---------------------

describe('approveSpec — System tier, final phase boundary', () => {
  it('records phase 2 and flips status to approved in the same write', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    const first = await approveSpec(tmpDir, created.id);
    expect(first.approvedPhase).toBe(1);
    expect(first.statusApproved).toBe(false);

    const second = await approveSpec(tmpDir, created.id);

    expect(second.outcome).toBe('approved');
    expect(second.approvedPhase).toBe(2);
    expect(second.statusApproved).toBe(true);

    const frontmatter = readFrontmatter(created.prdPath);
    expect(frontmatter.status).toBe('approved');
    expect(String(frontmatter.approved_at)).toBe(second.approvedAt);
    expect(frontmatter.approved_by === null || typeof frontmatter.approved_by === 'string').toBe(true);

    const approvals = frontmatter.phase_approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(2);
    expect(approvals.map((a) => a.phase).sort()).toEqual([1, 2]);
  });

  it('round-trips a git identity containing special characters exactly in a phase_approvals entry, via correct YAML escaping', async () => {
    initGitRepo(tmpDir);
    const specialIdentity = `O'Brien: Test`;
    git(['config', 'user.name', specialIdentity], tmpDir);

    const created = await createSystemSpec(tmpDir, 'billing-platform');
    const result = await approveSpec(tmpDir, created.id);

    expect(result.approvedBy).toBe(specialIdentity);

    const frontmatter = readFrontmatter(created.prdPath);
    const approvals = frontmatter.phase_approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.approved_by).toBe(specialIdentity);
  });
});

// -- Backward compatibility: pre-3.4 scaffold with no phase_approvals line --

describe('approveSpec — System tier, phase_approvals line inserted fresh (pre-3.4 scaffold)', () => {
  it('inserts a new phase_approvals line before the closing fence when the field is entirely absent, leaving everything else byte-identical', async () => {
    const id = 'system-2026-08-21-legacy-billing';
    const specDir = path.join(tmpDir, 'specs', 'systems', 'legacy-billing');
    mkdirSync(specDir, { recursive: true });
    const prdPath = path.join(specDir, 'prd.md');

    // A hand-crafted fixture mirroring a spec scaffolded before this story
    // shipped: status/approved_by/approved_at/created_at are all present,
    // but there is no `phase_approvals:` line at all.
    const originalRaw =
      `---\nid: ${id}\ntier: system\nstatus: draft\napproved_by: null\napproved_at: null\ncreated_at: 2026-08-21\n---\n\n` +
      `# legacy-billing\n\n## Requirements\n\n<!-- Describe what this system must do. -->\n\n` +
      `## Phase 1\n\n- [ ] t1: placeholder\n\n## Phase 2\n\n- [ ] t2: placeholder\n`;
    writeFileSync(prdPath, originalRaw, 'utf8');

    mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'tasks', `${id}.ledger.yaml`),
      stringify({
        spec_id: id,
        tasks: [
          { id: 't1', phase: 1, description: 'placeholder', status: 'pending', linked_commit: null, verified_by_gate: false },
          { id: 't2', phase: 2, description: 'placeholder', status: 'pending', linked_commit: null, verified_by_gate: false },
        ],
      }),
      'utf8'
    );

    const result = await approveSpec(tmpDir, id);

    expect(result.outcome).toBe('approved');
    expect(result.approvedPhase).toBe(1);
    expect(result.statusApproved).toBe(false);

    const afterRaw = readFileSync(prdPath, 'utf8');
    expect(afterRaw).toContain('phase_approvals:');

    // Every line present in the original fixture is still there, byte for
    // byte, once the newly-inserted `phase_approvals` line is stripped back
    // out -- the insert added exactly one line and changed nothing else.
    const withoutInsertedLine = afterRaw.replace(/\nphase_approvals:.*\n/, '\n');
    expect(withoutInsertedLine).toBe(originalRaw);

    const frontmatter = readFrontmatter(prdPath);
    expect(frontmatter.status).toBe('draft');
    const approvals = frontmatter.phase_approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.phase).toBe(1);
  });
});

// -- I/O matrix row: "System spec, all phases already approved" -------------

describe('approveSpec — System tier, all phases already approved', () => {
  it('no-ops and reports already-approved once every phase has an entry', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    await approveSpec(tmpDir, created.id);
    await approveSpec(tmpDir, created.id);

    const rawAfterBoth = readFileSync(created.prdPath, 'utf8');

    const third = await approveSpec(tmpDir, created.id);

    expect(third.outcome).toBe('already-approved');
    expect(third.approvedPhase).toBeNull();
    expect(third.statusApproved).toBe(true);

    expect(readFileSync(created.prdPath, 'utf8')).toBe(rawAfterBoth);
  });
});

// -- Cross-cutting: missing/malformed ledger for System tier -----------------

describe('approveSpec — System tier, missing ledger', () => {
  it('throws LedgerNotFoundError, no write, when the ledger file is missing', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');
    rmSync(created.ledgerPath, { force: true });
    const originalPrd = readFileSync(created.prdPath, 'utf8');

    let caught: unknown;
    try {
      await approveSpec(tmpDir, created.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LedgerNotFoundError);
    expect(readFileSync(created.prdPath, 'utf8')).toBe(originalPrd);
  });
});

// -- Cross-cutting: an empty/corrupted ledger is not "already approved" ----

describe('approveSpec — System tier, ledger has no phase-tagged tasks', () => {
  it('throws NoPhaseTrackedTasksError (not an already-approved no-op) when no ledger task carries a numeric phase field', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');
    // Overwrite the ledger with tasks that carry no `phase` field at all --
    // an empty/corrupted ledger, distinct from "every phase already approved".
    writeFileSync(
      created.ledgerPath,
      stringify({
        spec_id: created.id,
        tasks: [
          {
            id: 't1',
            description: 'no phase field at all',
            status: 'pending',
            linked_commit: null,
            verified_by_gate: false,
          },
        ],
      })
    );
    const originalPrd = readFileSync(created.prdPath, 'utf8');

    let caught: unknown;
    try {
      await approveSpec(tmpDir, created.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NoPhaseTrackedTasksError);
    expect((caught as NoPhaseTrackedTasksError).specId).toBe(created.id);
    expect((caught as Error).message).toContain(created.id);
    // Never confusable with the genuine already-approved no-op.
    expect((caught as Error).message).not.toContain('already');
    expect(readFileSync(created.prdPath, 'utf8')).toBe(originalPrd);
  });
});

// -- Cross-cutting: re-approving after status is already 'approved' --------

describe('approveSpec — System tier, a new phase appears after status is already approved', () => {
  it('records the new phase entry and reports statusApproved without re-touching status/approved_by/approved_at', async () => {
    const created = await createSystemSpec(tmpDir, 'billing-platform');

    // Fully approve both existing phases first (status flips to 'approved').
    const first = await approveSpec(tmpDir, created.id);
    expect(first.approvedPhase).toBe(1);
    const second = await approveSpec(tmpDir, created.id);
    expect(second.approvedPhase).toBe(2);
    expect(second.statusApproved).toBe(true);

    const rawAfterApproval = readFileSync(created.prdPath, 'utf8');
    const frontmatterAfterApproval = readFrontmatter(created.prdPath);
    expect(frontmatterAfterApproval.status).toBe('approved');

    // Simulate a hand-edited ledger that introduces a third, not-yet-approved
    // phase after the spec's top-level `status` is already 'approved' -- the
    // `status: draft` line no longer exists, so a naive re-flip would throw.
    writeFileSync(
      created.ledgerPath,
      stringify({
        spec_id: created.id,
        tasks: [
          { id: 't1', phase: 1, description: 'p1', status: 'done', linked_commit: null, verified_by_gate: true },
          { id: 't2', phase: 2, description: 'p2', status: 'done', linked_commit: null, verified_by_gate: true },
          { id: 't3', phase: 3, description: 'p3', status: 'pending', linked_commit: null, verified_by_gate: false },
        ],
      })
    );

    const third = await approveSpec(tmpDir, created.id);

    expect(third.outcome).toBe('approved');
    expect(third.approvedPhase).toBe(3);
    expect(third.statusApproved).toBe(true);

    const frontmatter = readFrontmatter(created.prdPath);
    expect(frontmatter.status).toBe('approved');
    // The already-approved top-level fields are untouched -- same values as
    // before this call, byte-for-byte on those specific lines.
    expect(String(frontmatter.approved_at)).toBe(String(frontmatterAfterApproval.approved_at));
    expect(frontmatter.approved_by).toBe(frontmatterAfterApproval.approved_by);

    const approvals = frontmatter.phase_approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(3);
    expect(approvals.map((a) => a.phase).sort()).toEqual([1, 2, 3]);

    // Only the `phase_approvals` line changed relative to the post-approval
    // snapshot -- every other frontmatter line (status/approved_by/approved_at
    // included) is byte-identical.
    const afterRaw = readFileSync(created.prdPath, 'utf8');
    const stripPhaseApprovalsLine = (s: string): string => s.replace(/^phase_approvals:.*$/m, '<stripped>');
    expect(stripPhaseApprovalsLine(afterRaw)).toBe(stripPhaseApprovalsLine(rawAfterApproval));
  });
});

// -- Cross-cutting: corrupted spec-id shape is treated as not found ---------
// (System tier only -- System tier builds a `tasks/<id>.ledger.yaml` path
// directly from the id, so a corrupted/adversarial id must never escape
// `tasks/`. Feature tier never builds a filesystem path from the id, so the
// same guard must NOT reject a legitimately-located Feature spec whose id
// simply doesn't match the usual shape -- see the next describe block.)

describe('approveSpec — System tier, corrupted spec-id shape is treated as not found', () => {
  it('rejects with SpecNotFoundError when the matched frontmatter id does not have the <tier>-<date>-<name> shape', async () => {
    const weirdDir = path.join(tmpDir, 'specs', 'systems', 'weird-id');
    mkdirSync(weirdDir, { recursive: true });
    const weirdId = '../escape-attempt';
    writeFileSync(
      path.join(weirdDir, 'prd.md'),
      `---\nid: ${weirdId}\ntier: system\nstatus: draft\napproved_by: null\napproved_at: null\ncreated_at: 2026-08-21\nphase_approvals: []\n---\n\n# weird-id\n\n## Phase 1\n\n- [ ] t1: placeholder\n`
    );

    let caught: unknown;
    try {
      await approveSpec(tmpDir, weirdId);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SpecNotFoundError);
    expect((caught as SpecNotFoundError).specId).toBe(weirdId);
  });
});

// -- Cross-cutting: Feature tier never applies the id-shape guard -----------

describe('approveSpec — Feature tier, a non-standard-shaped id is still approved', () => {
  it('approves a legitimately-located Feature spec whose id does not match the <tier>-<date>-<name> shape, since Feature tier never builds a filesystem path from it', async () => {
    const weirdPath = path.join(tmpDir, 'specs', 'features', 'weird-id.md');
    const weirdId = 'hand-edited-id-without-the-usual-shape';
    writeFileSync(
      weirdPath,
      `---\nid: ${weirdId}\ntier: feature\nstatus: draft\napproved_by: null\napproved_at: null\ncreated_at: 2026-08-21\n---\n\n# weird-id\n\n## Task List\n\n- [ ] t1: placeholder\n`
    );

    const result = await approveSpec(tmpDir, weirdId);

    expect(result.outcome).toBe('approved');
    expect(result.id).toBe(weirdId);

    const frontmatter = readFrontmatter(weirdPath);
    expect(frontmatter.status).toBe('approved');
  });
});

// -- Cross-cutting: duplicate spec-id propagates DuplicateSpecIdError -------

describe('approveSpec — duplicate spec-id', () => {
  it('propagates DuplicateSpecIdError from findSpecById, no write', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const dupePath = path.join(tmpDir, 'specs', 'features', 'auth-refresh-dupe.md');
    writeFileSync(dupePath, readFileSync(created.path, 'utf8'));

    let caught: unknown;
    try {
      await approveSpec(tmpDir, created.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DuplicateSpecIdError);
  });
});

// -- Cross-cutting: hand-deleted frontmatter field errors clearly ------------

describe('approveSpec — hand-deleted frontmatter field', () => {
  it('errors naming the spec and the missing field, without writing, when status: draft is gone', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    let raw = readFileSync(created.path, 'utf8');
    raw = raw.replace('status: draft', 'status: something-else');
    writeFileSync(created.path, raw, 'utf8');
    const originalRaw = readFileSync(created.path, 'utf8');

    let caught: unknown;
    try {
      await approveSpec(tmpDir, created.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FrontmatterFieldNotFoundError);
    expect((caught as FrontmatterFieldNotFoundError).specId).toBe(created.id);
    expect((caught as Error).message).toContain(created.id);
    expect((caught as Error).message).toContain('status: draft');
    expect(readFileSync(created.path, 'utf8')).toBe(originalRaw);
  });
});

// -- AC: approve's own output never overclaims a technical agent block ------

describe('approveSpec — no overclaimed enforcement in its own output', () => {
  it('does not throw or report anything about blocking direct/agent invocation', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    const result = await approveSpec(tmpDir, created.id);
    // Nothing on the result shape claims an enforcement mechanism -- this is
    // a documentation-only convention (Epic 4), not something this module
    // itself checks or blocks.
    expect(Object.keys(result)).not.toContain('agentBlocked');
    expect(Object.keys(result)).not.toContain('enforced');
  });
});
