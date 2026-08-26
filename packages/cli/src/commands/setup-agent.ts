import { AGENT_TARGETS, setupAgentCommands, WaypointNotInstalledForSetupError } from '@waypoint/core';
import type { AgentTarget } from '@waypoint/core';

/**
 * Thin command handler for `waypoint setup-agent <agent>` — all
 * file-generation logic lives in `@waypoint/core`'s `setupAgentCommands()`;
 * this just validates the `<agent>` argument (including the `all`
 * shorthand), wires to the CLI, and reports the result. Mirrors
 * `install.ts`'s created/preserved reporting style.
 */
export async function setupAgentCommand(agentArg: string, cwd: string = process.cwd()): Promise<void> {
  let targets: readonly AgentTarget[];
  if (agentArg === 'all') {
    targets = AGENT_TARGETS;
  } else if ((AGENT_TARGETS as readonly string[]).includes(agentArg)) {
    targets = [agentArg as AgentTarget];
  } else {
    console.error(
      `waypoint setup-agent: unknown agent '${agentArg}' -- expected one of: ${AGENT_TARGETS.join(', ')}, or 'all'.`
    );
    process.exitCode = 1;
    return;
  }

  try {
    for (const target of targets) {
      const result = await setupAgentCommands(cwd, target);

      // Reported immediately, target by target, rather than accumulated and
      // printed only after the whole loop finishes: if a later target
      // throws, every already-succeeded target's real on-disk output has
      // still been reported to the user, instead of being silently lost
      // behind the catch block below.
      if (result.status === 'skipped-lock-contention') {
        console.log(`Skipped '${result.agent}': another 'waypoint setup-agent' run is already in progress.`);
        continue;
      }

      console.log(`Set up '${result.agent}' commands:`);
      for (const p of result.createdPaths) {
        console.log(`  created  ${p}`);
      }
      for (const p of result.preservedPaths) {
        console.log(`  kept     ${p}`);
      }
    }
  } catch (err) {
    if (err instanceof WaypointNotInstalledForSetupError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
    return;
  }
}
