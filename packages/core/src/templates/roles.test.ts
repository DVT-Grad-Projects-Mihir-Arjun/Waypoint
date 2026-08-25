import { describe, expect, it } from 'vitest';
import {
  renderPlannerPrompt,
  renderArchitectPrompt,
  renderImplementerPrompt,
  renderReviewerPrompt,
} from './roles.js';

describe('renderPlannerPrompt', () => {
  const content = renderPlannerPrompt();

  it('returns non-empty, plausible markdown', () => {
    expect(content.length).toBeGreaterThan(0);
    expect(content).toMatch(/^#\s+Planner/);
  });

  it('references the tier-drafting commands relevant to planning', () => {
    expect(content).toContain('new-patch');
    expect(content).toContain('new-feature');
    expect(content).toContain('new-system');
  });

  it('never contains the literal word "approve"', () => {
    expect(content.toLowerCase()).not.toContain('approve');
  });

  it('does not mention roles/commands that belong to other roles', () => {
    expect(content).not.toContain('check-drift');
    expect(content).not.toContain('waypoint verify');
    expect(content).not.toContain('waypoint update');
  });
});

describe('renderArchitectPrompt', () => {
  const content = renderArchitectPrompt();

  it('returns non-empty, plausible markdown', () => {
    expect(content.length).toBeGreaterThan(0);
    expect(content).toMatch(/^#\s+Architect/);
  });

  it('references `waypoint update` for syncing design decisions into the ledger', () => {
    expect(content).toContain('waypoint update');
  });

  it('never contains the literal word "approve"', () => {
    expect(content.toLowerCase()).not.toContain('approve');
  });

  it('does not mention roles/commands that belong to other roles', () => {
    expect(content).not.toContain('waypoint verify');
    expect(content).not.toContain('check-drift');
  });
});

describe('renderImplementerPrompt', () => {
  const content = renderImplementerPrompt();

  it('returns non-empty, plausible markdown', () => {
    expect(content.length).toBeGreaterThan(0);
    expect(content).toMatch(/^#\s+Implementer/);
  });

  it('references `waypoint verify` and the `gate` check', () => {
    expect(content).toContain('waypoint verify');
    expect(content).toMatch(/`gate`/);
  });

  it('never contains the literal word "approve"', () => {
    expect(content.toLowerCase()).not.toContain('approve');
  });

  it('does not mention roles/commands that belong to other roles', () => {
    expect(content).not.toContain('new-patch');
    expect(content).not.toContain('new-feature');
    expect(content).not.toContain('new-system');
    expect(content).not.toContain('check-drift');
  });
});

describe('renderReviewerPrompt', () => {
  const content = renderReviewerPrompt();

  it('returns non-empty, plausible markdown', () => {
    expect(content.length).toBeGreaterThan(0);
    expect(content).toMatch(/^#\s+Reviewer/);
  });

  it('references `waypoint check-drift`', () => {
    expect(content).toContain('waypoint check-drift');
  });

  it('never contains the literal word "approve"', () => {
    expect(content.toLowerCase()).not.toContain('approve');
  });

  it('does not mention roles/commands that belong to other roles', () => {
    expect(content).not.toContain('new-patch');
    expect(content).not.toContain('new-feature');
    expect(content).not.toContain('new-system');
    expect(content).not.toContain('waypoint update');
  });
});

describe('all 4 role prompts', () => {
  const prompts = {
    planner: renderPlannerPrompt(),
    architect: renderArchitectPrompt(),
    implementer: renderImplementerPrompt(),
    reviewer: renderReviewerPrompt(),
  };

  it('are plain markdown with no YAML frontmatter and no tool-specific syntax', () => {
    for (const [role, content] of Object.entries(prompts)) {
      expect(content.startsWith('---'), `${role} should not start with frontmatter`).toBe(false);
      expect(content, `${role} should not contain HTML comments`).not.toContain('<!--');
    }
  });
});
