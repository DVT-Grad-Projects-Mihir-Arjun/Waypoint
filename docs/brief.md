# Project Brief: Waypoint

*Working title — rename freely. "Waypoint" reflects the core idea: checkpoints of appropriate weight along a journey from patch to system.*

## Executive Summary

Waypoint is a lightweight, vendor-neutral spec-driven development (SDD) framework that scales its own ceremony to the size of the change being made. It replaces the single fixed pipeline used by tools like BMAD and Spec-Kit, and the near-total absence of one in OpenSpec, with a **tiered workflow** (Patch / Feature / System) plus **gates enforced outside the LLM** so agents can't quietly skip them. It works with any coding agent (Claude Code, Cursor, Codex, etc.) because it's just markdown, YAML, and a thin CLI — no proprietary IDE, no locked-in model.

## Problem Statement

Four SDD tools currently dominate the space, and each trades one failure mode for another:

- **Kiro** — tight IDE integration, but locks you into AWS's editor, model pipeline (Bedrock), and pricing.
- **BMAD** — comprehensive multi-agent process, but becomes a "sledgehammer to crack a nut" on small changes, producing review overload (a 3-file fix buried under 300 lines of generated prose).
- **Spec-Kit** — structured phases with enterprise integrations, but its gates are prompted instructions an agent can bypass, and small iterative changes require workarounds it wasn't designed for.
- **OpenSpec** — fast, low-ceremony deltas, but no enforcement at all — discipline is entirely on the human, so rigor erodes under deadline pressure.

No current tool scales its process to match the size of the change, and none separate "the agent should follow this rule" from "the agent cannot proceed without satisfying this rule."

## Proposed Solution

A tiered SDD framework where:

1. **Change size determines process weight** — a config-file tweak doesn't produce the same artifacts as a new subsystem.
2. **Specs are the regenerable source of truth**, living in the repo, edited via deltas (ADDED/MODIFIED/REMOVED) rather than rewritten wholesale.
3. **Gates are mechanically enforced** — a pre-commit/CI check and a task-completion ledger the agent cannot self-report around, not just an instruction in a prompt.
4. **The framework is tool-agnostic** — plain files any agent can read, no IDE fork, no bundled model.
5. **Agent roles stay lightweight** — 3–4 role prompts (Planner, Architect, Implementer, Reviewer) instead of a full simulated org chart, invoked as subagents/system prompts rather than infrastructure.

## Target Users

- **Primary**: the developer building this (solo or small team), using Claude Code / Cursor / similar day-to-day, who wants BMAD's rigor without its weight on small changes, and OpenSpec's speed without losing enforcement.
- **Secondary** (post-MVP): small engineering teams who want a shared, auditable spec convention across contributors and agents without adopting a specific vendor's IDE.

*Assumption: this is being built primarily for personal/small-team use first, open-sourceable later. Flag if the target is different (e.g., building this as a product for external teams from day one — that changes packaging and docs priorities).*

## Goals & Success Metrics

- A trivial fix takes **under 2 minutes** of process overhead (create patch record, done).
- A mid-size feature produces a spec reviewable in **under 5 minutes**, not a 300-line doc dump.
- **100% of merged changes** have a corresponding spec artifact — enforced by a gate, not a convention.
- Works identically whether driven by Claude Code, Cursor, or a bare CLI invocation — **zero agent-specific code paths** in the core.

## MVP Scope

**In:**
- Three-tier workflow (Patch / Feature / System) with per-tier templates
- CLI commands: `new-patch`, `new-feature`, `new-system`, `check-drift`, `approve`, `status`
- Delta-based spec format (ADDED/MODIFIED/REMOVED)
- Git-hook + CI gate script enforcing spec↔code correspondence
- Machine-checked task ledger (JSON/YAML) blocking task N+1 until N is marked complete by the gate, not by agent self-report
- `AGENTS.md` / `CLAUDE.md`-style instruction file describing tier-selection rules to any agent
- 3–4 lightweight role prompts (Planner, Architect, Implementer, Reviewer)

**Out (post-MVP):**
- Web UI / dashboard
- Multi-repo / monorepo orchestration
- Built-in analytics or telemetry
- A bundled or required model — framework stays model-agnostic

## Post-MVP Vision

- Team mode: shared spec conventions, PR templates that auto-populate from the spec delta
- Optional integrations (Linear/Jira) to sync task ledger status
- A "drift dashboard" showing specs that have gone stale against the code

## Technical Considerations

- **Language/runtime**: Node.js CLI (matches the ecosystem BMAD/Spec-Kit already live in, easiest for teams to adopt alongside existing agents). *Assumption — say the word if you'd rather this be Python or a single Bash script for zero-dependency installs.*
- **Storage**: everything is flat files in the repo (`/specs`, `/tasks`, `/decisions`) — no database, no server.
- **Enforcement mechanism**: git hooks + CI script, independent of any LLM's cooperation.
- **Distribution**: npm package, `npx waypoint install` mirroring the ergonomics people already expect from this category.

## Risks & Open Questions

- **Risk**: too many tiers/rules recreates BMAD's ceremony problem. Mitigation: keep the tier-selection logic to a single simple heuristic (file/line count changed, or explicit user flag) and bias toward the lighter tier when ambiguous.
- **Risk**: gates that are *too* strict block legitimate fast iteration. Mitigation: Patch tier should have zero gates by design — enforcement only kicks in at Feature tier and above.
- **Open question**: should tier classification be automatic (heuristic on diff size) or always explicit (`waypoint new-patch` vs `new-feature`)? Recommend explicit for MVP — automatic classification is a good post-MVP addition once you have data on where the boundary should sit.

## Appendix: Competitive Snapshot

| Framework | Ceremony | Enforcement | Portability |
|---|---|---|---|
| Kiro | Medium, IDE-driven | Strong (in-IDE) | Low (AWS-locked) |
| BMAD | High | Convention-based | High (markdown) |
| Spec-Kit | Medium-high | Bypassable gates | High |
| OpenSpec | Low | None | High |
| **Waypoint (proposed)** | **Scales to change size** | **Mechanical, outside the LLM** | **High** |
