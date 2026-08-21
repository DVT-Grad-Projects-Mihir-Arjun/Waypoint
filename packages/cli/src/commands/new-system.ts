import path from 'node:path';
import {
  createSystemSpec,
  InvalidSpecNameError,
  LedgerNameCollisionError,
  SpecNameCollisionError,
  WaypointNotInstalledError,
} from '@waypoint/core';

/**
 * Thin command handler for `waypoint new-system <name>` — all validation
 * and write logic lives in `@waypoint/core`'s `createSystemSpec()`; this
 * just wires it to the CLI and reports the result. Mirrors
 * `new-feature.ts`'s try/catch -> clean exit-code pattern.
 *
 * `@waypoint/core`'s error messages are deliberately command-agnostic, so
 * this layer owns the `waypoint new-system:` framing.
 */
export async function newSystemCommand(
  name: string,
  cwd: string = process.cwd()
): Promise<void> {
  try {
    const result = await createSystemSpec(cwd, name);
    const relPrd = path.relative(cwd, result.prdPath);
    const relArchitecture = path.relative(cwd, result.architecturePath);
    const relAdr = path.relative(cwd, result.adrPath);
    const relLedger = path.relative(cwd, result.ledgerPath);
    console.log(
      `Created system spec: ${relPrd}, ${relArchitecture}, ${relAdr} ` +
        `(ledger: ${relLedger})`
    );
  } catch (err) {
    if (
      err instanceof WaypointNotInstalledError ||
      err instanceof InvalidSpecNameError ||
      err instanceof SpecNameCollisionError ||
      err instanceof LedgerNameCollisionError
    ) {
      console.error(`waypoint new-system: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
