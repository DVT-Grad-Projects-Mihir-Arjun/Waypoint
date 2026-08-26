import { scaffold, ScaffoldConflictError } from '@waypoint/core';

/**
 * Thin command handler for `waypoint install` — all scaffolding logic lives
 * in `@waypoint/core`'s `scaffold()`; this just wires it to the CLI and
 * reports the result.
 */
export async function installCommand(cwd: string = process.cwd()): Promise<void> {
  try {
    const result = await scaffold(cwd);

    if (result.status === 'skipped-lock-contention') {
      console.log("Another 'waypoint install' is already running in this repo; nothing to do.");
      return;
    }

    console.log('Waypoint scaffold is ready.');
    for (const p of result.createdPaths) {
      console.log(`  created  ${p}`);
    }
    for (const p of result.upgradedPaths) {
      console.log(`  upgraded ${p} (was an old placeholder from an earlier install)`);
    }
    for (const p of result.preservedPaths) {
      console.log(`  kept     ${p}`);
    }
    for (const warning of result.warnings) {
      console.log(`  warning  ${warning}`);
    }
  } catch (err) {
    if (err instanceof ScaffoldConflictError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
