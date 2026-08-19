# Architecture Document: Waypoint

## Introduction

This document defines the technical architecture for Waypoint, the tiered spec-driven development framework described in `brief.md` and `prd.md`. It covers the CLI, file formats, gate enforcement mechanism, and integration surface for coding agents.

**Starter template**: none — this is a greenfield npm CLI package, not built on an existing framework's scaffold.

## High-Level Architecture

**Summary**: Waypoint is a local-first, file-based system. There is no server and no database. The CLI reads and writes markdown/YAML files in the consuming repo, and two enforcement points (a git pre-commit hook and a CI-runnable script) call the same core validation logic to guarantee spec↔code correspondence regardless of which agent or human made the change.

```
┌─────────────────────────────────────────────────────────┐
│                     Consuming Repo                        │
│                                                             │
│  /specs/patches/*.md        (Patch tier, no gates)         │
│  /specs/features/*.md       (Feature tier, 1 gate)         │
│  /specs/systems/*/          (System tier, phased gates)    │
│  /tasks/*.ledger.yaml       (machine-checked status)       │
│  /decisions/*.md            (ADRs, System tier only)       │
│  AGENTS.md                  (generated, agent-facing)      │
│  .waypoint/config.yaml      (tier heuristics, paths)       │
│                                                             │
│         ▲                              ▲                   │
│         │                              │                   │
│  ┌──────┴───────┐              ┌───────┴────────┐          │
│  │  waypoint CLI │              │  gate script   │          │
│  │ (human/agent  │              │ (pre-commit +  │          │
│  │  invoked)     │              │  CI, same code)│          │
│  └───────────────┘              └────────────────┘          │
└─────────────────────────────────────────────────────────┘
```

**Architectural pattern**: a single core validation/gate library, invoked from three surfaces (CLI subcommands, git hook, CI script) — this avoids the classic bug of "the hook checks something slightly different than the CLI command," which is how enforcement quietly rots in practice.

## Tech Stack

| Category | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Type safety for the gate/ledger logic, which must never silently misbehave |
| Runtime | Node.js 20+ | Matches ecosystem norm (BMAD, Spec-Kit both Node-based); widest agent tool compatibility |
| CLI framework | Commander.js | Same choice BMAD uses; well-understood, low overhead |
| Config format | YAML | Human-editable, matches task-ledger and frontmatter needs |
| Spec format | Markdown + YAML frontmatter | Readable by humans and any LLM without special parsing |
| Testing | Vitest | Fast, TypeScript-native, sufficient for a CLI-sized project |
| Distribution | npm package (`npx waypoint`) | Zero-install-friction, matches expectations from this tool category |
| Git integration | Husky (or hand-rolled hook script) | Standard, well-supported pre-commit hook management |

## Data Models

**Spec frontmatter** (all tiers):
```yaml
---
id: feat-2026-08-19-auth-refresh
tier: feature        # patch | feature | system
status: draft         # draft | approved | in-progress | done
approved_by: null
approved_at: null
created_at: 2026-08-19
---
```

**Task ledger** (`/tasks/<spec-id>.ledger.yaml`):
```yaml
spec_id: feat-2026-08-19-auth-refresh
tasks:
  - id: t1
    description: "Add refresh-token endpoint"
    status: pending       # pending | in-progress | done
    linked_commit: null
    verified_by_gate: false
  - id: t2
    description: "Add integration test for refresh flow"
    status: pending
    linked_commit: null
    verified_by_gate: false
```

Only the gate script may set `status: done` and `verified_by_gate: true` — it does so by confirming `linked_commit` exists, is reachable in the current branch, and that the configured check command (e.g., `npm test`) exits 0 for that commit. Any other process editing this field directly is a validation failure the gate script flags.

## Components

**1. CLI (`waypoint`)**
Subcommands: `install`, `new-patch`, `new-feature`, `new-system`, `check-drift`, `approve`, `status`. Thin layer over the core library — no business logic lives in the CLI itself, so hook/CI/CLI all share behavior.

**2. Core Library (`@waypoint/core`)**
- `templates/` — tier-specific spec templates
- `gate/` — validation logic: spec↔code correspondence check, ledger integrity check
- `drift/` — reference-scanning logic for `check-drift`
- `ledger/` — read/write/verify logic for task ledgers, with the "only the gate may mark done" invariant enforced here, not in the CLI layer

**3. Gate Script**
Callable two ways with identical behavior:
- As a git pre-commit hook (fast path, staged changes only)
- As a CI script (full path, entire PR diff)

Both call `@waypoint/core/gate`, so there's exactly one implementation of "what counts as a violation."

**4. Agent Integration Layer**
- Generates `AGENTS.md` at install time from a template, listing: tier heuristics, available CLI commands, and where role prompts live.
- Role prompts (`/roles/planner.md`, `/roles/architect.md`, `/roles/implementer.md`, `/roles/reviewer.md`) are plain markdown, usable as system prompts, slash-command bodies, or pasted directly — no tool-specific format.

## Core Workflows

**Feature-tier flow:**
1. Human or agent runs `waypoint new-feature <name>` → scaffolds spec from template, status `draft`.
2. Spec is filled in (requirements, design, initial task list).
3. Human runs `waypoint approve <spec-id>` → status becomes `approved`. *(Not agent-callable in the default `AGENTS.md` action list — see FR8/Story 3.3.)*
4. Agent implements tasks; each task completion requires a linked commit.
5. Pre-commit hook / CI runs the gate script on each commit: verifies the linked task's check passes, sets `verified_by_gate: true`, updates ledger status to `done`.
6. `waypoint status` reflects real-time progress; spec is closed when all tasks are `done`.

**Patch-tier flow:**
1. `waypoint new-patch <name>` → single file, no approval field, no gate hook triggered for changes under patch-classified paths.
2. Commit proceeds normally — zero added friction, by design (NFR2).

**Drift-check flow (any tier, run manually or in CI on a schedule):**
1. `waypoint check-drift` scans all `approved`/`in-progress` specs for referenced file paths/symbols.
2. Any reference no longer resolvable in the current codebase is flagged with the spec ID and location.
3. Exit code non-zero if any drift found — usable as a scheduled CI job independent of the commit-time gate.

## Source Tree

```
waypoint/
├── packages/
│   ├── cli/                 # waypoint bin, subcommand wiring (Commander.js)
│   └── core/                 # gate, drift, ledger, templates — the enforceable logic
├── templates/
│   ├── patch.md
│   ├── feature.md
│   ├── system/
│   │   ├── prd.md
│   │   ├── architecture.md
│   │   └── adr.md
│   ├── agents-md.template
│   └── roles/
│       ├── planner.md
│       ├── architect.md
│       ├── implementer.md
│       └── reviewer.md
├── scripts/
│   └── gate.sh               # thin wrapper calling core/gate for hook + CI use
└── test/
```

In a **consuming** repo after `npx waypoint install`:
```
your-repo/
├── specs/{patches,features,systems}/
├── tasks/*.ledger.yaml
├── decisions/*.md
├── AGENTS.md
└── .waypoint/config.yaml
```

## Infrastructure and Deployment

- Distributed as an npm package; no hosted infrastructure required for MVP.
- `.waypoint/config.yaml` in the consuming repo holds tier-classification settings (e.g., which paths are patch vs. feature by default) and the check command used for task verification (`npm test`, `pytest`, etc. — configurable, not hardcoded to one stack).
- CI integration is a single script invocation (`npx waypoint gate --ci`) added to the consuming repo's existing pipeline — Waypoint does not run its own CI infrastructure.

## Error Handling Strategy

- Gate violations produce a clear, actionable message (which spec is missing a delta, which file changed outside an approved task) rather than a generic failure — this is the part most likely to frustrate users if it's opaque.
- The gate **fails closed** on ambiguity: if it cannot determine whether a change is Patch or Feature tier, it treats it as Feature tier (the safer, gated default) rather than silently letting it through.
- Ledger corruption (e.g., hand-edited status fields) is detected via a checksum/hash comparison against the last gate-written state, matching the SHA256 manifest-hash pattern already proven in this tool category.

## Test Strategy

- **Unit tests** (priority 1): gate logic, drift detection, ledger read/write/verify — this is deterministic code with no LLM involvement, and it's the part that must never silently fail.
- **Integration tests**: full CLI flows (`new-feature` → `approve` → task completion → gate pass) against a scratch git repo fixture.
- **Manual/agent-driven testing**: dogfooding the framework on its own development (this project can plan itself using its own Feature-tier flow once Epic 1–3 are done — a good milestone/sanity check).

## Next Steps

1. Hand this `docs/` folder to BMAD (or your agent of choice) to generate implementation stories from the PRD's epics.
2. Build Epic 1 first (scaffolding) — everything else depends on the folder conventions existing.
3. Build Epic 3 (gate enforcement) before Epic 4 (agent integration) — you want the mechanical enforcement proven before you write the `AGENTS.md` that tells agents to trust it.
