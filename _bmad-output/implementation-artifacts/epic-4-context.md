# Epic 4 Context: Agent Integration Layer

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Any coding agent (or human) can pick up this repo's conventions — tier rules, available commands, role-prompt locations — from one tool-agnostic, plain-markdown artifact, without custom per-tool prompting or a bespoke multi-agent runtime. This epic also closes a real safety property: an agent reading `AGENTS.md`/the role prompts is never told to invoke `approve` as part of its normal task-completion flow, since that command exists specifically to be human-run (FR8's documentation-layer exclusion).

## Stories

- Story 4.1: AGENTS.md generation
- Story 4.2: Role prompts

## Requirements & Constraints

- `AGENTS.md` is generated at `waypoint install` time and contains three sections: tier-selection heuristics, the available CLI commands, and where role prompts live — plain markdown with no tool-specific syntax, readable by Claude Code, Cursor, or a human directly.
- `approve` is deliberately excluded from `AGENTS.md`'s documented action list. This is a documentation-layer convention, not a technical block — it does not stop an agent with direct CLI/shell access from invoking `approve` itself, and the artifact must not overstate its own guarantee as more than that.
- `CLAUDE.md` generation is explicitly out of scope for MVP — `AGENTS.md` is the only generated agent-facing file; a tool-specific variant is a post-MVP concern only if a concrete need emerges.
- Exactly 4 role-prompt files (Planner, Architect, Implementer, Reviewer) are generated, each a standalone markdown file usable as a system prompt or slash-command body. Their content must reference the tier templates and gate commands so behavior stays consistent across roles, and none of the 4 may instruct or reference invoking `approve` — the exclusion holds in role-prompt content, not just in `AGENTS.md`'s own action list.
- Both `AGENTS.md` and the 4 role-prompt files already exist as placeholder content (written by Story 1.1's `scaffold()`) at their final paths — this epic's job is replacing that placeholder content, not creating new files or a new install-time mechanism.
- Reinstall semantics: if any of these files already exists and has been user-customized, `waypoint install` preserves it untouched rather than regenerating over it — the same generic preserve-on-reinstall rule Story 1.1 already established for every scaffolded path, not a new mechanism this epic needs to build.
- This FR is a claim about the generated artifact's contents, not about downstream agent behavior — whether an agent actually follows what `AGENTS.md`/the role prompts say is a property of that agent, not something Waypoint can guarantee or test for.

## Technical Decisions

- Both stories build on `packages/core/src/scaffold.ts`'s existing plan-entry mechanism: each file is a `{ kind: 'file', relPath, content: () => string }` entry, and `scaffold()`'s own generic "already exists → preserve untouched" check already covers these paths — no new preserve/detection logic is needed.
- Every other tier template in this codebase (`renderPatchSpec`, `renderFeatureSpec`, `renderSystemPrd`) is an embedded TypeScript template-string function under `packages/core/src/templates/`, not a separately-packaged template file — this is the established, real convention to follow for `AGENTS.md`'s and the role prompts' content, superseding an early architecture-doc sketch that mentioned a literal `agents-md.template` file (written before Epic 1 settled on the embedded-string pattern).
- Tier definitions available to draw the "tier-selection heuristics" content from: Patch = no approval gate, for a small self-contained change with no design ambiguity; Feature = one approval gate before implementation tasks can close; System = phased approval at each ledger phase boundary, for work spanning multiple architecture-level decisions. Tier is always named explicitly by which `new-*` command is run — there is no automatic classification from diff size for MVP.
- The available-CLI-commands section should reflect whatever subcommands `program.ts` has actually registered by the time this story ships (install, new-patch, new-feature, new-system, update, verify, approve, check-drift, gate, status once Epic 5 lands) — excluding `approve` from the list is this epic's one deliberate omission, not a signal to omit any other shipped command.

## Cross-Story Dependencies

- Depends on Story 1.1 having already created `AGENTS.md` and the 4 `roles/*.md` files at their final paths (with placeholder content) — this epic replaces that content, it doesn't create the paths.
- Story 4.2's role prompts reference the tier templates and gate commands Epic 1–3 already shipped, so their content depends on that prior work being stable.
- Depends on Epic 3 (mechanical gate enforcement) having shipped first — the whole reason `AGENTS.md` can tell an agent to trust the tier/gate conventions is that Epic 3 already made enforcement mechanical rather than a matter of the agent choosing to comply.
