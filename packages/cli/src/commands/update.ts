import path from 'node:path';
import {
  DuplicateSpecIdError,
  LedgerNotFoundError,
  LockAcquisitionError,
  PatchTierUpdateNotSupportedError,
  SpecNotFoundError,
  updateSpec,
} from '@waypoint/core';

/**
 * Thin command handler for `waypoint update <spec-id>` — all sync/scaffold
 * logic lives in `@waypoint/core`'s `updateSpec()`; this just wires it to
 * the CLI and reports the result. Mirrors `new-feature.ts`'s try/catch ->
 * clean exit-code pattern.
 *
 * `@waypoint/core`'s error messages are deliberately command-agnostic, so
 * this layer owns the `waypoint update:` framing.
 */
export async function updateCommand(specId: string, cwd: string = process.cwd()): Promise<void> {
  try {
    const result = await updateSpec(cwd, specId);
    const syncedNote =
      result.syncedTaskIds.length > 0
        ? ` (synced ${result.syncedTaskIds.length} new task${
            result.syncedTaskIds.length === 1 ? '' : 's'
          }: ${result.syncedTaskIds.join(', ')})`
        : '';
    const deltaNote = result.deltaHeadingReused
      ? `reused existing empty delta "${result.deltaHeading}" (nothing new to scaffold)`
      : `appended "${result.deltaHeading}"`;
    console.log(`Updated spec: ${path.relative(cwd, result.path)} -- ${deltaNote}${syncedNote}`);
  } catch (err) {
    if (
      err instanceof SpecNotFoundError ||
      err instanceof PatchTierUpdateNotSupportedError ||
      err instanceof DuplicateSpecIdError ||
      err instanceof LedgerNotFoundError ||
      err instanceof LockAcquisitionError
    ) {
      console.error(`waypoint update: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
