# Product Requirements Document: Waypoint

## Goals and Background Context

**Goals**

- Give changes the amount of process ceremony they actually warrant, automatically or via explicit choice.
- Make specs the living, regenerable source of truth for code, not disposable planning exhaust.
- Make gate enforcement mechanical (scripts/hooks) rather than dependent on an agent choosing to comply.
- Keep the framework usable from any coding agent or plain terminal — no IDE lock-in, no bundled model.

**Background Context**

Existing SDD tools (Kiro, BMAD, Spec-Kit, OpenSpec) each solve part of the "agent needs persistent, structured context across sessions" problem, but none solve the whole thing without a serious tradeoff — see `brief.md` for the full comparison. Waypoint's core bet is that ceremony and enforcement are two separate dials, and every existing tool has them coupled together. Decoupling them (tier controls ceremony; gates control enforcement, independent of tier) is the central design insight this PRD builds from.

`brief.md`'s open question ("should tier classification be automatic or always explicit?") is resolved here toward **explicit**: FR1–FR3 require the user (or agent) to name the tier via the command itself (`new-patch` / `new-feature` / `new-system`). Automatic classification from diff size is deferred to post-MVP once real usage data exists on where the tier boundary should sit — see brief.md's Risks & Open Questions.

`[NOTE FOR PM]` Two tensions worth revisiting as this moves toward implementation, rather than treating as settled: (1) the gate-bypass flag (FR7) is logged but not otherwise restricted — decide if that's sufficient or if repeated bypasses should escalate somehow. *Owner: PM. Trigger: revisit if the bypass rate becomes a noticeable share of commits within the first month of real use.* (2) the boundary between "agent-assisted" and "agent-executed" for `approve` (FR8) assumes agents won't be given shell access broad enough to call the CLI command directly — worth a deliberate look once real agent tooling is wired up, since the enforcement model depends on this boundary holding. *Owner: PM. Trigger: revisit the first time an agent is given direct shell/CLI access rather than being routed through slash-commands or MCP-style tool calls.*

**Change Log**

| Date       | Version | Description                                                                                                                                                                            | Author            |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 2026-08-19 | 0.1     | Initial PRD drafted in planning session                                                                                                                                                | Claude (PM agent) |
| 2026-08-20 | 0.2     | Addressed PRD quality review: added Success Metrics, Non-Goals, Glossary, Assumptions Index; scoped FR5/FR9; added FR12 (tier-classification mechanism); reconciled NFR2 with brief.md | Claude (PM agent) |
| 2026-08-20 | 0.3     | Addressed v0.2 quality review: fixed Epic 4's per-tool-setup claim, softened FR8 to match its enforced documentation-layer scope, removed dangling review reference in Success Metrics, added decision triggers/owners to open tensions, reconciled brief's 4th success metric, tightened soft verbs in NFR6/Story 4.1 AC1, added spec-format-versioning Non-Goal | Claude (PM agent) |
| 2026-08-20 | 0.4     | Addressed v0.3 quality review: pointed brief's 4th success metric to FR9/FR10 as its real evidence, bounded NFR4's "typical repo" with a concrete file/spec-count baseline, enumerated Story 3.4 AC3's default patch-classified paths, added A4 (git-as-sole-VCS) to Technical Assumptions and the Assumptions Index, committed FR10/Story 4.2 to exactly 4 role prompts | Claude (PM agent) |
| 2026-08-20 | 0.5     | Reconciled NFR5's Node.js floor to 22+, matching `architecture.md`'s Tech Stack (a cross-document divergence surfaced by the architecture's own v0.3 quality review) | Claude (PM agent) |
| 2026-08-20 | 0.6     | Added `tasks/**` to Story 3.4 AC3's default patch-classified paths, matching `architecture.md`'s v0.5 fix for a gate/ledger-commit bootstrapping conflict surfaced by the architecture's own quality review | Claude (PM agent) |
| 2026-08-20 | 0.7     | Addressed a `bmad-review` adversarial finding on `epics.md`: reconciled FR6 and the Ledger glossary entry to say `waypoint verify` instead of "the gate script" (stale pre-v0.4 wording architecture.md's redesign had already superseded), and dropped FR9's "(and optionally CLAUDE.md)" hedge now that CLAUDE.md is explicitly out of scope | Claude (PM agent) |
| 2026-08-20 | 0.8     | Sprint-planning readiness gate (CONCERNS) flagged that this PRD's own embedded "Epic Details" section had drifted stale relative to `epics.md` (still described "the gate script" setting task completion, and was missing Story 3.5/Story 1.4 entirely) — replaced it with a pointer to `epics.md` as the single authoritative story-level source, keeping only the epic-goal-level Epic List here | Claude (PM agent) |

## Success Metrics

Carried forward from `brief.md`'s Goals & Success Metrics, reconciled with the NFRs below by splitting the _command-runtime_ cost (NFR2) from the _full human process_ cost (this section). `brief.md`'s fourth metric — "works identically whether driven by Claude Code, Cursor, or a bare CLI invocation, zero agent-specific code paths in the core" — isn't restated here because it describes an architectural property rather than a measurable process outcome. NFR1 (zero model/vendor dependency) and NFR5 (identical OS behavior) are related but don't test it directly — NFR5 checks OS parity, not whether the core branches on which agent is invoking it. The load-bearing evidence for this specific claim is FR9 (a single tool-agnostic `AGENTS.md`, no per-tool variants) and FR10 (plain-markdown role prompts usable by any agent), which structurally rule out agent-specific code paths rather than measuring their absence after the fact.

- **Patch-tier overhead**: end-to-end human time (typing the command, filling the one-line record, committing) stays **under 2 minutes**. NFR2's "~30 seconds" is the CLI's own scaffolding-step runtime, a component of this larger budget, not a competing figure.
- **Feature-tier reviewability**: a Feature-tier spec is reviewable by a human in **under 5 minutes**.
- **Gate coverage**: **100% of merged changes** at Feature tier or above have a corresponding spec delta — this is FR7's target, not just its mechanism.
- **Counter-metric (false positives)**: gate false-positive rate (blocking a commit that didn't actually need a spec delta) stays low enough not to undermine the Patch-tier speed goal — target **under 5%** of Patch-tier-classified commits incorrectly escalated to Feature-tier enforcement. This exists specifically to catch an over-eager gate defeating NFR2.

## Non-Goals

Carried forward explicitly from `brief.md`'s MVP Scope "Out" list, so this PRD is self-contained on scope:

- No web UI or dashboard for MVP.
- No multi-repo or monorepo cross-project orchestration.
- No built-in analytics or telemetry.
- No bundled or required AI model — the framework must remain usable with any agent or none at all.
- No migration tooling for spec/template format changes across Waypoint versions for MVP — the delta/template format is assumed stable pre-1.0.

## Glossary

- **Spec**: a markdown file (with YAML frontmatter) describing a change, at one of three tiers (patch/feature/system).
- **Delta**: an ADDED/MODIFIED/REMOVED-tagged edit appended to an existing spec, used instead of a full rewrite.
- **Tier**: the ceremony level assigned to a change — Patch (no gates), Feature (one approval gate), or System (phased gates).
- **Gate**: the mechanical check (pre-commit hook or CI script) that verifies spec↔code correspondence and ledger integrity, independent of any LLM's cooperation.
- **Ledger**: the per-spec YAML file tracking task status, where `done`/`verified_by_gate` can only be set by `waypoint verify`, never hand-edited.

## Requirements

### Functional

- **FR1**: The CLI shall provide `waypoint new-patch <name>`, creating a minimal delta record with no required approval step.
- **FR2**: The CLI shall provide `waypoint new-feature <name>`, scaffolding a requirements + design + task-list spec from a template, requiring one approval step before implementation tasks can be marked complete.
- **FR3**: The CLI shall provide `waypoint new-system <name>`, scaffolding a full spec set (PRD-style requirements, architecture doc, ADR stubs, phased task list) requiring approval at each phase boundary.
- **FR4**: Specs shall support delta-style edits (ADDED / MODIFIED / REMOVED sections) so an existing spec can be updated without a full rewrite.
- **FR5**: The system shall provide `waypoint check-drift`, comparing the current spec against the actual code and flagging referenced file paths or named symbols (functions/classes referenced by name in the spec) that no longer exist. `[NOTE FOR PM]` **Scope note**: content-level "materially changed" detection (e.g., a referenced function still exists but its behavior/signature has substantially diverged from what the spec describes) is explicitly **deferred to post-MVP** — it requires a defined similarity/change threshold that doesn't yet exist, and shipping it undefined would mean the check either misses real drift or false-positives constantly. MVP ships path/symbol-existence checking only; this FR's wording is narrowed accordingly from the 0.1 draft.
- **FR6**: The system shall maintain a machine-readable task ledger (YAML/JSON) per Feature/System spec, where each task has a status field settable only by `waypoint verify` upon verified completion (linked commit + passing check) — an explicit, human/agent-invoked command, not an automatic hook — never by free-text agent output.
- **FR7**: A gate script (usable as a git pre-commit hook and in CI) shall block a commit/merge if code changed without a corresponding spec delta at Feature tier or above.
- **FR8**: The system shall provide `waypoint approve <spec-id>`, documented as excluded from the set of actions `AGENTS.md` describes for agent use — so it is not part of any agent's normal task-completion flow by convention — recording approval in the spec's frontmatter. This exclusion is enforced at the documentation layer; it does not technically block an agent with direct CLI/shell access from invoking the command itself (see the enforcement-boundary tension flagged in Background Context).
- **FR9**: An `AGENTS.md` file shall be generated at install time, containing tier-selection heuristics, the available CLI commands, and role-prompt locations, in plain markdown any agent can read. `CLAUDE.md` generation is explicitly out of scope for MVP. _(Narrowed from the 0.1 draft: this FR is a claim about the artifact's contents, not a claim about downstream agent behavior — whether an agent actually follows it is a property of that agent, not something Waypoint can guarantee or test for. See Story 4.1's note on optional behavioral verification.)_
- **FR10**: The system shall define 4 role prompts (Planner, Architect, Implementer, Reviewer) as plain markdown files any agent can be pointed to, rather than requiring a bespoke multi-agent runtime.
- **FR11**: The CLI shall provide `waypoint status`, showing open specs, their tier, approval state, and task completion state across the repo.
- **FR12**: The gate script shall classify a changed file's tier using a config-driven mechanism: path patterns declared in `.waypoint/config.yaml` map file globs to a default tier (e.g., `specs/patches/**` and other user-declared patch-classified paths are unenforced; everything else defaults to Feature-tier enforcement). If a changed path matches no declared pattern, the gate **fails closed** — it is treated as Feature-tier and enforcement applies, per `architecture.md`'s Error Handling Strategy. This FR defines the mechanism that `architecture.md` assumes but the 0.1 draft never specified.

### Non-Functional

- **NFR1**: The framework shall have zero required runtime dependency on any specific AI model or vendor.
- **NFR2**: The `waypoint new-patch` command itself shall run in no more than ~30 seconds, as one component of the under-2-minutes total human process budget in Success Metrics above (typing the command, filling the record, and committing make up the rest).
- **NFR3**: All state shall be stored as flat files (markdown/YAML/JSON) in the repo — no external database or server required for MVP.
- **NFR4**: The gate script shall run in under 2 seconds on a repo with up to 2,000 tracked files and up to 50 open specs, to avoid discouraging use in pre-commit hooks.
- **NFR5**: The CLI shall work identically on macOS, Linux, and WSL (Node.js 22+ as the only hard requirement — raised from the 0.4 draft's 20+, since Node 20 reaches end-of-life in April 2026; 22 is the current Maintenance LTS line, per `architecture.md`'s Tech Stack rationale).
- **NFR6**: Installation shall be a single command (`npx waypoint install`) with no manual config required to reach a working setup (default tier-classification patterns pre-populated, per Story 3.4 AC3).

## Technical Assumptions

- **Repository structure**: `[ASSUMPTION: A1]` monorepo for the framework itself (CLI + templates + gate scripts in one npm package).
- **Testing**: `[ASSUMPTION: A2]` unit tests for the gate/drift logic (deterministic, non-LLM code) prioritized over end-to-end agent tests, since the enforcement mechanism is the part that must never silently fail.
- **Language**: `[ASSUMPTION: A3]` Node.js/TypeScript for the CLI, matching the ecosystem this tool has to interoperate with.
- **Version control**: `[ASSUMPTION: A4]` git is the consuming repo's VCS; the gate hook mechanism (FR7, Story 3.1) is git-specific (pre-commit hook, commit-linked task verification).

### Assumptions Index

| ID  | Assumption                              | Confidence | If wrong, changes                                                           |
| --- | --------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| A1  | Monorepo, single npm package            | Medium     | Epic 1 scaffolding structure; distribution story                            |
| A2  | Unit-test priority over e2e/agent tests | High       | Low impact if wrong — additive, not blocking                                |
| A3  | Node.js/TypeScript, not Python or Bash  | Medium     | Epic 1 build entirely; distribution mechanism (npm vs. pip vs. curl-script) |
| A4  | Git is the sole supported VCS           | Medium     | Epic 3's entire gate design (FR7, NFR3, Story 3.1) — a non-git target would need a different enforcement mechanism |

_None of these were explicitly user-confirmed in the planning session — flag any that are wrong before Epic 1 starts, since A1, A3, and A4 in particular are expensive to reverse mid-build._

## Epic List

1. **Epic 1 — Core CLI & Tiering**: scaffolding commands, tier templates, repo conventions.
2. **Epic 2 — Delta Spec Format & Drift Detection**: the spec file format itself and the drift-check command.
3. **Epic 3 — Mechanical Gate Enforcement**: git hook, CI script, task ledger with agent-proof status, human-only approval, and the config-driven tier-classification mechanism the gate relies on.
4. **Epic 4 — Agent Integration Layer**: `AGENTS.md` generation and role prompts — a single tool-agnostic artifact readable by any agent, not per-tool integrations.
5. **Epic 5 — Status & Reporting**: `waypoint status`, human-readable summaries across open specs.

## Epic Details

The detailed, authoritative story-level breakdown (acceptance criteria, technical mechanism, and cross-references to `architecture.md`) lives in `_bmad-output/planning-artifacts/epics.md`, produced via `bmad-create-epics-and-stories` and hardened through a full `bmad-review` pass (adversarial + edge-case-hunter + editorial lenses). This PRD intentionally does not duplicate that content — an earlier draft of this section did, and it drifted stale relative to the architecture redesign (e.g., it still described "the gate script" setting task completion, superseded by `waypoint verify`) before being replaced with this pointer. The Epic List above remains accurate at the epic-goal level; for stories and ACs, see `epics.md`.
