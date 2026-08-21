import { Command } from 'commander';
import { installCommand } from './commands/install.js';
import { newPatchCommand } from './commands/new-patch.js';
import { newFeatureCommand } from './commands/new-feature.js';
import { newSystemCommand } from './commands/new-system.js';
import { updateCommand } from './commands/update.js';

/**
 * Builds the `waypoint` CLI program. Factored out of `index.ts` so it can be
 * constructed and exercised directly in tests (e.g. invoking a stub
 * subcommand) without running the process entry point's top-level
 * `parseAsync(process.argv)`.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('waypoint')
    .description('Waypoint: right-sized spec ceremony for AI-assisted development')
    .version('0.1.0');

  program
    .command('install')
    .description(
      'Scaffold the Waypoint repo structure (specs/, tasks/, decisions/, roles/, AGENTS.md, .waypoint/config.yaml) in the current repository, and add .waypoint/.gate-state/ to .gitignore'
    )
    .action(async () => {
      await installCommand();
    });

  program
    .command('new-patch <name>')
    .description('Create a new Patch-tier spec (specs/patches/<name>.md, no approval step)')
    .action(async (name: string) => {
      await newPatchCommand(name);
    });

  program
    .command('new-feature <name>')
    .description(
      'Create a new Feature-tier spec (specs/features/<name>.md + tasks/<name>.ledger.yaml, one approval gate)'
    )
    .action(async (name: string) => {
      await newFeatureCommand(name);
    });

  program
    .command('new-system <name>')
    .description(
      'Create a new System-tier spec (specs/systems/<name>/{prd.md,architecture.md,adr.md} + tasks/<id>.ledger.yaml, phased approval)'
    )
    .action(async (name: string) => {
      await newSystemCommand(name);
    });

  program
    .command('update <spec-id>')
    .description(
      'Sync hand-filled ### ADDED bullets into the ledger, then append a fresh empty ## Delta — <date> block (Feature/System tier only)'
    )
    .action(async (specId: string) => {
      await updateCommand(specId);
    });

  return program;
}
