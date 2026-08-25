import path from 'node:path';
import { checkDrift } from '@waypoint/core';

/**
 * Thin command handler for `waypoint check-drift` (no arguments) — all
 * scanning/resolution logic lives in `@waypoint/core`'s `checkDrift()`; this
 * just wires it to the CLI and reports the result. Mirrors `update.ts`'s
 * try/catch -> clean exit-code pattern.
 *
 * Sets `process.exitCode = 1` iff any drift was found; otherwise prints
 * "nothing to check" or a clean summary and leaves the exit code untouched,
 * per this story's Boundaries & Constraints ("exit non-zero if any
 * reference... fails to resolve; exit zero otherwise, including when
 * there's nothing eligible to check").
 */
export async function checkDriftCommand(cwd: string = process.cwd()): Promise<void> {
  try {
    const result = await checkDrift(cwd);

    if (result.nothingToCheck) {
      console.log('waypoint check-drift: nothing to check.');
      return;
    }

    if (result.findings.length === 0) {
      console.log(
        `waypoint check-drift: no drift found (${result.referencesChecked} reference${
          result.referencesChecked === 1 ? '' : 's'
        } checked across ${result.specsScanned} spec${result.specsScanned === 1 ? '' : 's'}).`
      );
      return;
    }

    for (const finding of result.findings) {
      console.error(
        `waypoint check-drift: [${finding.specId}] stale ${finding.type} reference ` +
          `'${finding.reference}' in ${path.relative(cwd, finding.specPath)}`
      );
    }
    process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
