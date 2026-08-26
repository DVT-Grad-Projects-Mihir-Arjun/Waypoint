import { describe, expect, it } from 'vitest';
import { renderAgentsMd } from './agents-md.js';

describe('renderAgentsMd', () => {
  const content = renderAgentsMd();

  it('contains all three named sections', () => {
    expect(content).toMatch(/#+\s*Tier Selection/);
    expect(content).toMatch(/#+\s*Available Commands/);
    expect(content).toMatch(/#+\s*Role Prompts/);
  });

  // NOTE: this only checks the rendered content against its own hardcoded
  // duplicate list of command-name strings below — it does NOT verify
  // against `program.ts`'s actual registered commands (packages/core has no
  // dependency on packages/cli, so it cannot import program.ts directly).
  // That real drift-detection check lives in
  // packages/cli/src/agents-md-wiring.test.ts, which imports both
  // `createProgram` and `renderAgentsMd` and compares them directly. This
  // test remains a valid (if narrower) regression guard against accidental
  // edits to the list below.
  it('lists the command names currently hardcoded above', () => {
    for (const command of [
      'install',
      'new-patch',
      'new-feature',
      'new-system',
      'update',
      'check-drift',
      'gate',
      'verify',
      'status',
      'setup-agent',
    ]) {
      expect(content).toContain(command);
    }
  });

  it('never names `approve` as an available action, scoped to the Available Commands section', () => {
    const startMarker = content.match(/#+\s*Available Commands/);
    if (!startMarker || startMarker.index === undefined) {
      throw new Error('Available Commands heading not found in rendered content');
    }
    const sectionStart = startMarker.index + startMarker[0].length;
    const nextHeadingMatch = content.slice(sectionStart).match(/\n#+\s+\S/);
    const sectionEnd =
      nextHeadingMatch && nextHeadingMatch.index !== undefined
        ? sectionStart + nextHeadingMatch.index
        : content.length;
    const availableCommandsSection = content.slice(sectionStart, sectionEnd);

    expect(availableCommandsSection).not.toContain('approve');
  });

  it('lists all four role-prompt paths', () => {
    for (const rolePath of [
      'roles/planner.md',
      'roles/architect.md',
      'roles/implementer.md',
      'roles/reviewer.md',
    ]) {
      expect(content).toContain(rolePath);
    }
  });

  it('is plain markdown with no YAML frontmatter and no tool-specific syntax', () => {
    expect(content.startsWith('---')).toBe(false);
    expect(content).not.toContain('<!--');
  });
});
