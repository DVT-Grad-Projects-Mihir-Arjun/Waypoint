import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AGENT_COMMAND_REGISTRY } from './agent-command-registry.js';
import {
  AGENT_TARGETS,
  InvalidAgentTargetError,
  setupAgentCommands,
  WaypointNotInstalledForSetupError,
} from './agent-setup.js';
import { gate } from './gate.js';
import { scaffold } from './scaffold.js';

// The built CLI entry point — used only by the real-installed-hook
// regression test below, to prove `setupAgentCommands`'s own generated
// output genuinely passes through the real pre-commit hook, mirroring
// `scaffold.test.ts`'s own analogous "Finding 1 regression" test. Requires
// `npm run build` to have run first.
const CLI_DIST_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../cli/dist/index.js'
);

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(cwd: string): void {
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-agent-setup-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('setupAgentCommands — precondition', () => {
  it('throws WaypointNotInstalledForSetupError when waypoint has never been installed in this repo', async () => {
    await expect(setupAgentCommands(tmpDir, 'claude-code')).rejects.toThrow(
      WaypointNotInstalledForSetupError
    );
  });

  it('throws InvalidAgentTargetError for a value that is not a real AgentTarget, even before the install check', async () => {
    // Deliberately does NOT scaffold() first: an invalid `agent` argument
    // should be rejected before even reaching the install precondition, the
    // same way it would from a direct @waypoint/core consumer that bypassed
    // the CLI's own validated `agentArg`.
    await expect(
      // @ts-expect-error -- intentionally passing a value outside the AgentTarget union
      setupAgentCommands(tmpDir, 'not-a-real-agent')
    ).rejects.toThrow(InvalidAgentTargetError);

    await expect(
      // @ts-expect-error -- intentionally passing a value outside the AgentTarget union
      setupAgentCommands(tmpDir, 'not-a-real-agent')
    ).rejects.toThrow(/not-a-real-agent/);
  });
});

describe('setupAgentCommands — claude-code', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('writes one SKILL.md per registry entry under .claude/skills/<command-name>/, all reported as created', async () => {
    const result = await setupAgentCommands(tmpDir, 'claude-code');

    expect(result.agent).toBe('claude-code');
    expect(result.createdPaths).toHaveLength(AGENT_COMMAND_REGISTRY.length);
    expect(result.preservedPaths).toHaveLength(0);

    for (const spec of AGENT_COMMAND_REGISTRY) {
      const relPath = path.join('.claude', 'skills', spec.commandName, 'SKILL.md');
      expect(result.createdPaths).toContain(relPath);
      expect(existsSync(path.join(tmpDir, relPath))).toBe(true);
    }
  });

  it('never generates a command for approve, even though it is a real waypoint CLI verb', async () => {
    await setupAgentCommands(tmpDir, 'claude-code');
    expect(existsSync(path.join(tmpDir, '.claude', 'skills', 'waypoint-approve'))).toBe(false);
  });

  it('every generated SKILL.md has valid, correctly-escaped YAML frontmatter with the expected name/description', async () => {
    await setupAgentCommands(tmpDir, 'claude-code');

    for (const spec of AGENT_COMMAND_REGISTRY) {
      const raw = readFileSync(
        path.join(tmpDir, '.claude', 'skills', spec.commandName, 'SKILL.md'),
        'utf8'
      );
      const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
      expect(match).not.toBeNull();
      const frontmatter = parse(match![1]!) as { name: string; description: string };
      expect(frontmatter.name).toBe(spec.commandName);
      expect(frontmatter.description).toBe(spec.description);
    }
  });

  it("the update command's SKILL.md frontmatter survives a description containing '###' and an apostrophe intact (YAML-escaping regression)", async () => {
    await setupAgentCommands(tmpDir, 'claude-code');

    const raw = readFileSync(path.join(tmpDir, '.claude', 'skills', 'waypoint-update', 'SKILL.md'), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    const frontmatter = parse(match![1]!) as { description: string };
    expect(frontmatter.description).toBe(
      "Sync new ### ADDED bullets into a spec's ledger, then append a fresh delta block"
    );
  });

  it('the body instructs running the real waypoint CLI verb and lists every positional argument', async () => {
    await setupAgentCommands(tmpDir, 'claude-code');

    const verifyBody = readFileSync(path.join(tmpDir, '.claude', 'skills', 'waypoint-verify', 'SKILL.md'), 'utf8');
    expect(verifyBody).toContain('Run `waypoint verify <spec-id> <task-id>`');
    expect(verifyBody).toContain('<spec-id>');
    expect(verifyBody).toContain('<task-id>');

    const statusBody = readFileSync(path.join(tmpDir, '.claude', 'skills', 'waypoint-status', 'SKILL.md'), 'utf8');
    expect(statusBody).toContain('Run `waypoint status`');
  });

  it('is idempotent: a second run preserves every file untouched, including a hand-edited one', async () => {
    await setupAgentCommands(tmpDir, 'claude-code');

    const editedPath = path.join(tmpDir, '.claude', 'skills', 'waypoint-status', 'SKILL.md');
    writeFileSync(editedPath, '---\nname: waypoint-status\ndescription: my own version\n---\n\nmy own body\n');

    const second = await setupAgentCommands(tmpDir, 'claude-code');

    expect(second.createdPaths).toHaveLength(0);
    expect(second.preservedPaths).toHaveLength(AGENT_COMMAND_REGISTRY.length);
    expect(readFileSync(editedPath, 'utf8')).toContain('my own body');
  });
});

describe('setupAgentCommands — antigravity', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('writes one flat .md file per registry entry directly under .agents/skills/ (not a directory)', async () => {
    const result = await setupAgentCommands(tmpDir, 'antigravity');

    expect(result.createdPaths).toHaveLength(AGENT_COMMAND_REGISTRY.length);
    for (const spec of AGENT_COMMAND_REGISTRY) {
      const relPath = path.join('.agents', 'skills', `${spec.commandName}.md`);
      expect(result.createdPaths).toContain(relPath);
      expect(existsSync(path.join(tmpDir, relPath))).toBe(true);
    }
  });

  it('every generated flat .md file has valid YAML frontmatter with the expected name/description and a body invoking the real waypoint verb', async () => {
    await setupAgentCommands(tmpDir, 'antigravity');

    for (const spec of AGENT_COMMAND_REGISTRY) {
      const raw = readFileSync(path.join(tmpDir, '.agents', 'skills', `${spec.commandName}.md`), 'utf8');
      const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
      expect(match).not.toBeNull();
      const frontmatter = parse(match![1]!) as { name: string; description: string };
      expect(frontmatter.name).toBe(spec.commandName);
      expect(frontmatter.description).toBe(spec.description);
      expect(raw).toContain(`Run \`waypoint ${spec.verb}`);
    }
  });
});

describe('setupAgentCommands — cursor and codex share the identical target path', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('codex reports every file as preserved (not duplicated) after cursor already created them at the same path', async () => {
    const cursorResult = await setupAgentCommands(tmpDir, 'cursor');
    expect(cursorResult.createdPaths).toHaveLength(AGENT_COMMAND_REGISTRY.length);

    const codexResult = await setupAgentCommands(tmpDir, 'codex');
    expect(codexResult.createdPaths).toHaveLength(0);
    expect(codexResult.preservedPaths).toHaveLength(AGENT_COMMAND_REGISTRY.length);

    for (const spec of AGENT_COMMAND_REGISTRY) {
      const relPath = path.join('.agents', 'skills', spec.commandName, 'SKILL.md');
      expect(existsSync(path.join(tmpDir, relPath))).toBe(true);
    }
  });

  it("this shared path does not collide with antigravity's flat file of the same base name", async () => {
    await setupAgentCommands(tmpDir, 'cursor');
    const antigravityResult = await setupAgentCommands(tmpDir, 'antigravity');

    // Both exist side by side: a directory (cursor/codex) and a same-named
    // flat file (antigravity) are distinct filesystem entries.
    expect(antigravityResult.createdPaths).toHaveLength(AGENT_COMMAND_REGISTRY.length);
    expect(existsSync(path.join(tmpDir, '.agents', 'skills', 'waypoint-status', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(tmpDir, '.agents', 'skills', 'waypoint-status.md'))).toBe(true);
  });

  it('every generated .agents/skills/<command-name>/SKILL.md has valid YAML frontmatter with the expected name/description and a body invoking the real waypoint verb', async () => {
    await setupAgentCommands(tmpDir, 'cursor');

    for (const spec of AGENT_COMMAND_REGISTRY) {
      const raw = readFileSync(
        path.join(tmpDir, '.agents', 'skills', spec.commandName, 'SKILL.md'),
        'utf8'
      );
      const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
      expect(match).not.toBeNull();
      const frontmatter = parse(match![1]!) as { name: string; description: string };
      expect(frontmatter.name).toBe(spec.commandName);
      expect(frontmatter.description).toBe(spec.description);
      expect(raw).toContain(`Run \`waypoint ${spec.verb}`);
    }
  });
});

describe('AGENT_TARGETS', () => {
  it('lists all four supported agents, matching setupAgentCommands\' own switch', () => {
    expect(AGENT_TARGETS).toEqual(['claude-code', 'antigravity', 'cursor', 'codex']);
  });
});

describe('setupAgentCommands — its own generated files pass the real installed gate hook (Finding 1-class regression)', () => {
  it("setup-agent's generated .claude/skills and .agents/skills files commit cleanly through the real pre-commit hook with no spec delta needed", async () => {
    // Unlike every other test in this file, this one deliberately uses a
    // real git repo and the real installed pre-commit hook (which shells to
    // Story 3.2's real `gate()`) instead of just inspecting
    // setupAgentCommands()'s return value -- the whole point is to prove
    // that a real `git add -A && git commit` after `waypoint setup-agent`
    // actually succeeds, not merely that DEFAULT_PATCH_GLOBS contains the
    // right strings. Mirrors scaffold.test.ts's own "Finding 1 regression"
    // end-to-end test.
    initGitRepo(tmpDir);

    const scaffoldResult = await scaffold(tmpDir);
    expect(scaffoldResult.warnings).toEqual([]);

    // The hook's `npx waypoint gate` line assumes the package is
    // published/linked; point it at this repo's own built CLI instead, same
    // technique scaffold.test.ts's own real-hook test uses.
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const hookContent = readFileSync(hookPath, 'utf8');
    expect(hookContent).toContain('exec npx waypoint gate');
    writeFileSync(
      hookPath,
      hookContent.replace('exec npx waypoint gate', `exec node '${CLI_DIST_ENTRY}' gate`)
    );

    // Commit the scaffold's own bootstrap output first, so the commit under
    // test below contains only setup-agent's generated files -- isolating
    // exactly what this regression test is about.
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);

    for (const target of AGENT_TARGETS) {
      await setupAgentCommands(tmpDir, target);
    }

    git(['add', '-A'], tmpDir);
    expect(() => git(['commit', '-m', 'setup-agent'], tmpDir)).not.toThrow();

    const changedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'], tmpDir)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    // `git show`'s own path reporting is always forward-slash-normalized,
    // regardless of host OS -- compare against literal prefixes, not
    // `path.join` (which would produce a backslash on Windows).
    expect(changedFiles.some((f) => f.startsWith('.claude/'))).toBe(true);
    expect(changedFiles.some((f) => f.startsWith('.agents/'))).toBe(true);

    // Also call gate() directly against the same changed-file list, so a
    // future regression that only breaks classification for one specific
    // path (e.g. `.agents/**` stops matching but `.claude/**` still does)
    // names which violation fired in this test's own failure output, rather
    // than the assertion above just reporting "the commit threw."
    const gateResult = await gate({ mode: 'staged', changedFiles, repoRoot: tmpDir });
    expect(gateResult.violations).toEqual([]);
    expect(gateResult.ok).toBe(true);
  }, 20000);
});

describe('setupAgentCommands — concurrency', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('leaves a fully correct, non-corrupted set of files when two setup-agent runs race against the same target', async () => {
    const [resultA, resultB] = await Promise.all([
      setupAgentCommands(tmpDir, 'claude-code'),
      setupAgentCommands(tmpDir, 'claude-code'),
    ]);

    expect(['set-up', 'skipped-lock-contention']).toContain(resultA.status);
    expect(['set-up', 'skipped-lock-contention']).toContain(resultB.status);
    // At least one of the two actually did the work.
    expect([resultA.status, resultB.status]).toContain('set-up');

    // Every file exists, with fully correct, non-corrupted content -- no
    // torn/partial write from either racing invocation.
    for (const spec of AGENT_COMMAND_REGISTRY) {
      const absPath = path.join(tmpDir, '.claude', 'skills', spec.commandName, 'SKILL.md');
      expect(existsSync(absPath)).toBe(true);

      const raw = readFileSync(absPath, 'utf8');
      const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
      expect(match).not.toBeNull();
      const frontmatter = parse(match![1]!) as { name: string; description: string };
      expect(frontmatter.name).toBe(spec.commandName);
      expect(frontmatter.description).toBe(spec.description);
    }

    // The lock is released, so a subsequent run still works.
    expect(existsSync(path.join(tmpDir, '.waypoint', '.setup-agent.lock'))).toBe(false);
    const followUp = await setupAgentCommands(tmpDir, 'claude-code');
    expect(followUp.status).toBe('set-up');
    expect(followUp.createdPaths).toHaveLength(0);
    expect(followUp.preservedPaths).toHaveLength(AGENT_COMMAND_REGISTRY.length);
  });
});
