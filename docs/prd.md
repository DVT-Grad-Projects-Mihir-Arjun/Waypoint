# Product Requirements Document: Waypoint

## Goals and Background Context

**Goals**
- Give changes the amount of process ceremony they actually warrant, automatically or via explicit choice.
- Make specs the living, regenerable source of truth for code, not disposable planning exhaust.
- Make gate enforcement mechanical (scripts/hooks) rather than dependent on an agent choosing to comply.
- Keep the framework usable from any coding agent or plain terminal — no IDE lock-in, no bundled model.

**Background Context**

Existing SDD tools (Kiro, BMAD, Spec-Kit, OpenSpec) each solve part of the "agent needs persistent, structured context across sessions" problem, but none solve the whole thing without a serious tradeoff — see `brief.md` for the full comparison. Waypoint's core bet is that ceremony and enforcement are two separate dials, and every existing tool has them coupled together. Decoupling them (tier controls ceremony; gates control enforcement, independent of tier) is the central design insight this PRD builds from.

**Change Log**

| Date | Version | Description | Author |
|---|---|---|---|
| 2026-08-19 | 0.1 | Initial PRD drafted in planning session | Claude (PM agent) |

## Requirements

### Functional

- **FR1**: The CLI shall provide `waypoint new-patch <name>`, creating a minimal delta record with no required approval step.
- **FR2**: The CLI shall provide `waypoint new-feature <name>`, scaffolding a requirements + design + task-list spec from a template, requiring one approval step before implementation tasks can be marked complete.
- **FR3**: The CLI shall provide `waypoint new-system <name>`, scaffolding a full spec set (PRD-style requirements, architecture doc, ADR stubs, phased task list) requiring approval at each phase boundary.
- **FR4**: Specs shall support delta-style edits (ADDED / MODIFIED / REMOVED sections) so an existing spec can be updated without a full rewrite.
- **FR5**: The system shall provide `waypoint check-drift`, comparing the current spec against the actual code/diff and flagging sections that reference code that no longer exists or has materially changed.
- **FR6**: The system shall maintain a machine-readable task ledger (YAML/JSON) per Feature/System spec, where each task has a status field settable only by the gate script upon verified completion (e.g., linked commit + passing check), not by free-text agent output.
- **FR7**: A gate script (usable as a git pre-commit hook and in CI) shall block a commit/merge if code changed without a corresponding spec delta at Feature tier or above.
- **FR8**: The system shall provide `waypoint approve <spec-id>`, settable only by a human-invoked command (not something an agent can call on its own as part of a normal task-completion flow), recording approval in the spec's frontmatter.
- **FR9**: An `AGENTS.md` (and optionally `CLAUDE.md`) file shall be generated at install time, describing tier-selection rules and role prompts so any agent reading the repo picks the correct process automatically.
- **FR10**: The system shall define 3–4 role prompts (Planner, Architect, Implementer, Reviewer) as plain markdown files any agent can be pointed to, rather than requiring a bespoke multi-agent runtime.
- **FR11**: The CLI shall provide `waypoint status`, showing open specs, their tier, approval state, and task completion state across the repo.

### Non-Functional

- **NFR1**: The framework shall have zero required runtime dependency on any specific AI model or vendor.
- **NFR2**: The Patch tier shall add no more than ~30 seconds of process overhead to a trivial change.
- **NFR3**: All state shall be stored as flat files (markdown/YAML/JSON) in the repo — no external database or server required for MVP.
- **NFR4**: The gate script shall run in under 2 seconds on a typical repo to avoid discouraging use in pre-commit hooks.
- **NFR5**: The CLI shall work identically on macOS, Linux, and WSL (Node.js 20+ as the only hard requirement, matching current ecosystem norms).
- **NFR6**: Installation shall be a single command (`npx waypoint install`) with no manual config required for a sane default setup.

## Technical Assumptions

- **Repository structure**: monorepo for the framework itself (CLI + templates + gate scripts in one npm package).
- **Testing**: unit tests for the gate/drift logic (deterministic, non-LLM code) prioritized over end-to-end agent tests, since the enforcement mechanism is the part that must never silently fail.
- **Language**: Node.js/TypeScript for the CLI, matching the ecosystem this tool has to interoperate with.

*Flag if any of these are wrong for your environment — e.g., if you want this distributed as a single dependency-free shell script instead of an npm package, that changes Epic 1 significantly.*

## Epic List

1. **Epic 1 — Core CLI & Tiering**: scaffolding commands, tier templates, repo conventions.
2. **Epic 2 — Delta Spec Format & Drift Detection**: the spec file format itself and the drift-check command.
3. **Epic 3 — Mechanical Gate Enforcement**: git hook, CI script, task ledger with agent-proof status.
4. **Epic 4 — Agent Integration Layer**: `AGENTS.md` generation, role prompts, per-tool setup (Claude Code, Cursor, etc.).
5. **Epic 5 — Status & Reporting**: `waypoint status`, human-readable summaries across open specs.

## Epic Details

### Epic 1 — Core CLI & Tiering

**Story 1.1**: As a developer, I want `waypoint install` to scaffold `/specs`, `/tasks`, `/decisions`, and config files in my repo, so I have the base structure without manual setup.
- AC1: Running install in an empty repo creates all four top-level items with no errors.
- AC2: Running install in a repo that already has a `/specs` folder does not overwrite existing content.

**Story 1.2**: As a developer, I want `waypoint new-patch <name>` to create a minimal spec file with no approval requirement, so trivial changes stay fast.
- AC1: Command creates a single markdown file under `/specs/patches/` from a lightweight template.
- AC2: No task-ledger or approval fields are required for this tier.

**Story 1.3**: As a developer, I want `waypoint new-feature <name>` and `waypoint new-system <name>` to scaffold their respective templates with the right sections pre-filled.
- AC1: Feature template includes requirements, design, and a task list section.
- AC2: System template includes PRD-style requirements, architecture stub, ADR stubs, and phased tasks.

### Epic 2 — Delta Spec Format & Drift Detection

**Story 2.1**: As a developer, I want to update an existing spec using ADDED/MODIFIED/REMOVED sections, so I don't have to rewrite the whole document for a small change.
- AC1: CLI provides a way to append a dated delta block to an existing spec file.
- AC2: Delta blocks are visually distinct in the rendered markdown (e.g., a heading + tag).

**Story 2.2**: As a developer, I want `waypoint check-drift` to flag specs referencing code paths or functions that no longer exist, so stale specs get caught before they mislead an agent.
- AC1: Command scans spec content for referenced file paths and checks they still exist in the repo.
- AC2: Command exits non-zero if drift is found, suitable for CI use.

### Epic 3 — Mechanical Gate Enforcement

**Story 3.1**: As a developer, I want a pre-commit hook that blocks commits changing code without a corresponding spec delta (Feature tier+), so enforcement doesn't depend on remembering to update the spec.
- AC1: Hook correctly identifies Feature/System-tier code paths vs. Patch-tier (unenforced) paths.
- AC2: Hook can be bypassed only with an explicit `--no-verify`-equivalent flag that is logged, not silent.

**Story 3.2**: As a developer, I want a task ledger where a task's `done` status can only be set by the gate script after verifying a linked commit and passing check, so an agent can't mark its own work complete without verification.
- AC1: Attempting to hand-edit the ledger's status field is detected and flagged by the gate script.
- AC2: Gate script correctly transitions a task to `done` when its linked commit passes the specified check (e.g., test command exits 0).

**Story 3.3**: As a developer, I want `waypoint approve <spec-id>` restricted to a human-run command outside the agent's normal task loop, so approval gates can't be self-granted.
- AC1: Approval command is not exposed in the set of actions described to agents in `AGENTS.md` for autonomous use.
- AC2: Approval is recorded with a timestamp and (optionally) a name/identity field.

### Epic 4 — Agent Integration Layer

**Story 4.1**: As a developer, I want an `AGENTS.md` generated at install time explaining tier rules and available commands, so any agent I point at the repo behaves correctly without custom prompting per tool.
- AC1: File covers tier-selection heuristics, available CLI commands, and role-prompt locations.
- AC2: File is plain markdown with no tool-specific syntax, so it's readable by Claude Code, Cursor, or a human.

**Story 4.2**: As a developer, I want 3–4 role-prompt files (Planner, Architect, Implementer, Reviewer) I can point any agent at, so I get role separation without a bespoke multi-agent runtime.
- AC1: Each role prompt is a standalone markdown file usable as a system prompt or slash-command body.
- AC2: Role prompts reference the tier templates and gate commands so behavior stays consistent across roles.

### Epic 5 — Status & Reporting

**Story 5.1**: As a developer, I want `waypoint status` to show all open specs, their tier, approval state, and task completion, so I have one place to check where everything stands.
- AC1: Output is readable in a terminal (table or list format) and includes counts by tier.
- AC2: Command flags any Feature/System spec with unapproved status alongside in-progress tasks.
