import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { approveSpec } from './approve.js';
import { createSystemSpec } from './new-spec.js';
import { scaffold } from './scaffold.js';
import { computeStatus } from './status.js';
import { updateSpec } from './update-spec.js';
import { verifyTask } from './verify.js';

/**
 * Finding 13 of the epic-1-5 MVP retrospective: no test anywhere in this
 * codebase chained multiple write-path commands (`updateSpec`, `approveSpec`,
 * `verifyTask`) together against the same spec -- every module's own test
 * file hand-crafts the artifact an upstream module would have produced
 * instead of calling the real producer function. That gap is exactly what
 * let Finding 7 (`updateSpec`'s System-tier sync pass hardcoding every
 * newly-synced task to `phase: 1`, bypassing `waypoint approve`'s
 * human-only approval gate for a task added after a spec is already fully
 * approved) ship undetected for a whole session: `update-spec.test.ts` never
 * imported `approveSpec`, and `approve.test.ts` never imported `updateSpec`.
 *
 * This file closes that gap with at least one real, chained,
 * `new-system -> approve -> update -> approve -> verify -> status` walk
 * through a real scratch git repo, calling every module's real exported
 * function end to end rather than hand-writing any of the intermediate
 * ledger/frontmatter state a real command would have produced.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-integration-'));
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

// This suite is about proving the write-path commands agree with each other
// end to end, not about re-proving the real installed pre-commit/
// pre-merge-commit hooks work (that's covered by scaffold.test.ts's own
// Finding 1 regression test and packages/cli/src/gate.test.ts) -- so the
// hooks are removed right after `scaffold()`, same rationale
// `packages/cli/src/gate.test.ts`'s `removeGateHooks` and
// `verify.test.ts`'s file-header comment both give for avoiding a real
// `npx`/built-CLI shell-out that's irrelevant to what this suite verifies.
function removeGateHooksAndOverrideCheckCommand(cwd: string): void {
  rmSync(path.join(cwd, '.git', 'hooks', 'pre-commit'), { force: true });
  rmSync(path.join(cwd, '.git', 'hooks', 'pre-merge-commit'), { force: true });

  // check_command defaults to `npm test`, which this scratch repo has no
  // package.json for -- override to something trivially successful so this
  // suite isolates the command-chaining question `verifyTask` needs,
  // exactly as verify.test.ts's own real-hook test does.
  const configPath = path.join(cwd, '.waypoint', 'config.yaml');
  const configContent = readFileSync(configPath, 'utf8');
  // Guard the replace below: if the config template's exact wording ever
  // changes, fail loudly right here instead of the replace silently
  // no-op'ing and `verifyTask`'s real `check_command` shell-out failing
  // later against `npm test` (with no package.json in this scratch repo)
  // for a confusing, unrelated reason.
  expect(configContent).toContain('check_command: npm test');
  writeFileSync(
    configPath,
    configContent.replace('check_command: npm test', 'check_command: "true"')
  );
}

interface ParsedLedger {
  spec_id: string;
  tasks: Array<{ id: string; phase?: number }>;
}

describe('full write-path chain — new-system -> approve -> update -> approve -> verify -> status', () => {
  it('agrees with itself end to end: a task synced after full approval genuinely requires (and, once verified, genuinely completes) its own fresh approval, and waypoint status tracks every state change accurately', async () => {
    initGitRepo(tmpDir);
    const scaffoldResult = await scaffold(tmpDir);
    expect(scaffoldResult.warnings).toEqual([]);
    removeGateHooksAndOverrideCheckCommand(tmpDir);

    // A real commit establishes HEAD -- verifyTask requires at least one
    // commit to exist before it will do anything.
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'scaffold'], tmpDir);

    // --- new-system: create a real System-tier spec (2 phases, t1/t2) ---
    const created = await createSystemSpec(tmpDir, 'billing-platform');
    const readLedger = (): ParsedLedger => parse(readFileSync(created.ledgerPath, 'utf8')) as ParsedLedger;

    // --- approve: fully approve both of the spec's original phases ---
    const approvedPhase1 = await approveSpec(tmpDir, created.id);
    expect(approvedPhase1.outcome).toBe('approved');
    expect(approvedPhase1.approvedPhase).toBe(1);
    const approvedPhase2 = await approveSpec(tmpDir, created.id);
    expect(approvedPhase2.outcome).toBe('approved');
    expect(approvedPhase2.approvedPhase).toBe(2);
    expect(approvedPhase2.statusApproved).toBe(true);

    // --- verify: complete both original tasks through the real check_command/commit path ---
    const verifiedT1 = await verifyTask(tmpDir, created.id, 't1');
    expect(verifiedT1.outcome).toBe('verified');
    const verifiedT2 = await verifyTask(tmpDir, created.id, 't2');
    expect(verifiedT2.outcome).toBe('verified');

    // --- status: as of right now, every known task is done and the spec is
    // approved -- the closing criterion (approved && every task done) is
    // met, so the spec is correctly reported CLOSED (excluded from open
    // entries).
    const statusBeforeSync = await computeStatus(tmpDir);
    expect(statusBeforeSync.entries.find((e) => e.id === created.id)).toBeUndefined();

    // --- update: sync a brand-new requirement into the now-fully-approved spec ---
    const scaffolded = await updateSpec(tmpDir, created.id);
    expect(scaffolded.syncedTaskIds).toHaveLength(0);

    let prdRaw = readFileSync(created.prdPath, 'utf8');
    prdRaw = prdRaw.replace(
      `${scaffolded.deltaHeading}\n\n### ADDED\n`,
      `${scaffolded.deltaHeading}\n\n### ADDED\n- Add a refund webhook\n`
    );
    writeFileSync(created.prdPath, prdRaw, 'utf8');

    const synced = await updateSpec(tmpDir, created.id);
    expect(synced.syncedTaskIds).toHaveLength(1);
    const newTaskId = synced.syncedTaskIds[0]!;

    const ledgerAfterSync = readLedger();
    const newRow = ledgerAfterSync.tasks.find((t) => t.id === newTaskId);
    expect(newRow).toBeDefined();
    // Fix #2's load-bearing property, exercised here as a genuine chained
    // command sequence (not `update-spec.test.ts`'s isolated unit test):
    // the newly-synced task must land one phase past every phase already in
    // the ledger (phase 3), never the old hardcoded phase 1, which would
    // have silently reused an already-approved phase number.
    expect(newRow!.phase).toBe(3);

    // --- status: the newly-synced task is `pending` -- even though the
    // spec's own frontmatter `status` has been 'approved' since phase 2, the
    // spec must be reported OPEN again now that a real, not-yet-done task
    // exists. This is the "spec should still be listed as open until the
    // newly-added task's own phase is genuinely approved and verified"
    // property Finding 7's fix exists to protect.
    const statusAfterSync = await computeStatus(tmpDir);
    const openEntry = statusAfterSync.entries.find((e) => e.id === created.id);
    expect(openEntry).toBeDefined();
    expect(openEntry!.approved).toBe(true);
    expect(openEntry!.tasks).not.toBe('ledger-error');
    expect(openEntry!.tasks).not.toBe('not-applicable');
    const taskStates = openEntry!.tasks as Array<{ id: string; state: string }>;
    expect(taskStates.find((t) => t.id === newTaskId)?.state).toBe('pending');

    // --- approve: the fix's central assertion, now exercised as a real
    // chained command rather than a single-module unit test -- this must
    // NOT report `already-approved`. Before the fix, the hardcoded
    // `phase: 1` above would have made this a silent no-op, since phase 1
    // already had a `phase_approvals` entry from `approvedPhase1` above.
    const approvedPhase3 = await approveSpec(tmpDir, created.id);
    expect(approvedPhase3.outcome).toBe('approved');
    expect(approvedPhase3.approvedPhase).toBe(3);

    // --- verify: complete the newly-synced task too ---
    const verifiedNewTask = await verifyTask(tmpDir, created.id, newTaskId);
    expect(verifiedNewTask.outcome).toBe('verified');

    // --- status: everything approved, everything done -- correctly closed again. ---
    const statusFinal = await computeStatus(tmpDir);
    expect(statusFinal.entries.find((e) => e.id === created.id)).toBeUndefined();
  }, 20000);
});
