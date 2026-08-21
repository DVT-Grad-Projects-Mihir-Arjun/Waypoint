---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories]
inputDocuments: [docs/prd.md, docs/architecture.md]
reviewApplied: bmad-review 2026-08-20 (adversarial + edge-case-hunter + editorial structure/prose)
---

# Waypoint - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Waypoint, decomposing the requirements from the PRD and Architecture (v0.5, post-redesign) into implementable stories.

## Requirements Inventory

### Functional Requirements

- FR1: The CLI shall provide `waypoint new-patch <name>`, creating a minimal delta record with no required approval step.
- FR2: The CLI shall provide `waypoint new-feature <name>`, scaffolding a requirements + design + task-list spec from a template, requiring one approval step before implementation tasks can be marked complete.
- FR3: The CLI shall provide `waypoint new-system <name>`, scaffolding a full spec set (PRD-style requirements, architecture doc, ADR stubs, phased task list) requiring approval at each phase boundary.
- FR4: Specs shall support delta-style edits (ADDED / MODIFIED / REMOVED sections) so an existing spec can be updated without a full rewrite, via `waypoint update <spec-id>`.
- FR5: The system shall provide `waypoint check-drift`, comparing the current spec against the actual code and flagging referenced file paths or named symbols that no longer exist. Content-level "materially changed" detection is deferred post-MVP; MVP ships path/symbol-existence checking only (backtick-delimited identifiers, word-boundary search, not AST).
- FR6: The system shall maintain a machine-readable task ledger (YAML) per Feature/System spec, where `linked_commit`/`status: done`/`verified_by_gate` are settable only by `waypoint verify <spec-id> <task-id>` (an explicit, human/agent-invoked command — not automatically by any hook), never by free-text agent output.
- FR7: A gate script (usable as a git pre-commit hook and in CI) shall block a commit/merge if code changed without a corresponding spec delta at Feature tier or above.
- FR8: The system shall provide `waypoint approve <spec-id>`, which records approval in the spec's frontmatter and is documented as excluded from the set of actions `AGENTS.md` describes for agent use. This exclusion is enforced at the documentation layer only.
- FR9: An `AGENTS.md` file shall be generated at install time, containing tier-selection heuristics, the available CLI commands, and role-prompt locations, in plain markdown any agent can read. `CLAUDE.md` generation is explicitly out of scope for MVP.
- FR10: The system shall define 4 role prompts (Planner, Architect, Implementer, Reviewer) as plain markdown files any agent can be pointed to.
- FR11: The CLI shall provide `waypoint status`, showing open specs, their tier, approval state, and task completion state across the repo (local ledger state only, no remote-awareness).
- FR12: The gate script shall classify a changed file's tier using a config-driven mechanism (`.waypoint/config.yaml`'s `tiers.patch` glob list); unmatched paths default to Feature tier (fail closed). Tier-classification authority (frontmatter vs. glob, when both apply) is scoped to spec files only — code files are governed purely by the glob mechanism.

### NonFunctional Requirements

- NFR1: The framework shall have zero required runtime dependency on any specific AI model or vendor.
- NFR2: The `waypoint new-patch` command itself shall run in no more than ~30 seconds, as one component of an under-2-minute total human process budget.
- NFR3: All state shall be stored as flat files (markdown/YAML/JSON) in the repo — no external database or server required for MVP.
- NFR4: The gate script (pre-commit spec-delta check specifically) shall run in under 2 seconds on a repo with up to 2,000 tracked files and up to 50 open specs.
- NFR5: The CLI shall work identically on macOS, Linux, and WSL (Node.js 22+ as the only hard requirement).
- NFR6: Installation shall be a single command (`npx waypoint install`) with no manual config required to reach a working setup (default tier-classification patterns pre-populated, including `tasks/**`).

_NFR1, NFR3, and NFR5 are cross-cutting properties satisfied by design across every epic rather than one epic's deliverable; NFR5 (and, alongside it, NFR1) additionally gets explicit, dedicated verification in Story 1.4 rather than being left as an unverified design intention._

### Additional Requirements

- **No starter template** — Architecture confirms this is a greenfield npm CLI package with no framework scaffold to build on (relevant to Epic 1 Story 1.1's baseline).

_Implementation-level detail (module boundaries, the full `.waypoint/config.yaml` schema, versioning policy) lives in `architecture.md` and isn't restated here — only what's needed to write acceptance criteria has been folded into the relevant stories below as footnotes._

### UX Design Requirements

_None — Waypoint is a CLI tool with no UI; no UX design contract exists for this project._

## Epic List

### Epic 1: Core CLI & Tiering

A developer can install Waypoint and create a Patch, Feature, or System spec at the right ceremony level, with the repo scaffolded correctly on first run — and the CLI's cross-platform, vendor-neutral behavior verified from the start, not just assumed.
**FRs covered:** FR1, FR2, FR3, NFR1, NFR2, NFR5, NFR6

### Epic 2: Delta Spec Format & Drift Detection

A developer can evolve an existing spec via a delta instead of a full rewrite, and catch specs that have gone stale against the actual code.
**FRs covered:** FR4, FR5

### Epic 3: Mechanical Gate Enforcement

A developer gets enforcement they can actually trust: code can't land without a spec delta, a task's completion can't be self-reported by an agent, and approval can't be silently self-granted — all backed by mechanical checks, not convention. Technical shape follows architecture.md v0.5: the explicit `waypoint verify` command (not an automatic hook) plus CI's cheap ancestor-check.
**FRs covered:** FR6, FR7, FR8 (command mechanics), FR12, NFR4

### Epic 4: Agent Integration Layer

Any coding agent (or human) can pick up the repo's conventions — tier rules, commands, role prompts — without custom per-tool prompting, and can't accidentally self-approve because `approve` is deliberately left out of what agents are told to do.
**FRs covered:** FR9, FR10, FR8 (AGENTS.md-exclusion clause)

### Epic 5: Status & Reporting

A developer can see, at a glance, the state of every open spec — tier, approval, task completion — without hunting across files.
**FRs covered:** FR11

## Epic 1: Core CLI & Tiering

A developer can install Waypoint and create a Patch, Feature, or System spec at the right ceremony level, with the repo scaffolded correctly on first run — and the CLI's cross-platform, vendor-neutral behavior verified from the start, not just assumed.

### Story 1.1: Install scaffolds the repo structure

As a developer,
I want `waypoint install` to scaffold `/specs`, `/tasks`, `/decisions`, `/roles`, and config/agent files in my repo,
So that I have the base structure without manual setup.

**Acceptance Criteria:**

**Given** an empty repo
**When** I run `waypoint install`
**Then** `/specs/{patches,features,systems}`, `/tasks`, `/decisions`, `/roles`, `AGENTS.md`, and `.waypoint/config.yaml` are created with no errors
**And** the *content* of `AGENTS.md` and the role-prompt files is Epic 4's concern (Stories 4.1/4.2) — this AC only tests that one install command produces all of these paths

**Given** any of these paths already exists (not only `/specs`)
**When** I run `waypoint install`
**Then** existing content under that path is preserved, not overwritten

**Given** a path like `/specs` or `/tasks` already exists as a plain file rather than a directory
**When** I run `waypoint install`
**Then** it errors clearly instead of failing on a raw filesystem error

**Given** two `waypoint install` invocations run concurrently in the same repo
**When** both attempt to write the scaffold
**Then** writes are serialized, or the second is a safe no-op — no partial or corrupted scaffold results

**Given** a fresh install
**When** `.waypoint/config.yaml` is generated
**Then** it pre-populates the default patch-classified globs `specs/patches/**`, `docs/**`, root `*.md`, and `tasks/**`

**Given** a fresh install
**When** `.gitignore` is inspected
**Then** `.waypoint/.gate-state/` is present as an ignored path

_Why `tasks/**` is in the patch-classified list, not just the other three: without it, `waypoint verify`'s own housekeeping commit (Story 3.3) would be classified Feature tier with no spec delta, and the gate would block it — see architecture.md's Data Models → `.waypoint/config.yaml` note._

_Git hook installation happens only via this explicit command — never an automatic `npm postinstall` side effect — so the hook stays something the user consciously ran, not a surprise._

### Story 1.2: Patch-tier spec creation

As a developer,
I want `waypoint new-patch <name>` to create a minimal spec file with no approval requirement,
So that trivial changes stay fast.

**Acceptance Criteria:**

**Given** a repo where `waypoint install` has never been run
**When** I run `waypoint new-patch <name>`
**Then** it errors, telling the user to run install first

**Given** an installed repo
**When** I run `waypoint new-patch <name>`
**Then** a single markdown file is created under `/specs/patches/` from a lightweight template

**Given** the created patch spec
**When** I inspect it
**Then** no task-ledger or approval fields are present or required

**Given** `<name>` collides with an existing spec, at any tier
**When** I run `waypoint new-patch <name>`
**Then** the command errors instead of overwriting the existing spec

**Given** `<name>` is empty, missing, or contains path-traversal or invalid filesystem characters
**When** I run the command
**Then** it errors with a validation message before touching the filesystem

**Given** the command completes
**When** its own runtime is measured
**Then** it finishes in under 30 seconds on a reference machine

### Story 1.3: Feature and System-tier spec scaffolding

As a developer,
I want `waypoint new-feature <name>` and `waypoint new-system <name>` to scaffold their respective templates with the right sections pre-filled,
So that I get the right ceremony level for bigger changes.

**Acceptance Criteria:**

**Given** a repo where `waypoint install` has never been run
**When** I run `waypoint new-feature <name>` or `waypoint new-system <name>`
**Then** it errors, telling the user to run install first

**Given** an installed repo
**When** I run `waypoint new-feature <name>`
**Then** a spec is created with requirements, design, and task-list sections
**And** a matching ledger file is created with all tasks `pending`

**Given** an installed repo
**When** I run `waypoint new-system <name>`
**Then** a spec set is created with PRD-style requirements, an architecture stub, ADR stubs, and phased tasks

**Given** `<name>` collides with an existing spec, at any tier
**When** either command runs
**Then** it errors instead of overwriting the existing spec

**Given** `<name>` is empty, missing, or contains path-traversal or invalid filesystem characters
**When** either command runs
**Then** it errors with a validation message before touching the filesystem

**Given** either command completes
**When** I inspect the spec's frontmatter
**Then** `status` is `draft` and `tier` matches the command used

### Story 1.4: Cross-platform and vendor-neutrality verification

As a developer,
I want the CLI's cross-platform behavior and vendor neutrality to be continuously verified,
So that Waypoint's core "no lock-in" promise is a tested guarantee, not just a design intention.

**Acceptance Criteria:**

**Given** the CLI's integration test suite
**When** it runs in CI
**Then** it runs across `ubuntu-latest`, `macos-latest`, and `windows-latest` (Git Bash as an accepted WSL proxy, since GitHub-hosted runners have no native WSL image), covering hook installation and the gate script's execution path

**Given** a test failing on only one matrix leg
**When** results are reported
**Then** it's treated as an NFR5 regression, not a flaky test to retry past

**Given** the core CLI's normal operation (`install`, `new-*`, `update`, `verify`, `approve`, `check-drift`, `status`, `gate`)
**When** any of these run
**Then** no outbound network call to any AI model or vendor API is made — a negative test asserts this directly, verifying NFR1

## Epic 2: Delta Spec Format & Drift Detection

A developer can evolve an existing spec via a delta instead of a full rewrite, and catch specs that have gone stale against the actual code.

### Story 2.1: Update spec via delta

As a developer,
I want to update an existing spec using `waypoint update`, appending ADDED/MODIFIED/REMOVED sections,
So that I don't have to rewrite the whole document for a small change.

**Acceptance Criteria:**

**Given** an existing spec
**When** I run `waypoint update <spec-id>`
**Then** a scaffolded `## Delta — <date>` heading with ADDED/MODIFIED/REMOVED subsections is appended to the spec's markdown body

**Given** `<spec-id>` doesn't exist
**When** I run `waypoint update`
**Then** it errors naming the missing spec instead of creating one

**Given** `<spec-id>` is a Patch-tier spec
**When** I run `waypoint update`
**Then** it errors — Patch-tier specs have no ledger to sync new requirements into, and deltas at this tier aren't supported for MVP

**Given** a second delta is appended to the same spec on the same calendar date
**When** it's saved
**Then** the heading is disambiguated with a sequence suffix (e.g. `## Delta — <date> (2)`) so headings never collide

**Given** I fill in the delta's ADDED section with a new requirement
**When** the delta is saved
**Then** a new `pending` task row is appended to the spec's ledger for that requirement
**And** no existing ledger rows are rewritten

**Given** a delta's MODIFIED or REMOVED subsection is filled in
**When** the delta is saved
**Then** no ledger rows are automatically added, changed, or removed — only ADDED entries sync to the ledger; reconciling MODIFIED/REMOVED requirements against existing tasks is a manual, human/agent judgment call for MVP

**Given** a delta that only clarifies wording (no new requirement)
**When** it's saved
**Then** no new ledger rows are added

**Given** the target spec's `status` is `approved`
**When** a delta is appended
**Then** `status` is left unchanged — appending a delta never silently reverts or requires re-approval

### Story 2.2: check-drift detects stale specs

As a developer,
I want `waypoint check-drift` to flag specs referencing code paths or named symbols that no longer exist,
So that stale specs get caught before they mislead an agent.

**Acceptance Criteria:**

**Given** a spec referencing a file path
**When** I run `waypoint check-drift`
**Then** the command flags that path if it no longer exists in the repo

**Given** a spec referencing a backtick-delimited symbol (e.g. `` `refreshToken()` ``)
**When** I run `waypoint check-drift`
**Then** the command performs a repo-wide word-boundary search and flags the symbol if no match is found

**Given** drift is found
**When** the command exits
**Then** it exits non-zero, suitable for CI use

**Given** no drift is found across any spec
**When** the command exits
**Then** it exits zero

**Given** the repo has zero specs, or a spec has no path/symbol references at all
**When** I run `waypoint check-drift`
**Then** it reports nothing-to-check rather than erroring

**Given** a symbol's behavior has changed but the symbol still exists
**When** I run `waypoint check-drift`
**Then** this is explicitly out of scope for MVP and not flagged (FR5's deferred "materially changed" detection)

## Epic 3: Mechanical Gate Enforcement

A developer gets enforcement they can actually trust: code can't land without a spec delta, a task's completion can't be self-reported by an agent, and approval can't be silently self-granted — all backed by mechanical checks, not convention. Story order here follows dependency (classification before the gate that consumes it, gate/ledger before CI's re-check of both), not the PRD's original 3.1–3.4 sequence.

### Story 3.1: Tier classification via config-driven globs

As a developer,
I want the gate to classify a changed file's tier from config-declared path patterns, defaulting to Feature tier when no pattern matches,
So that ambiguous changes never slip through unenforced by accident.

**Acceptance Criteria:**

**Given** `.waypoint/config.yaml`'s `tiers.patch` glob list
**When** a changed file's path matches one of those globs
**Then** the gate treats it as patch tier (unenforced)

**Given** a changed file's path matches no declared glob
**When** the gate evaluates it
**Then** it defaults to Feature-tier enforcement
**And** this is logged clearly, not a silent pass-through

**Given** `.waypoint/config.yaml` is missing, empty, or contains a malformed/unparseable pattern
**When** the gate runs
**Then** every changed path is treated as Feature tier
**And** a distinct "config error" message is emitted, not a per-file ambiguity message

**Given** a changed path is a deletion or a rename
**When** the gate classifies it
**Then** a deletion is classified by its (now-removed) path and a rename by its new path — deleting or renaming Feature/System-tier code is not a way to bypass classification

**Given** a spec file whose frontmatter `tier` differs from its own path's glob classification
**When** the gate evaluates that spec file specifically
**Then** the spec's frontmatter tier wins
**And** this rule does not extend to ordinary code files

_System tier gets the same gate-level enforcement as Feature tier (a single enforced/unenforced distinction) — its extra rigor (phased approval, ADRs) is a spec/approval-workflow concept, handled entirely by repeated `waypoint approve` calls at phase boundaries (Story 3.4), not something this classification mechanism needs to know about._

### Story 3.2: Pre-commit gate blocks missing spec deltas

As a developer,
I want a pre-commit hook that blocks commits changing Feature/System-tier code without a corresponding spec delta,
So that enforcement doesn't depend on remembering to update the spec.

**Acceptance Criteria:**

**Given** a staged change to a Feature/System-tier-classified file with no spec delta in the same commit
**When** I attempt to commit
**Then** the pre-commit hook calls `gate()` and blocks the commit with a clear message naming the missing delta

**Given** a staged change is a deletion of a Feature/System-tier file with no spec delta
**When** I attempt to commit
**Then** the same block rule applies — deleting enforced code isn't a way to bypass the gate

**Given** a staged change to a patch-classified path
**When** I attempt to commit
**Then** the pre-commit hook does not block the commit

**Given** the very first commit in a repo, a merge commit, or a `git commit --amend`
**When** the gate computes its diff
**Then** the comparison base is well-defined in each case (the empty tree for the first commit, the union of both parents for a merge, the amended commit's original parent for `--amend`) — never an error on a missing baseline

**Given** a repo with up to 2,000 tracked files and 50 open specs
**When** the gate evaluates the staged file list
**Then** it completes in under 2 seconds

**Given** a commit made with `git commit --no-verify` (bypassing this hook locally)
**When** that change later reaches a PR
**Then** Story 3.5's CI check still evaluates it over the full PR diff — a local bypass only defers enforcement to CI, never escapes it; if a repo admin merges anyway despite a failing CI check, that override is recorded in the git host's own audit trail, not a Waypoint-specific log

### Story 3.3: Task ledger with verify-only completion

As a developer,
I want a task ledger where a task's `done` status can only be set by an explicit `waypoint verify` command after checking a linked commit passes,
So that an agent can't mark its own work complete without verification.

**Acceptance Criteria:**

**Given** a task in a ledger
**When** I run `waypoint verify <spec-id> <task-id>`
**Then** it runs `check_command` in the current working tree, and on success writes `linked_commit` (current HEAD), `status: done`, `verified_by_gate: true`, and the task's `.gate-state` hash as one atomic update, and commits only the ledger file (isolated staging — any other files already staged for a different purpose are left untouched and uncommitted)

**Given** `check_command` fails
**When** `waypoint verify` runs
**Then** it reports the failure and writes nothing

**Given** the ledger-only commit step itself fails for any reason
**When** that happens
**Then** `waypoint verify` rolls back its in-memory writes, leaving the ledger and `.gate-state` file exactly as found — the `.gate-state` hash is persisted only after the ledger commit succeeds, so a crash between the two steps never leaves an orphaned hash for a commit that never landed

**Given** no commit exists yet in the repo (empty repo, no HEAD)
**When** `waypoint verify` runs
**Then** it errors instead of recording a null or invalid `linked_commit`

**Given** `<spec-id>` or `<task-id>` doesn't exist
**When** `waypoint verify` runs
**Then** it errors naming the missing target

**Given** a task is already `done` with a valid `.gate-state` hash
**When** `waypoint verify` is run again for that task
**Then** it is a no-op

**Given** a task is marked `done` but its `.gate-state` hash is invalid or missing (tampered)
**When** `waypoint verify` is run again for that task
**Then** it refuses to silently re-verify — it reports the corruption rather than quietly overwriting the tampered state; remediation beyond detection is out of scope for MVP

**Given** two `waypoint verify` invocations run concurrently against the same or sibling tasks in one spec
**When** both attempt to write
**Then** writes are serialized (e.g. via a lock file) so neither corrupts the ledger or the `.gate-state` file

**Given** multiple tasks in one spec's `.gate-state` file
**When** `waypoint verify` writes a new task's hash
**Then** it's a per-task merge into the existing file — other tasks' previously stored hashes are preserved, never overwritten by a whole-file replace

**Given** a task's `status`/`verified_by_gate`/`linked_commit` fields are hand-edited directly, or a `done` task has no stored hash at all
**When** any subsequent local `waypoint` command runs
**Then** the hash mismatch (or missing hash) is detected and flagged as corrupted, and `waypoint status`/`waypoint verify` both surface a `CORRUPTED` flag for that task rather than treating it as a normal `done` or `pending` state

_Known limitation: `check_command` is global, not scoped per task, so `waypoint verify` can only confirm "the whole suite passes right now" — not that this specific task's implementation is what makes it pass. An agent could technically run `verify` against an unimplemented task if the suite happens to be green for unrelated reasons; per-task test isolation is out of scope for MVP._

### Story 3.4: Human-only approval

As a developer,
I want `waypoint approve <spec-id>` restricted to a human-run command outside the agent's normal task loop,
So that approval gates can't be self-granted.

**Acceptance Criteria:**

**Given** a Feature/System-tier spec in `draft` status
**When** a human runs `waypoint approve <spec-id>`
**Then** the spec's frontmatter `status` becomes `approved`, recorded with a timestamp and (optionally) a name/identity field

**Given** `<spec-id>` doesn't exist
**When** `waypoint approve` runs
**Then** it errors instead of writing frontmatter to nothing

**Given** `<spec-id>` is a Patch-tier spec
**When** `waypoint approve` runs
**Then** it errors — Patch tier has no approval field or concept

**Given** a spec is already `approved`
**When** `waypoint approve` is run again for it
**Then** it is a no-op (reports already-approved) rather than silently rewriting the existing timestamp/identity

**Given** a System-tier spec with multiple phase boundaries
**When** a human runs `waypoint approve <spec-id>` at each boundary
**Then** each phase's approval is recorded distinctly (a per-phase entry, not a single spec-wide flag), so which phase was approved, and when, is unambiguous

**Given** `approve`'s enforcement boundary
**When** I check what it actually guarantees
**Then** it's documented as a convention (not exposed to agents in `AGENTS.md`), not a technical block against an agent with direct shell access

**Known interim gap**: this story builds `approve` itself, but the actual "not exposed to agents" exclusion only exists once Epic 4 Story 4.1 generates `AGENTS.md` with `approve` left out of its action list. Between finishing this story and shipping Story 4.1, `approve` is technically callable by an agent with no documentation-layer discouragement at all — a known, time-boxed gap, not a silent one. Don't ship an interim `AGENTS.md` in this story to paper over it; Epic 4 owns that artifact.

### Story 3.5: CI enforces the same gate, plus done-claim correctness

As a developer,
I want CI to independently re-check both the spec-delta rule and every completed task's linkage,
So that enforcement holds even if a contributor's local hooks were skipped or missing.

**Acceptance Criteria:**

**Given** a PR
**When** `npx waypoint gate --ci` runs
**Then** it calls `gate()` over the full PR diff and fails the build if any Feature/System-tier change lacks a spec delta

**Given** a PR diff against a repo with up to 2,000 tracked files and 50 open specs
**When** `npx waypoint gate --ci` runs
**Then** it completes within a defined, CI-appropriate budget (e.g. under 60 seconds) — looser than the pre-commit path's 2 seconds since it evaluates the full diff, but still bounded, never open-ended

**Given** every ledger file in the repo, enumerated by globbing `tasks/**/*.ledger.yaml` from the repo root (the same mechanism named in architecture.md — not left for the implementer to invent)
**When** CI walks tasks claiming `done` as of the PR's HEAD
**Then** it confirms each one's `linked_commit` is a real commit and an ancestor of HEAD via `git merge-base --is-ancestor`, failing the build with a clear message naming the task if not

**Given** a task claims `done` but its `linked_commit` field is blank or missing entirely (not fabricated, just absent)
**When** CI's done-claim check runs
**Then** it fails the build the same as an unresolvable or fabricated commit — a missing field is not treated differently from an invalid one

**Given** a ledger file that is malformed or unparseable YAML
**When** CI walks it
**Then** the build fails with a clear per-file message naming that ledger file, rather than crashing uninformatively or silently skipping it

**Given** a task hand-edited directly to `status: done` with a fabricated or unrelated `linked_commit`, on a machine where `waypoint verify` never ran (so no local `.gate-state` hash exists to catch it)
**When** CI runs its done-claim check
**Then** the build fails, naming the specific task — this is FR6's actual "an agent can't self-report completion" guarantee proven at the story level, not left implicit in the architecture doc alone

**Given** CI's checkout
**When** the done-claim check runs
**Then** it requires a full, non-shallow checkout — a shallow clone must not misreport a legitimately-verified task as unresolvable

**Given** CI completes both checks
**When** it reports its result
**Then** it has written nothing to the ledger, the gate-state file, or anywhere else
**And** it needs no elevated permissions, working identically on any CI provider and for fork-based PRs

## Epic 4: Agent Integration Layer

Any coding agent (or human) can pick up the repo's conventions — tier rules, commands, role prompts — without custom per-tool prompting, and can't accidentally self-approve because `approve` is deliberately left out of what agents are told to do.

### Story 4.1: AGENTS.md generation

As a developer,
I want an `AGENTS.md` generated at install time explaining tier rules and available commands,
So that any agent I point at the repo has what it needs to select the correct process.

**Acceptance Criteria:**

**Given** `waypoint install` runs
**When** `AGENTS.md` is generated
**Then** it contains a section each for tier-selection heuristics, the available CLI commands, and role-prompt locations

**Given** `AGENTS.md`'s content
**When** I inspect it
**Then** it's plain markdown with no tool-specific syntax, readable by Claude Code, Cursor, or a human

**Given** `AGENTS.md`'s action list
**When** I check whether `approve` is included
**Then** it is not — deliberately excluded from the set of actions described to agents

**Given** install runs
**When** I check for `CLAUDE.md`
**Then** it is not generated — out of scope for MVP

**Given** `AGENTS.md` already exists and has been user-customized
**When** `waypoint install` runs again
**Then** the existing file is preserved, not regenerated over — same preserve-on-reinstall rule as Story 1.1's scaffolded paths

### Story 4.2: Role prompts

As a developer,
I want 4 role-prompt files (Planner, Architect, Implementer, Reviewer) I can point any agent at,
So that I get role separation without a bespoke multi-agent runtime.

**Acceptance Criteria:**

**Given** `waypoint install` runs
**When** role prompts are generated
**Then** exactly 4 standalone markdown files (Planner, Architect, Implementer, Reviewer) are created, each usable as a system prompt or slash-command body

**Given** a role prompt's content
**When** I inspect it
**Then** it references the tier templates and gate commands so behavior stays consistent across roles, and none of the 4 prompts instruct or reference invoking `approve` — the exclusion holds in role-prompt content, not just in `AGENTS.md`'s action list

**Given** any role-prompt file already exists and has been user-customized
**When** `waypoint install` runs again
**Then** the existing file is preserved, not regenerated over

## Epic 5: Status & Reporting

A developer can see, at a glance, the state of every open spec — tier, approval, task completion — without hunting across files.

### Story 5.1: waypoint status

As a developer,
I want `waypoint status` to show all open specs, their tier, approval state, and task completion,
So that I have one place to check where everything stands.

**Acceptance Criteria:**

**Given** open specs across the repo
**When** I run `waypoint status`
**Then** output is readable in a terminal (table or list format) and includes counts by tier

**Given** zero open specs
**When** I run `waypoint status`
**Then** it prints an explicit empty-state message rather than blank output

**Given** a Patch-tier spec listed alongside Feature/System specs
**When** `waypoint status` renders it
**Then** its row shows approval/task-completion fields as not applicable, rather than blank or erroring

**Given** a Feature/System spec with unapproved status and in-progress tasks
**When** I run `waypoint status`
**Then** it flags that spec explicitly

**Given** a task flagged `CORRUPTED` per Story 3.3
**When** I run `waypoint status`
**Then** that task is shown with a distinct corruption indicator, never displayed as plain `done` or `pending`

**Given** a Feature/System spec that is fully approved with every task `done`
**When** I run `waypoint status`
**Then** it is excluded from the "open specs" list — a spec closes (leaves the open list) exactly when approved and 100% done

**Given** status reads the local ledger
**When** it runs
**Then** it reflects only what's on disk locally, with no remote-awareness of anyone else's unpushed `waypoint verify` commits
