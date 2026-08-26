/**
 * Single source of truth for the generated `AGENTS.md` content — mirrors the
 * embedded-string pattern `renderPatchSpec()`/`renderFeatureSpec()`/
 * `renderSystemPrd()` use in `./patch.ts`/`./feature.ts`/`./system.ts`,
 * avoiding npm-packaging a separate `templates/agents-md.template` file (the
 * literal file docs/architecture.md's source-tree sketch shows predates
 * Epic 1 settling on this embedded-TypeScript-string convention).
 *
 * The Available Commands list below is necessarily hand-maintained:
 * `packages/core` has no dependency on `packages/cli`, so it cannot
 * introspect `program.ts`'s registered commands at runtime. Whoever adds,
 * renames, or removes a command in `packages/cli/src/program.ts` MUST update
 * this list by hand in the same change — there is no automated check that
 * keeps the two in sync.
 *
 * `approve` is deliberately never listed here (FR8): it's a human-only
 * approval gate, excluded by documentation convention from the set of
 * actions described to agents, not a technically enforced restriction.
 */
export function renderAgentsMd(): string {
  return `# AGENTS.md

Guidance for any AI agent (or human) working in a repository installed with
Waypoint: right-sized spec ceremony for AI-assisted development.

## Tier Selection

Every change is recorded as a spec at one of three tiers. Tier is always
named explicitly by which \`new-*\` command is run — never inferred
automatically from diff size or file count.

- **Patch**: for a small, self-contained change with no design ambiguity.
  No approval gate. Use \`waypoint new-patch <name>\`.
- **Feature**: for a change that adds behavior or needs upfront design. One
  approval gate must be granted before its implementation tasks can be
  marked done. Use \`waypoint new-feature <name>\`.
- **System**: for work spanning multiple architecture-level decisions.
  Approval happens in phases, once at each ledger phase boundary. Use
  \`waypoint new-system <name>\`.

When unsure which tier fits, prefer the lowest tier that honestly captures
the change's design ambiguity and blast radius — escalating a Patch to a
Feature later is normal and cheap.

Approval itself is a human-only step in this process; it is granted outside
of any action an agent takes (see Available Commands below).

## Available Commands

- \`waypoint install\` — scaffold the Waypoint repo structure (\`specs/\`,
  \`tasks/\`, \`decisions/\`, \`roles/\`, \`AGENTS.md\`, \`.waypoint/config.yaml\`)
  in the current repository.
- \`waypoint new-patch <name>\` — create a new Patch-tier spec.
- \`waypoint new-feature <name>\` — create a new Feature-tier spec plus its
  task ledger.
- \`waypoint new-system <name>\` — create a new System-tier spec set plus its
  phased task ledger.
- \`waypoint update <spec-id>\` — sync hand-filled \`### ADDED\` bullets into
  the ledger, then append a fresh empty delta block to an existing
  Feature/System spec.
- \`waypoint check-drift\` — scan specs that are past draft status for
  references to files or symbols that no longer exist in the code.
- \`waypoint gate\` — check that code changes are accompanied by a spec delta;
  this is the check installed as a commit hook. A separate \`--ci --base <ref>\`
  mode also exists for a fuller, CI-time check. Wiring that mode into an
  actual CI pipeline is always the consuming repo's own responsibility —
  \`waypoint install\` does not configure CI enforcement automatically.
- \`waypoint verify <spec-id> <task-id>\` — run a task's check command and,
  only on success, record it as done and verified in its ledger.
- \`waypoint status\` — read-only report of every open spec, its approval
  state, and task completion.
- \`waypoint setup-agent <agent>\` — generate native slash-command/skill files
  for a coding-agent tool (one of \`claude-code\`, \`antigravity\`, \`cursor\`,
  \`codex\`, or \`all\`), one per command in this list except \`install\` and the
  command gated behind human approval (see Tier Selection above), so they
  show up directly in that tool's own command list.

Note: this list intentionally does not include every action available in
this repository's process — see Tier Selection above for the human-only
approval step.

## Role Prompts

Four plain-markdown role prompts live under \`roles/\` at the repo root:

- \`roles/planner.md\`
- \`roles/architect.md\`
- \`roles/implementer.md\`
- \`roles/reviewer.md\`

Point any agent at one of these files as a system prompt, a slash-command
body, or general context, depending on which role that agent is playing in
the current task.
`;
}
