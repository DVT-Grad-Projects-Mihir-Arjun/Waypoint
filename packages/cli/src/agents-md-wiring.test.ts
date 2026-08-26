import { describe, expect, it } from 'vitest';
import { renderAgentsMd, AGENT_COMMAND_REGISTRY } from '@waypoint/core';
import { createProgram } from './program.js';

// Closes the actual drift-detection gap left by
// `packages/core/src/templates/agents-md.test.ts`'s "lists every command
// currently registered in program.ts" test: that test only compares
// `renderAgentsMd()`'s output against its own hardcoded duplicate array of
// command-name strings, never against `program.ts` itself, so a command
// added/renamed/removed in `program.ts` without a matching hand-edit to
// `agents-md.ts` would go undetected.
//
// This test lives in `packages/cli` (rather than `packages/core`, where
// `agents-md.ts` is defined) because `packages/core` has no dependency on
// `packages/cli` and cannot import `program.ts` — `packages/cli` already
// depends on `@waypoint/core`, so this is the only direction the import can
// go.
describe('AGENTS.md command list vs. registered CLI commands', () => {
  it('mentions every registered command except the human-only `approve` gate', () => {
    const registeredNames = createProgram()
      .commands.map((c) => c.name())
      .filter((name) => name !== 'approve');

    // Sanity check: fail loudly (rather than vacuously passing) if
    // program.ts somehow stops registering the commands we expect to exist.
    expect(registeredNames.length).toBeGreaterThan(0);

    const rendered = renderAgentsMd();

    for (const name of registeredNames) {
      expect(rendered, `AGENTS.md should mention registered command "${name}"`).toContain(name);
    }
  });
});

// Same class of drift-detection gap as above, but for
// `AGENT_COMMAND_REGISTRY` (`packages/core/src/agent-command-registry.ts`):
// each entry's `verb` names a real `waypoint` CLI command that
// `setupAgentCommands` wraps a generated skill file around. Nothing
// previously proved that every registry `verb` still names a command
// `program.ts` genuinely registers — a verb renamed/removed in `program.ts`
// without a matching update to the registry would silently generate a skill
// file that invokes a `waypoint` subcommand that no longer exists.
describe('AGENT_COMMAND_REGISTRY verbs vs. registered CLI commands', () => {
  it('every registry verb matches a real command name registered in program.ts', () => {
    const registeredNames = createProgram().commands.map((c) => c.name());

    expect(registeredNames.length).toBeGreaterThan(0);

    for (const spec of AGENT_COMMAND_REGISTRY) {
      expect(registeredNames, `program.ts should register a command named "${spec.verb}"`).toContain(spec.verb);
    }
  });

  it('never includes install, approve, or setup-agent -- the three verbs deliberately excluded', () => {
    const verbs = AGENT_COMMAND_REGISTRY.map((spec) => spec.verb);

    expect(verbs).not.toContain('install');
    expect(verbs).not.toContain('approve');
    expect(verbs).not.toContain('setup-agent');
  });
});
