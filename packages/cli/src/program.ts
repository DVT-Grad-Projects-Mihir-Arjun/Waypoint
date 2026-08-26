import { Command } from 'commander';
import { installCommand } from './commands/install.js';
import { newPatchCommand } from './commands/new-patch.js';
import { newFeatureCommand } from './commands/new-feature.js';
import { newSystemCommand } from './commands/new-system.js';
import { updateCommand } from './commands/update.js';
import { checkDriftCommand } from './commands/check-drift.js';
import { gateCommand } from './commands/gate.js';
import { verifyCommand } from './commands/verify.js';
import { approveCommand } from './commands/approve.js';
import { statusCommand } from './commands/status.js';

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
    .version('1.0.0');

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

  program
    .command('check-drift')
    .description(
      'Scan every approved/in-progress spec for backtick-delimited path/symbol references that no longer resolve; exits non-zero if any are found'
    )
    .action(async () => {
      await checkDriftCommand();
    });

  program
    .command('gate')
    .description(
      'Block a commit that changes Feature/System-tier code with no accompanying spec delta staged in the same batch (installed as a pre-commit/pre-merge-commit hook by waypoint install). ' +
        'With --ci --base <ref>, instead re-runs the spec-delta check over the full PR diff against <ref> and checks every tasks/**/*.ledger.yaml for a fabricated/unresolvable done-claim -- the mode a CI pipeline runs (npx waypoint gate --ci --base <ref>). ' +
        'Only the spec-delta half is scoped to that diff -- the done-claim half is always a full, repo-wide sweep of every tasks/**/*.ledger.yaml file, independent of --base.'
    )
    .option('--ci', 'Run in CI mode: full-diff spec-delta check plus done-claim correctness, instead of the staged-files pre-commit check. Requires --base <ref>. Note: the done-claim half scans the entire tasks/ tree regardless of --base -- it is not scoped to the diff the way the spec-delta half is.')
    .option('--base <ref>', 'The base ref to diff the full PR against (e.g. the target branch) -- required together with --ci; never defaulted or auto-detected from a CI-provider env var.')
    .action(async (options: { ci?: boolean; base?: string }) => {
      await gateCommand(process.cwd(), options);
    });

  program
    .command('verify <spec-id> <task-id>')
    .description(
      'Run check_command and, only on success, atomically write linked_commit/status/verified_by_gate for one ledger task and commit only the ledger file (the sole write path for ledger completion fields)'
    )
    .action(async (specId: string, taskId: string) => {
      await verifyCommand(specId, taskId);
    });

  program
    .command('approve <spec-id>')
    .description(
      "Human-run approval gate (FR8): Feature tier sets status: approved once; System tier " +
        'records each phase boundary distinctly, flipping status: approved only once every ' +
        'ledger phase has been approved. Not intended for agent invocation -- a documentation-' +
        'layer convention (Epic 4), not a technical block enforced by this command'
    )
    .action(async (specId: string) => {
      await approveCommand(specId);
    });

  program
    .command('status')
    .description(
      'Read-only report of every open spec across all three tiers, with approval/task-completion state and tier counts; a fully approved-and-done Feature/System spec is left off the list'
    )
    .action(async () => {
      await statusCommand();
    });

  return program;
}
