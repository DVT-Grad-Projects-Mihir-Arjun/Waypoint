import { Command } from 'commander';
import { installCommand } from './commands/install.js';

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

  // Stubs only — registered for `--help` discoverability. Command logic
  // ships in Stories 1.2 (new-patch) and 1.3 (new-feature/new-system); out
  // of scope here.
  const STUB_COMMANDS: Array<{ use: string; tier: string }> = [
    { use: 'new-patch <name>', tier: 'Patch' },
    { use: 'new-feature <name>', tier: 'Feature' },
    { use: 'new-system <name>', tier: 'System' },
  ];

  for (const { use, tier } of STUB_COMMANDS) {
    program
      .command(use)
      .description(`Create a new ${tier}-tier spec (not yet implemented)`)
      .action(() => {
        console.error(`'${use.split(' ')[0]}' is not implemented yet.`);
        process.exitCode = 1;
      });
  }

  return program;
}
