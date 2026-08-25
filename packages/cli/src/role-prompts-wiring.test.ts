import { describe, expect, it } from 'vitest';
import {
  renderPlannerPrompt,
  renderArchitectPrompt,
  renderImplementerPrompt,
  renderReviewerPrompt,
} from '@waypoint/core';
import { createProgram } from './program.js';

// Closes the same class of cross-package drift-detection gap that
// `agents-md-wiring.test.ts` closes for `AGENTS.md`: `templates/roles.test.ts`
// (in packages/core) only checks each `render*Prompt()`'s own output for the
// `approve` exclusion and for mentioning commands as hardcoded strings — it
// never checks against `program.ts`'s actual registered commands, since
// packages/core has no dependency on packages/cli and cannot import
// `program.ts` directly. This test lives in packages/cli (which already
// depends on @waypoint/core) so it can import both sides and compare them
// directly.
describe('role prompts vs. registered CLI commands', () => {
  const prompts = {
    planner: renderPlannerPrompt(),
    architect: renderArchitectPrompt(),
    implementer: renderImplementerPrompt(),
    reviewer: renderReviewerPrompt(),
  };

  it('never names the real, registered `approve` command in any of the 4 role prompts', () => {
    const registeredNames = createProgram().commands.map((c) => c.name());
    expect(registeredNames).toContain('approve');

    for (const [role, content] of Object.entries(prompts)) {
      expect(content.toLowerCase(), `${role} prompt should not mention "approve"`).not.toContain(
        'approve',
      );
    }
  });

  it('the Implementer prompt references the real, registered `verify` and `gate` commands', () => {
    const registeredNames = createProgram().commands.map((c) => c.name());
    expect(registeredNames).toContain('verify');
    expect(registeredNames).toContain('gate');

    expect(prompts.implementer).toContain('verify');
    expect(prompts.implementer).toMatch(/`gate`/);
  });

  it('the Reviewer prompt references the real, registered `check-drift` and `verify` commands', () => {
    const registeredNames = createProgram().commands.map((c) => c.name());
    expect(registeredNames).toContain('check-drift');
    expect(registeredNames).toContain('verify');

    expect(prompts.reviewer).toContain('check-drift');
    expect(prompts.reviewer).toContain('verify');
  });

  it('the Architect prompt references the real, registered `update` command', () => {
    const registeredNames = createProgram().commands.map((c) => c.name());
    expect(registeredNames).toContain('update');

    expect(prompts.architect).toContain('waypoint update');
  });

  it('the Planner prompt references the real, registered `new-patch`/`new-feature`/`new-system` commands', () => {
    const registeredNames = createProgram().commands.map((c) => c.name());
    expect(registeredNames).toContain('new-patch');
    expect(registeredNames).toContain('new-feature');
    expect(registeredNames).toContain('new-system');

    expect(prompts.planner).toContain('new-patch');
    expect(prompts.planner).toContain('new-feature');
    expect(prompts.planner).toContain('new-system');
  });
});
