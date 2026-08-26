/**
 * Single source of truth for which `waypoint` CLI verbs get a generated,
 * agent-native slash command/skill (via `setup-agent`), and the
 * tool-agnostic content each one's file is built from. Every per-tool
 * renderer (`templates/agent-commands/*.ts`) consumes this same list, so
 * the set of exposed verbs and their descriptions/argument shapes can never
 * drift between tools — only the file path and frontmatter shape differ
 * per renderer.
 *
 * Deliberately excludes two verbs that `AGENTS.md` also documents:
 * - `install`: a one-time repo-initialization action, not a repeated
 *   workflow verb an agent invokes during its normal loop — and by the time
 *   an agent-native command could even be discovered, `install` (which is
 *   what creates this very file) has necessarily already run once.
 * - `approve`: deliberately human-only (FR8) — generating an
 *   agent-discoverable command for it would work directly against the
 *   documentation-layer convention that already excludes it from
 *   `AGENTS.md`'s own "Available Commands" list (see `templates/agents-md.ts`
 *   and `templates/roles.ts`'s matching doc comments). Never add `approve`
 *   here.
 */

export interface AgentCommandArg {
  /** Placeholder name as it appears in usage text, e.g. `spec-id`. */
  name: string;
  /** Human-readable one-line description of what this argument identifies. */
  description: string;
}

export interface AgentCommandSpec {
  /** The `waypoint` CLI verb this command wraps, e.g. `new-patch`. */
  verb: string;
  /**
   * Generated command's own name, used as the filename (and, where a tool's
   * frontmatter supports it, the `name:` field) — always `waypoint-<verb>`
   * so every generated command is unambiguously grouped and namespaced,
   * never colliding with an unrelated command the user or another tool
   * already has.
   */
  commandName: string;
  /** One-line description, a short paraphrase of `program.ts`'s own registration, written to fit a single line. */
  description: string;
  /** Positional arguments this verb takes, in order; empty for a no-argument verb. */
  args: AgentCommandArg[];
  /**
   * The guidance sentence(s) placed in the generated command's body, below
   * the literal `waypoint <verb> ...` invocation line every renderer
   * prepends itself. Written as an instruction to the agent, second person,
   * present tense — matches `templates/roles.ts`'s own voice.
   */
  guidance: string;
}

/**
 * Every agent-facing `waypoint` verb, in the same order `AGENTS.md`'s own
 * "Available Commands" list uses (minus `install`, plus `status`, which
 * `AGENTS.md`'s own list is updated in this same change to also include,
 * since it's read-only and safe to expose here).
 */
export const AGENT_COMMAND_REGISTRY: readonly AgentCommandSpec[] = [
  {
    verb: 'new-patch',
    commandName: 'waypoint-new-patch',
    description: 'Create a new Patch-tier spec (no approval step)',
    args: [{ name: 'name', description: 'short, hyphenated name for the change' }],
    guidance:
      'Use this for a small, self-contained change with no real design ambiguity. After creating it, fill in the spec\'s Summary section before implementing.',
  },
  {
    verb: 'new-feature',
    commandName: 'waypoint-new-feature',
    description: 'Create a new Feature-tier spec plus its task ledger (one approval gate)',
    args: [{ name: 'name', description: 'short, hyphenated name for the feature' }],
    guidance:
      'Use this for a change that adds behavior or needs upfront design. After creating it, fill in the spec\'s Requirements/Design/Task List sections. It needs human approval (`waypoint approve`) before its tasks can be marked done — that step is not yours to run.',
  },
  {
    verb: 'new-system',
    commandName: 'waypoint-new-system',
    description: 'Create a new System-tier spec set plus its phased task ledger',
    args: [{ name: 'name', description: 'short, hyphenated name for the system' }],
    guidance:
      'Use this for work spanning multiple architecture-level decisions. After creating it, fill in the generated PRD/architecture/ADR files. Each phase boundary needs human approval (`waypoint approve`) before that phase\'s tasks can be marked done — that step is not yours to run.',
  },
  {
    verb: 'update',
    commandName: 'waypoint-update',
    description: 'Sync new ### ADDED bullets into a spec\'s ledger, then append a fresh delta block',
    args: [{ name: 'spec-id', description: 'the full spec id, e.g. feat-2026-08-19-auth-refresh' }],
    guidance:
      'Run this after hand-adding one or more bullets under an existing spec\'s "### ADDED" delta section, to sync them into new ledger tasks.',
  },
  {
    verb: 'check-drift',
    commandName: 'waypoint-check-drift',
    description: 'Flag spec references to files/symbols that no longer resolve',
    args: [],
    guidance: 'Run this periodically, or before approving/closing a spec, to catch stale references early.',
  },
  {
    verb: 'gate',
    commandName: 'waypoint-gate',
    description: 'Check that currently staged changes are accompanied by a spec delta',
    args: [],
    guidance:
      'This is the same check that runs automatically as a pre-commit hook — run it manually to check staged changes before committing, without waiting for the hook.',
  },
  {
    verb: 'verify',
    commandName: 'waypoint-verify',
    description: 'Run a task\'s check command and, only on success, record it as done and verified',
    args: [
      { name: 'spec-id', description: 'the full spec id, e.g. feat-2026-08-19-auth-refresh' },
      { name: 'task-id', description: 'the ledger task id, e.g. t1' },
    ],
    guidance:
      'Run this once you believe a task is genuinely complete. It never trusts a hand-edit — only this command can mark a task done.',
  },
  {
    verb: 'status',
    commandName: 'waypoint-status',
    description: 'Read-only report of every open spec, its approval state, and task completion',
    args: [],
    guidance: 'Run this any time to see what work is still open across every spec, at every tier.',
  },
];
