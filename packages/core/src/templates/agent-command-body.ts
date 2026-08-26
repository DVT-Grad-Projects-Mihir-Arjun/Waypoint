import type { AgentCommandSpec } from '../agent-command-registry.js';

/**
 * Renders the prose body shared by every generated agent command file,
 * regardless of which tool it's for. No tool researched for this feature
 * (Claude Code, Antigravity CLI, Cursor, Codex CLI) has a consistently
 * documented, safe-to-rely-on argument-placeholder syntax — Claude Code's
 * `$ARGUMENTS`/`$1` is inconsistently documented and unconfirmed elsewhere,
 * and the other three have no documented mechanism at all. Plain prose
 * telling the agent what to substitute is portable across all four and
 * matches this exact codebase's own real installed Claude Code skills
 * (under `.claude/skills/`, one `SKILL.md` per skill), which already use
 * prose rather than placeholder tokens — confirmed directly, not assumed.
 */
export function renderAgentCommandBody(spec: AgentCommandSpec): string {
  const invocation =
    spec.args.length === 0
      ? `Run \`waypoint ${spec.verb}\` in the repo root.`
      : `Run \`waypoint ${spec.verb} ${spec.args.map((a) => `<${a.name}>`).join(' ')}\` in the repo root, substituting: ${spec.args
          .map((a) => `\`<${a.name}>\` — ${a.description}`)
          .join('; ')} (ask the user for anything not given).`;

  return `${invocation}\n\n${spec.description}.\n\n${spec.guidance}\n`;
}
