import {
  approveSpec,
  DuplicateSpecIdError,
  FrontmatterFieldNotFoundError,
  LedgerNotFoundError,
  NoPhaseTrackedTasksError,
  PatchTierApprovalNotSupportedError,
  SpecNotFoundError,
} from '@waypoint/core';
import type { ApproveResult } from '@waypoint/core';

/**
 * Thin command handler for `waypoint approve <spec-id>` — all mechanism
 * (locating the spec, the targeted byte-fidelity frontmatter edit, the
 * per-phase `phase_approvals` bookkeeping) lives in `@waypoint/core`'s
 * `approveSpec()`; this just wires it to the CLI and reports the result.
 * Mirrors `update.ts`/`verify.ts`'s try/catch -> clean exit-code pattern.
 *
 * Deliberately makes no claim anywhere in its own output about blocking
 * agent invocation — this command's "human-only" guarantee is a
 * documentation-layer convention (Epic 4 Story 4.1 excluding `approve` from
 * `AGENTS.md`), not a technical enforcement this command performs itself.
 *
 * Exit code: `0` for `approved`/`already-approved`; `1` for any thrown error
 * (spec not found, patch-tier spec-id, duplicate spec-id, missing/malformed
 * ledger, a ledger with no phase-tagged tasks, a hand-edited spec missing an
 * expected frontmatter field, or any other unexpected failure).
 */
export async function approveCommand(specId: string, cwd: string = process.cwd()): Promise<void> {
  let result: ApproveResult;
  try {
    result = await approveSpec(cwd, specId);
  } catch (err) {
    if (
      err instanceof SpecNotFoundError ||
      err instanceof PatchTierApprovalNotSupportedError ||
      err instanceof DuplicateSpecIdError ||
      err instanceof LedgerNotFoundError ||
      err instanceof NoPhaseTrackedTasksError ||
      err instanceof FrontmatterFieldNotFoundError
    ) {
      console.error(`waypoint approve: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
    return;
  }

  const identityNote = result.approvedBy ? ` by ${result.approvedBy}` : '';

  if (result.tier === 'feature') {
    if (result.outcome === 'already-approved') {
      console.log(`waypoint approve: '${result.id}' is already approved (no-op).`);
    } else {
      console.log(
        `waypoint approve: '${result.id}' approved${identityNote} (approved_at ${result.approvedAt}).`
      );
    }
    return;
  }

  // System tier.
  if (result.outcome === 'already-approved') {
    console.log(`waypoint approve: '${result.id}' -- every phase is already approved (no-op).`);
    return;
  }

  if (result.statusApproved) {
    console.log(
      `waypoint approve: '${result.id}' -- phase ${result.approvedPhase} approved${identityNote} ` +
        `(approved_at ${result.approvedAt}); that was the last remaining phase, so status is now 'approved'.`
    );
  } else {
    console.log(
      `waypoint approve: '${result.id}' -- phase ${result.approvedPhase} approved${identityNote} ` +
        `(approved_at ${result.approvedAt}); status remains 'draft' pending further phase(s).`
    );
  }
}
