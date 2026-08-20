import path from 'node:path';
import {
  createPatchSpec,
  InvalidSpecNameError,
  SpecNameCollisionError,
  WaypointNotInstalledError,
} from '@waypoint/core';

/**
 * Thin command handler for `waypoint new-patch <name>` — all validation and
 * write logic lives in `@waypoint/core`'s `createPatchSpec()`; this just
 * wires it to the CLI and reports the result. Mirrors `install.ts`'s
 * try/catch -> clean exit-code pattern.
 *
 * `@waypoint/core`'s error messages are deliberately command-agnostic (they
 * may be reused by Story 1.3's `new-feature`/`new-system`), so this layer
 * owns the `waypoint new-patch:` framing.
 */
export async function newPatchCommand(name: string, cwd: string = process.cwd()): Promise<void> {
  try {
    const result = await createPatchSpec(cwd, name);
    console.log(`Created patch spec: ${path.relative(cwd, result.path)}`);
  } catch (err) {
    if (
      err instanceof WaypointNotInstalledError ||
      err instanceof InvalidSpecNameError ||
      err instanceof SpecNameCollisionError
    ) {
      console.error(`waypoint new-patch: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
