import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { AGENT_COMMAND_REGISTRY } from './agent-command-registry.js';
import type { AgentCommandSpec } from './agent-command-registry.js';
import { acquireLock, releaseLock } from './scaffold.js';
import { renderAgentCommandBody } from './templates/agent-command-body.js';

/**
 * `waypoint setup-agent <agent>` — generates one native slash command/skill
 * file per `AGENT_COMMAND_REGISTRY` entry for the chosen coding-agent tool,
 * so Waypoint's workflow verbs show up directly in that tool's own command
 * list instead of requiring the agent to be told to go read `AGENTS.md`.
 *
 * Every target tool researched (Aug 2026) has converged on a `SKILL.md`
 * (`name`/`description` YAML frontmatter + prose body) file as its current,
 * non-deprecated mechanism for a repo-local, git-shareable command —
 * differing only in *where* that file lives on disk:
 * - Claude Code: `.claude/skills/<command-name>/SKILL.md`
 * - Cursor and Codex CLI: the identical shared path,
 *   `.agents/skills/<command-name>/SKILL.md` — writing once under
 *   `.agents/skills/` genuinely covers both tools, they read the same
 *   location.
 * - Antigravity CLI: `.agents/skills/<command-name>.md` — a **flat** file,
 *   not a directory, unlike the other three. Confirmed directly against
 *   Antigravity's own first-party docs (a third-party source claiming a
 *   directory shape was checked and found to contradict the first-party
 *   page). This coexists on disk with Cursor/Codex's directory-shaped
 *   skills under the same `.agents/skills/` parent without colliding,
 *   since a file and a same-named directory are distinct filesystem
 *   entries.
 */
export type AgentTarget = 'claude-code' | 'antigravity' | 'cursor' | 'codex';

export const AGENT_TARGETS: readonly AgentTarget[] = ['claude-code', 'antigravity', 'cursor', 'codex'];

/**
 * `skipped-lock-contention` mirrors `scaffold()`'s own `ScaffoldResult`
 * shape: another `setupAgentCommands` run was already holding the lock when
 * this run's wait timed out — a safe no-op, never a partial/corrupted write.
 * `createdPaths`/`preservedPaths` are always empty for that outcome, since
 * the write loop never ran.
 */
export interface AgentSetupResult {
  agent: AgentTarget;
  status: 'set-up' | 'skipped-lock-contention';
  createdPaths: string[];
  preservedPaths: string[];
}

/**
 * Thrown when `setupAgentCommands` is called against a repo that hasn't run
 * `waypoint install` yet — generating agent commands that wrap a `waypoint`
 * CLI that has nothing to scaffold onto would be actively misleading.
 */
export class WaypointNotInstalledForSetupError extends Error {
  constructor() {
    super(
      "waypoint setup-agent: this repo hasn't run 'waypoint install' yet -- run that first, then re-run 'waypoint setup-agent'."
    );
    this.name = 'WaypointNotInstalledForSetupError';
  }
}

/**
 * Thrown when `setupAgentCommands` is called directly (bypassing the CLI's
 * own validated `agentArg`) with a string that isn't a real `AgentTarget` —
 * `RENDERERS[agent]` would otherwise be `undefined` and fail with an
 * unhelpful raw `TypeError` deep inside the renderer lookup.
 */
export class InvalidAgentTargetError extends Error {
  constructor(value: string) {
    super(
      `waypoint setup-agent: '${value}' is not a valid agent target -- expected one of: ${AGENT_TARGETS.join(', ')}.`
    );
    this.name = 'InvalidAgentTargetError';
  }
}

/**
 * Self-contained install check, deliberately not imported from
 * `new-spec.ts`'s own unexported `isInstalled` — this codebase's
 * established convention (see `status.ts`/`done-claim.ts`) is a
 * self-contained reader per module rather than reaching into another
 * module's internals.
 */
function isWaypointInstalled(cwd: string): boolean {
  const configPath = path.join(cwd, '.waypoint', 'config.yaml');
  try {
    return existsSync(configPath) && statSync(configPath).isFile();
  } catch {
    return false;
  }
}

interface GeneratedFile {
  relPath: string;
  content: string;
}

/** Renders one spec's `SKILL.md` content — identical across every tool; only the file's location on disk differs. */
function renderSkillMd(spec: AgentCommandSpec): string {
  // `lineWidth: 0` disables the `yaml` library's default line-folding: some
  // registry descriptions (e.g. `update`'s) are long enough to otherwise
  // wrap across two lines in the rendered frontmatter. Still valid YAML
  // either way, but forcing every value onto one line removes any doubt.
  const frontmatter = stringify({ name: spec.commandName, description: spec.description }, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${renderAgentCommandBody(spec)}`;
}

/** `<baseDir>/skills/<command-name>/SKILL.md` for every registry entry — Claude Code, Cursor, and Codex's shared shape. */
function renderSkillDirectoryFiles(baseDir: string): GeneratedFile[] {
  return AGENT_COMMAND_REGISTRY.map((spec) => ({
    relPath: path.join(baseDir, 'skills', spec.commandName, 'SKILL.md'),
    content: renderSkillMd(spec),
  }));
}

/** `<baseDir>/skills/<command-name>.md` for every registry entry — Antigravity's flat-file shape. */
function renderFlatSkillFiles(baseDir: string): GeneratedFile[] {
  return AGENT_COMMAND_REGISTRY.map((spec) => ({
    relPath: path.join(baseDir, 'skills', `${spec.commandName}.md`),
    content: renderSkillMd(spec),
  }));
}

const RENDERERS: Record<AgentTarget, () => GeneratedFile[]> = {
  'claude-code': () => renderSkillDirectoryFiles('.claude'),
  cursor: () => renderSkillDirectoryFiles('.agents'),
  codex: () => renderSkillDirectoryFiles('.agents'),
  antigravity: () => renderFlatSkillFiles('.agents'),
};

/**
 * Distinct lock directory, never contending with `scaffold()`'s own
 * `.waypoint/.install.lock` or `verify.ts`'s per-spec
 * `.waypoint/.gate-state/.verify-<spec-id>.lock` locks.
 */
const SETUP_AGENT_LOCK_DIR_NAME = '.setup-agent.lock';

/**
 * Generates `agent`'s command files under `cwd`. Idempotent the same way
 * `scaffold()` is: any path that already exists is preserved untouched
 * (never overwrites a file the user has since customized), and only
 * genuinely new paths are written and reported under `createdPaths`. Safe
 * under concurrent invocation, also the same way `scaffold()` is: the
 * existence-check-then-write loop is serialized behind `scaffold.ts`'s own
 * `acquireLock`/`releaseLock` advisory lock (a distinct lock path from
 * `scaffold()`'s and `verify.ts`'s own), closing the TOCTOU race between two
 * concurrent `setup-agent` runs; a run that can't acquire the lock in time
 * no-ops (`status: 'skipped-lock-contention'`) instead of corrupting or
 * erroring.
 */
export async function setupAgentCommands(cwd: string, agent: AgentTarget): Promise<AgentSetupResult> {
  if (!(AGENT_TARGETS as readonly string[]).includes(agent)) {
    throw new InvalidAgentTargetError(agent);
  }
  if (!isWaypointInstalled(cwd)) {
    throw new WaypointNotInstalledForSetupError();
  }

  const lockDir = path.join(cwd, '.waypoint', SETUP_AGENT_LOCK_DIR_NAME);
  const acquired = await acquireLock(lockDir);
  if (!acquired) {
    return { agent, status: 'skipped-lock-contention', createdPaths: [], preservedPaths: [] };
  }

  try {
    const files = RENDERERS[agent]();
    const createdPaths: string[] = [];
    const preservedPaths: string[] = [];

    for (const file of files) {
      const absPath = path.join(cwd, file.relPath);
      if (existsSync(absPath)) {
        preservedPaths.push(file.relPath);
        continue;
      }
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, file.content, 'utf8');
      createdPaths.push(file.relPath);
    }

    return { agent, status: 'set-up', createdPaths, preservedPaths };
  } finally {
    await releaseLock(lockDir);
  }
}
