import { verifyTask } from '@waypoint/core';
import type { VerifyResult } from '@waypoint/core';

/**
 * Thin command handler for `waypoint verify <spec-id> <task-id>` — all
 * mechanism (running `check_command`, the atomic ledger write, the isolated
 * commit, the `.gate-state` integrity hash) lives in `@waypoint/core`'s
 * `verifyTask()`; this just wires it to the CLI and maps its outcome to a
 * message + exit code. Mirrors `update.ts`/`check-drift.ts`'s
 * try/catch -> clean exit-code pattern.
 *
 * Exit code: `0` for `verified`/`already-verified`; `1` for every other
 * outcome (`check-failed`, `commit-failed`, `not-found`, `no-head`,
 * `corrupted`) and for any unexpected thrown error.
 */
export async function verifyCommand(
  specId: string,
  taskId: string,
  cwd: string = process.cwd()
): Promise<void> {
  let result: VerifyResult;
  try {
    result = await verifyTask(cwd, specId, taskId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`waypoint verify: ${message}`);
    process.exitCode = 1;
    return;
  }

  switch (result.outcome) {
    case 'verified':
      console.log(
        `waypoint verify: '${result.taskId}' in '${result.specId}' verified (linked_commit ${result.linkedCommit}).`
      );
      if (result.hashWriteWarning) {
        // Non-fatal: the verification itself succeeded (check passed, commit
        // landed) -- exit code stays 0. This just surfaces that the
        // `.gate-state` integrity-hash write failed afterward.
        console.error(`waypoint verify: warning: ${result.hashWriteWarning}`);
      }
      return;

    case 'already-verified':
      console.log(
        `waypoint verify: '${result.taskId}' in '${result.specId}' is already verified (no-op).`
      );
      return;

    case 'check-failed':
      console.error(
        `waypoint verify: check failed for '${result.taskId}' in '${result.specId}': ${result.reason}`
      );
      process.exitCode = 1;
      return;

    case 'commit-failed':
      console.error(
        `waypoint verify: could not commit the ledger update for '${result.taskId}' in ` +
          `'${result.specId}' (rolled back): ${result.reason}`
      );
      process.exitCode = 1;
      return;

    case 'not-found':
      console.error(`waypoint verify: ${result.message}`);
      process.exitCode = 1;
      return;

    case 'no-head':
      console.error(`waypoint verify: ${result.message}`);
      process.exitCode = 1;
      return;

    case 'corrupted':
      console.error(
        `waypoint verify: CORRUPTED -- '${result.taskId}' in '${result.specId}' is marked done, ` +
          "but its stored integrity hash is missing or doesn't match its current ledger content. " +
          'Refusing to re-verify or overwrite; investigate manually.'
      );
      process.exitCode = 1;
      return;

    default: {
      // Exhaustiveness guard: if `VerifyResult['outcome']` ever gains a new
      // variant without a matching `case` above, this assignment fails to
      // compile instead of silently falling through with no output or
      // exit-code handling.
      const exhaustiveCheck: never = result;
      throw new Error(`waypoint verify: unhandled outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
