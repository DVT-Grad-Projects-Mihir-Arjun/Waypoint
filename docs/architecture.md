# Architecture Document: Waypoint

## Introduction

This document defines the technical architecture for Waypoint, the tiered spec-driven development framework described in `brief.md` and `prd.md`. It covers the CLI, file formats, gate enforcement mechanism, and integration surface for coding agents.

**Starter template**: none — this is a greenfield npm CLI package, not built on an existing framework's scaffold.

**Change Log**

| Date       | Version | Description                                                                                                                                                                                                                | Author              |
| ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 2026-08-19 | 0.1     | Initial architecture drafted in planning session                                                                                                                                                                          | Claude (Architect agent) |
| 2026-08-20 | 0.2     | Addressed architecture quality review: added the delta-edit capability (FR4/Epic 2) end to end; pinned commit-to-task linkage, tier-classification authority, `.waypoint/config.yaml` schema, ledger corruption detection, and the `@waypoint/core/gate` function contract; raised the Node.js floor; corrected the Spec-Kit claim; added cross-platform test coverage and hook-install trust notes | Claude (Architect agent) |
| 2026-08-20 | 0.3     | Addressed v0.2 quality review: made the post-commit hook (not hand-edit) the sole writer of `linked_commit`, closing the timing paradox; added a pinned `verifyTask()` contract in `ledger/` shared by post-commit and CI, with an explicit CI push-back mechanism and idempotent never-overwrite-already-verified reconciliation rule; made bypass enforcement a CI-side check rather than an unenforceable trailer convention; pinned the `Waypoint-Task:` trailer grammar; wired `waypoint update` into ledger task sync; scoped the tier-authority "stricter of two" rule to spec files only and defined System tier's gate-level behavior; clarified the WSL test-matrix proxy, async check-command execution, and package versioning policy | Claude (Architect agent) |
| 2026-08-20 | 0.4     | **Redesigned commit-to-task linkage after three rounds of quality review kept surfacing comparable-severity issues in the same subsystem.** Replaced the automatic pre-commit/post-commit-hook linkage, async execution, `Waypoint-Task:` trailer, and CI push-back mechanism with a single explicit `waypoint verify <spec-id> <task-id>` command (synchronous, human/agent-invoked, matching `approve`'s existing pattern) that writes the ledger and commits its own change. CI is now a pure checker — it re-runs `check_command` against the ledger's recorded `linked_commit` and fails the build on mismatch, but never writes or pushes anything. This eliminates the gate-state gitignore/CI-commit contradiction, the fork-PR token gap, the branch-protection deadlock, the review-dismissal-on-push issue, the local/CI write race, the trailer-grammar and spec-id-encoding gaps, and the undeclared GitHub-specific assumption — and removes Waypoint's custom bypass-logging mechanism in favor of the git host's own protected-branch override audit trail, which already satisfies "logged, not silent" natively. Net effect: CI's role (`npx waypoint gate --ci`) needs no special permissions and works identically on any CI provider, strengthening rather than compromising the vendor-neutrality thesis | Claude (Architect agent) |
| 2026-08-20 | 0.5     | Closed the round-4 review's findings on the redesign itself: classified `tasks/**` as patch-tier so `waypoint verify`'s own housekeeping commit no longer collides with the gate it must pass (also reconciled in `prd.md` Story 3.4 AC3); replaced CI's per-task `check_command` re-run with a cheap git-ancestor check on `linked_commit` (no isolation, no shallow-clone/squash-merge ambiguity, no unbounded cost — requires a full, non-shallow CI checkout, now stated as a requirement); pinned `waypoint verify`'s commit to isolated staging (`--only`) with an all-or-nothing rollback contract; defined re-verifying an already-`done` task as a no-op by default; stated the bypass-logging guarantee's PR/branch-protection precondition explicitly, with a recommended solo-workflow fallback; pinned `.gate-state`'s per-task merge-write semantics; documented `linked_commit`'s and the global `check_command`'s already-accepted guarantee limits explicitly rather than leaving them implicit | Claude (Architect agent) |
| 2026-08-21 | 0.6     | Fixed a cross-document inconsistency caught during Story 2.1 planning: "Ledger sync on delta" said `ADDED`/`MODIFIED` content both trigger new ledger rows, contradicting the already-reviewed `epics.md` Story 2.1 AC, which is explicit that only `ADDED` entries ever sync — `MODIFIED`/`REMOVED` reconciliation is a manual judgment call for MVP. Corrected this section to match the AC | Claude (Architect agent) |
| 2026-08-24 | 0.7     | Two corrections surfaced during Story 3.2 planning by empirically testing git's actual hook behavior (not assumed from docs): (1) git does **not** invoke `pre-commit` for a conflict-free automatic merge — it invokes the separate `pre-merge-commit` hook (added in git 2.24) instead; `waypoint install` must write both hook files, not just one, for the merge AC to actually fire. (2) `git commit --amend` gives the `pre-commit` hook no reliable, portable signal that it's mid-amend (no hook arguments, no distinguishing environment variable, confirmed by direct testing) — so "the amended commit's original parent" as a diff base is not achievable without a fragile, platform-specific heuristic (e.g. parent-process command-line inspection), which would conflict with Story 1.4's cross-platform bar. Resolved (user-approved) by treating every commit type uniformly: diff base is `HEAD` when it resolves, else the empty tree (git already handles the missing-`HEAD` first-commit case transparently, confirmed by testing) — amend gets the same base as an ordinary commit, a documented fail-closed limitation rather than a silent gap. Also switched the Git integration choice from "Husky is the MVP default" to a hand-rolled hook script written directly by `waypoint install` (no new dependency, no `prepare`-script reliance on the consuming repo's npm lifecycle, consistent with Story 3.1's precedent of hand-rolling over adding a dependency) — see the updated Tech Stack row |
| 2026-08-24 | 0.8     | Known limitation surfaced during Story 3.5's review (user-confirmed: document and defer, not fix now): the done-claim check's full, repo-wide ledger sweep (required by epics.md's own Story 3.5 AC) is fundamentally incompatible with sustained squash-merge use once any ledger accumulates a pre-squash `linked_commit` — that task's ancestor check then fails permanently on every subsequent, unrelated PR, since squash-merge rewrites the target branch's history out from under it. The earlier v0.5 "squash-merge is a non-issue" note only reasoned about the task's *own* PR being checked pre-merge, not this cross-PR interaction with the full-repo sweep. See Core Workflows → Feature-tier flow, step 7 for the full caveat | Claude (Architect agent) |
| 2026-08-25 | 0.9     | Batch 2 fixes from the epic-1-5 MVP retrospective's follow-up review: corrected every *live* `gate --ci` mention throughout this document's body prose (Core Workflows step 7, the "Bypass, reframed" section, Error Handling Strategy, Test Strategy) to `gate --ci --base <ref>`, reflecting Story 3.5's actual CLI signature — but deliberately left this changelog's own historical `0.4` entry worded as it was originally written, since a changelog row documents what was decided at that point in time (before `--base <ref>` existed), not current behavior; an earlier pass in this same retrospective had mutated that historical row in place, which this entry corrects. Also corrected Core Workflows step 8's spec-closing-criterion sentence to state the real, complete condition matching `packages/core/src/status.ts`'s actual code: an `approved` spec with zero tracked tasks is not closed (a `taskStates.length > 0` guard), not just "approved and every task done" | Claude (Architect agent) |

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
| Runtime | Node.js 22+ | Node 20 reaches end-of-life April 2026; 22 is the current Maintenance LTS line (24 is Active LTS but newer — 22 is the safer floor for a tool meant to run in other people's CI environments) |
| CLI framework | Commander.js | Same choice BMAD uses (`commander ^14.0.0`); still the most-downloaded Node CLI framework |
| Config format | YAML | Human-editable, matches task-ledger and frontmatter needs |
| Spec format | Markdown + YAML frontmatter | Readable by humans and any LLM without special parsing |
| Testing | Vitest | Fast, TypeScript-native, current standard for new TS/JS projects |
| Distribution | npm package (`npx waypoint`) | Zero-install-friction, matches expectations from this tool category |
| Git integration | Hand-rolled hook scripts, written directly by `waypoint install` | `waypoint install` writes `.git/hooks/pre-commit` and `.git/hooks/pre-merge-commit` (both required — git only invokes `pre-commit` when a merge needs manual conflict resolution; a clean automatic merge invokes `pre-merge-commit` instead, confirmed by direct testing) as plain shell scripts that call `npx waypoint gate`. No new npm dependency, and no reliance on the consuming repo's `prepare`-script/npm-lifecycle wiring actually running — a real risk for a tool meant to work in any repo, not just ones with conventional Node tooling. Supersedes the earlier "Husky is the MVP default" choice (v0.1–0.6); see the v0.7 change-log entry |

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

**Field ownership** (who may write each field — resolves which edits are legitimate vs. a corruption/tamper flag):

| Field | Written by | Notes |
|---|---|---|
| `id`, `description` | `waypoint new-feature`/`new-system` at scaffold time, from the spec's task list; also `waypoint update` (see Delta-update flow) | Fixed once written; a delta that adds new requirements appends new task rows via the same sync logic, never rewrites existing rows |
| `status: pending` → `in-progress` | Hand-edited by a human or agent | Declarative "I'm working on this" marker, not a verified fact — freely editable, not gate-protected |
| `linked_commit`, `status: done`, `verified_by_gate` | **Only** `waypoint verify <spec-id> <task-id>` (see Components → CLI and Core Workflows → Feature-tier flow) | A human/agent never hand-edits these three fields — they run `waypoint verify` when they believe a task is complete, and the command itself decides, mechanically, whether to write them. Protected by the gate-state hash below once written; a hand-edit to any of the three is detected and flagged. Re-running `waypoint verify` on a task that's already `done` with a valid stored hash is a **no-op**: it reports the task as already verified and makes no further write or commit — it never silently re-verifies against a new `HEAD` or overwrites `linked_commit` |

**Ledger integrity check** (resolves the "how is corruption actually detected" gap): `waypoint verify` maintains a sidecar file per spec, `.waypoint/.gate-state/<spec-id>.json`, owned entirely by `@waypoint/core/ledger`, **local to each machine and gitignored** (see Infrastructure below) — this file exists purely to catch a hand-edit on the machine that ran the verification; it has no role in CI and is never expected to exist on a fresh checkout, so there is no contradiction to reconcile:
```json
{
  "t1": "sha256:9f2c...",
  "t2": "sha256:4a1e..."
}
```
Each hash is `sha256(canonicalJSON({ id, status, verified_by_gate, linked_commit }))` for that task, computed and stored by `waypoint verify` at the moment it legitimately sets `status: done`. Any subsequent local run of `waypoint` in that same clone recomputes the hash from the ledger's current values and compares it to the stored one; a mismatch means the ledger was hand-edited after `waypoint verify` wrote it, and it's flagged as corrupted rather than trusted. **A task the ledger claims is `done` with *no* stored hash at all is flagged exactly the same way** — a missing hash for a `done` task means `waypoint verify` never actually ran in this clone, which is just as much a red flag as a mismatched one. Tasks still `pending`/`in-progress` have no stored hash and are correctly never checked this way, since those fields are legitimately hand-editable per the ownership table above. Writes to this file are **per-task merges**, never a whole-file replacement — writing task `t1`'s hash must preserve any existing entry for `t2` (and every other task) already in the file, so verifying one task never silently erases another's corruption protection. CI's own correctness check (Core Workflows → Feature-tier flow, step 7) doesn't use this file at all — it works a different way, described there, that needs no local state and no full test-suite re-run.

**`.waypoint/config.yaml`** (the tier-classification and verification config referenced by FR12/Story 3.4 and Infrastructure below):
```yaml
check_command: "npm test"    # global for MVP — no per-task override (see Infrastructure)
tiers:
  patch:                      # glob patterns classified as Patch tier (unenforced by the gate)
    - "specs/patches/**"
    - "docs/**"
    - "*.md"                  # root-level markdown only, per Story 3.4 AC3
    - "tasks/**"               # ledger files — see below for why this is required, not incidental
  # everything not matched above defaults to Feature-tier enforcement (fail-closed, see Error Handling Strategy)
```
The `tiers` key is tier-keyed (not a flat patch-only list) so a future tier beyond patch/feature could add its own glob list without a schema change, even though only `patch` is populated for MVP.

**`tasks/**` is patch-classified deliberately, not incidentally**: `waypoint verify`'s own commit (Components → Gate Script & Verification) touches only a ledger file. If `tasks/**` weren't patch-classified, that commit would be a Feature-tier change with no spec delta — exactly what `gate()` is defined to block — and `verify` could never complete its own housekeeping commit on any Feature/System-tier spec. Classifying the ledger path as patch-tier resolves this the same way every other tier decision is made (FR12's config-driven mechanism), with no special-case exemption inside `gate()` itself. This pattern is enforced (Story 3.4 AC1) so `waypoint install` always includes `tasks/**` in the generated default, not just as a suggestion. There is deliberately no `system` glob bucket: at the `gate()` level, System tier gets the **same enforcement as Feature** (a changed path is either patch-classified/unenforced, or it isn't — a single binary distinction). System's extra rigor — phased approval, ADRs — is a spec/approval-workflow concept (repeated `waypoint approve` calls across the System spec's phase boundaries, per FR3) layered on top of, not inside, `gate()`'s file-level check; `GateInput`/`GateResult` never need phase-awareness as a result. A missing, unparseable, or empty `config.yaml` is handled explicitly — see Error Handling Strategy.

**Delta block** (FR4/Epic 2 Story 2.1 — an ADDED/MODIFIED/REMOVED edit appended to an existing spec, instead of a full rewrite):
```markdown
## Delta — 2026-08-20

### ADDED
- FR13: ...

### MODIFIED
- FR7: (previous wording) → (new wording)

### REMOVED
- FR3 (superseded by FR13)
```
Delta blocks are appended under a `## Delta — <date>` heading directly in the spec's markdown body (below its main content) — no separate file, so the spec stays the single source of truth and its full history is visible in one document. `waypoint update <spec-id>` (see Components and Core Workflows below) scaffolds this heading and the three subsections; the human or agent fills in the actual content.

**Ledger sync on delta** (closes the gap between FR4 and FR6 — a delta must be able to introduce gate-tracked work, not just prose): after the delta's `ADDED` content is filled in, `waypoint update` diffs it against the ledger's existing task rows and appends a new `pending` task row for each newly-introduced requirement, using the same "append-only, never rewrite existing rows" rule the ownership table already states for scaffold time. `MODIFIED`/`REMOVED` entries never automatically touch the ledger — reconciling them against existing tasks is a manual human/agent judgment call for MVP. A delta that only clarifies wording (no new requirement) adds no ledger rows.

## Components

**1. CLI (`waypoint`)**
Subcommands: `install`, `new-patch`, `new-feature`, `new-system`, `update`, `verify`, `check-drift`, `approve`, `status`. Thin layer over the core library — no business logic lives in the CLI itself, so hook/CI/CLI all share behavior.

- `waypoint update <spec-id>` (FR4/Epic 2 Story 2.1): appends a scaffolded `## Delta — <date>` block (see Data Models above) to the named spec, opens it for editing, and — once filled in — syncs any newly-introduced requirements into the ledger as new `pending` task rows (see Data Models → Ledger sync on delta). No approval interaction — deltas don't touch spec `status`/approval state, only the task list they feed.
- `waypoint verify <spec-id> <task-id>` (FR6/Story 3.2): the **only** way a task's `linked_commit`/`status: done`/`verified_by_gate` fields ever get written — see Components → Gate Script for what it does, and Data Models → Field ownership for why nothing else may write these fields. A human or agent runs this deliberately, once they believe a task is complete; it is never invoked automatically by a hook.

**2. Core Library (`@waypoint/core`)**
- `templates/` — tier-specific spec templates
- `gate/` — validation logic: spec↔code correspondence check (FR7) only. Has no involvement in task/ledger verification — that's `ledger/`'s job entirely (see below), a clean split that removes the "which module owns the integrity check" ambiguity earlier drafts had.
- `drift/` — reference-scanning logic for `check-drift`
- `ledger/` — read/write/verify logic for task ledgers; **owns** the `.gate-state` hash computation/comparison described in Data Models, and is the sole owner of `waypoint verify`'s logic and of CI's independent re-check (see Components → Gate Script). Enforces the "only `waypoint verify` may mark done" invariant as the sole callable that can flip `status: done`/`verified_by_gate`.
- `delta/` — scaffolds and validates delta blocks for `waypoint update` (FR4)

**3. Gate Script & Verification**

*Gate script* — callable two ways with identical behavior:
- As a git hook, local and fast, staged changes only. Two hook files are installed and share one gate-invoking script: `pre-commit` (fires for an ordinary commit, the first commit in a repo, `--amend`, and a merge that needed manual conflict resolution) and `pre-merge-commit` (fires instead of `pre-commit` for a conflict-free automatic merge — confirmed by direct testing that git does not invoke `pre-commit` in that case). Both resolve `changedFiles` identically: `git diff --cached --name-only` against `HEAD`, or against the empty tree when `HEAD` doesn't resolve yet (the first commit — git handles this transparently, confirmed by testing; no special-casing needed). `--amend` gets the same treatment as an ordinary commit: there is no reliable, portable signal available to a `pre-commit` hook that distinguishes "mid-amend" from "ordinary commit" (no hook arguments, no distinguishing environment variable — confirmed empirically), so the diff base is always `HEAD`/empty-tree, never the amended commit's true original parent. This is a deliberate, documented, fail-closed limitation (occasional over-blocking on an amend that doesn't re-touch an already-delta'd file) rather than an attempted fragile heuristic (e.g. parent-process command-line inspection, which has no clean cross-platform story).
- As a CI script (full path, entire PR diff)

Both compute a list of changed file paths themselves (hooks: `git diff --cached --name-only`, per the base-resolution rule above; CI: `git diff <base>...<head> --name-only`) and pass that list, not a commit or ref, into the shared function:

```ts
function gate(input: GateInput): GateResult

interface GateInput {
  mode: "staged" | "full-diff";   // metadata only — does not change validation logic, only what "changed files" means
  changedFiles: string[];          // repo-root-relative paths; the caller resolves these before calling gate()
  repoRoot: string;
}

interface GateResult {
  ok: boolean;                                          // maps directly to process exit code (0 | 1)
  violations: Array<{ file: string; specId?: string; reason: string }>;
}
```

Because `gate()` only ever sees a file list — never a commit SHA or ref — it behaves identically whether it's called pre-commit (no commit object exists yet) or in CI (a full commit range exists); the caller's job is only to produce `changedFiles`, and `gate()` itself has exactly one implementation of "what counts as a violation."

**`ledger/`'s second pinned contract — `runCheck()`** (the piece `gate()` deliberately doesn't cover — confirming a task's completion, not a changed-file list). `runCheck()` has exactly **one** caller: `waypoint verify` itself, run against whatever the current working tree already is — there is no commit-isolation question to answer, because it never checks out anything; it simply runs `checkCommand` where it stands.

```ts
function runCheck(input: RunCheckInput): RunCheckResult

interface RunCheckInput {
  checkCommand: string;   // from config.yaml
}

interface RunCheckResult {
  ok: boolean;   // did checkCommand exit 0, run in the current working directory
}
```

**`waypoint verify <spec-id> <task-id>`** (CLI, human/agent-invoked): calls `runCheck()`. If `ok`, it reads the current `HEAD` SHA, writes `linked_commit = HEAD`, `status: done`, `verified_by_gate: true`, and the task's `.gate-state` hash (see Data Models) as one atomic in-memory update, then stages *only* the ledger file (`git commit --only <ledger-path>`, never a broad `git add -A`/`.` that would sweep in unrelated staged work) and commits it (e.g. `chore(waypoint): verify t1`). If `runCheck()` reports failure, or the commit step itself fails for any reason (the pre-commit hook rejects it, an unrelated local hook interferes, a merge conflict), `verify` rolls back its in-memory writes and reports the failure — the ledger and `.gate-state` file are left exactly as they were found; there is no partial-write state where a hash exists for a task whose ledger row was never actually committed.

**CI's independent check doesn't call `runCheck()` at all** — re-running a project's full `check_command` (e.g. a whole test suite) once per `done` task, for every PR, doesn't scale as a repo accumulates completed tasks, and doing it against an arbitrary historical `linked_commit` would need an isolated checkout that shallow CI clones and squash-merges make unreliable regardless. Instead, CI verifies a cheaper, different property: **for every task the ledger claims is `done`, is `linked_commit` a real commit that's actually an ancestor of the PR's current HEAD** — via `git merge-base --is-ancestor <linked_commit> HEAD` (exit 0 = yes). This is cheap git plumbing, not a test run, so its cost doesn't grow with `check_command`'s runtime or the number of completed tasks. It catches the concrete tampering case this mechanism exists for — a `status: done` hand-typed directly into the YAML with a fabricated or unrelated `linked_commit`, on a machine where `waypoint verify` never ran (and so has no local `.gate-state` hash to catch it either) — without re-litigating whether that historical commit's tests still pass, which CI's own ordinary test run at the PR's current HEAD (standard practice, not Waypoint-specific) already covers for the codebase as a whole. **CI never writes to the ledger, the gate-state file, or anywhere else** — it only ever reads and reports, which is what removes CI's need for any push/write permissions, and with them the entire class of fork-PR-token, branch-protection, and local/CI-write-race problems earlier drafts of this document ran into. This ancestor check requires a full, non-shallow CI checkout (see Infrastructure) — a shallow clone can't resolve an older `linked_commit`'s ancestry and would misreport a legitimately-verified task as unresolvable. **Squash-merge is a non-issue for the task whose own PR is being checked**: the ancestor check runs against that PR's own branch, before merge, where every real commit still exists — squash-merge only rewrites history on the target branch *after* CI has already passed for that PR. A `linked_commit` recorded during a PR's life becomes a historical record that may not resolve on `main` post-squash, but that's fine on its own terms, since the enforcement this check performs already happened pre-merge for that task.

**Known limitation, surfaced during Story 3.5's review, not yet resolved: this reasoning does not extend to *other, older* tasks once a repo adopts squash-merge as its strategy.** The done-claim check is deliberately a full, repo-wide sweep of every `tasks/**/*.ledger.yaml` file on every CI run (epics.md's Story 3.5 AC requires "every ledger file in the repo," not a diff-scoped subset — this is what gives the "an agent can't get away with a fabricated claim from an old, unrelated PR either" guarantee). But once even one earlier PR is squash-merged, that PR's `linked_commit` is rewritten out of the target branch's history — and every *subsequent* PR's `--ci` run re-checks that same old task's ancestry against its own (now squashed) `HEAD`, where the original `linked_commit` is no longer resolvable. The result: a done task verified before a repo's first squash-merge becomes a **permanent**, unrelated build failure on every future PR, with no recovery path short of hand-editing that ledger row to a commit that does resolve on the new history. This makes `--ci` as specified fundamentally incompatible with sustained squash-merge use once any ledger accumulates a pre-squash `linked_commit`. Accepted as a known, documented limitation for now (not fixed in Story 3.5) — a real fix would mean either scoping the done-claim check to diff-touched ledgers only (weakens the cross-PR guarantee above, and would require amending epics.md's Story 3.5 AC) or a different mechanism entirely (e.g. re-verifying against the PR branch's own recorded tip rather than the target branch's current `HEAD`). Revisit if/when a consuming repo actually hits this in practice, or as a deliberate follow-up story.

**4. Agent Integration Layer**
- Generates `AGENTS.md` at install time from a template, listing: tier heuristics, available CLI commands, and where role prompts live.
- `CLAUDE.md` (FR9's "optionally"): **out of scope for MVP** — `AGENTS.md` is the only generated agent-facing file. Revisit post-MVP only if a concrete need for a Claude-Code-specific variant emerges; until then, `AGENTS.md`'s plain-markdown, no-tool-specific-syntax design (Story 4.1 AC2) is meant to be read directly by any agent, Claude Code included.
- Role prompts (`/roles/planner.md`, `/roles/architect.md`, `/roles/implementer.md`, `/roles/reviewer.md`) are plain markdown, usable as system prompts, slash-command bodies, or pasted directly — no tool-specific format.

## Core Workflows

**Feature-tier flow:**
1. Human or agent runs `waypoint new-feature <name>` → scaffolds spec from template, status `draft`.
2. Spec is filled in (requirements, design, initial task list); the ledger is generated from the task list, all tasks `pending`.
3. Human runs `waypoint approve <spec-id>` → status becomes `approved`. *(Not agent-callable in the default `AGENTS.md` action list — see FR8/Story 3.3.)*
4. Agent implements a task and, while working, may hand-edit the task's ledger row to `status: in-progress` (a purely declarative marker — see Data Models → Field ownership). It commits its work like any other change — there's no required commit-message convention, since linkage no longer depends on parsing anything out of a commit.
5. **Pre-commit / pre-merge-commit hooks** (blocking, run before the commit object exists): call `gate()` with the staged file list — verifies Feature/System-tier changes have a corresponding spec delta (FR7). This is the *only* thing these hooks do; they have no involvement in task verification. See Components → Gate Script & Verification for why both hooks are needed and how the diff base is resolved for the first-commit/merge/amend edge cases.
6. Once the agent believes the task is complete (tests passing locally, code committed), it runs **`waypoint verify <spec-id> <task-id>`** explicitly — the same deliberate, human/agent-invoked pattern `approve` already uses. If the task is already `done` with a valid `.gate-state` hash, this is a no-op (see Data Models → Field ownership) — it doesn't re-verify or re-write anything. Otherwise it calls `runCheck()` in the current working tree (see Components → Gate Script & Verification); on success it writes `linked_commit`, `status: done`, `verified_by_gate: true`, and the `.gate-state` hash as one atomic update, then commits *only* the ledger file (isolated staging, never a broad add) — or rolls the whole write back and reports failure if either the check or the commit step fails, never leaving a half-written state. Verification is synchronous — it blocks until `check_command` finishes, same as running the test suite manually would — which is an acceptable tradeoff precisely *because* it's something the agent chose to run at a natural checkpoint, not an automatic hook firing on every commit (contrast with the pre-commit `gate()` check, which stays fast because it's mandatory on every commit). `verify` doesn't push its commit automatically — until the agent's next `git push`, the completion is real locally but invisible to anyone else, including CI.
7. **CI** (`npx waypoint gate --ci --base <ref>`) does two independent, read-only checks over the PR — it writes nothing anywhere:
   - **Spec-delta enforcement**: calls `gate()` over the full PR diff, exactly as pre-commit does — this is what actually blocks an unreviewed merge, regardless of whether pre-commit ran locally (catching, among other things, a local `git commit --no-verify`).
   - **Done-claim correctness**: for every task the ledger claims is `done` as of the PR's HEAD (enumerated by scanning every `*.ledger.yaml` file directly under `tasks/` from the repo root — a flat, single-level scan, matching the identical flat-layout convention every other ledger consumer assumes, not a recursive glob), confirms `linked_commit` is a real commit and an ancestor of HEAD (see Components → Gate Script & Verification for why this is a cheap ancestor check, not a full re-run of `check_command`). A `done` task whose `linked_commit` doesn't resolve or isn't an ancestor fails the build with a clear message naming the task — this is the mechanical, agent-proof guarantee FR6 requires, enforced independently of whatever happened on any single contributor's machine, and cheap enough that its cost doesn't grow with the number of completed tasks.

   Because CI never writes or pushes, it needs no special permissions beyond running a script — this works identically on GitHub Actions, GitLab CI, or any other CI provider, with no fork-PR token gap, no branch-protection interaction, and no risk of racing a local write.
8. `waypoint status` reads the local ledger directly — no remote-awareness needed, since nothing writes to the ledger except an explicit local `waypoint verify` (or a `git pull` of someone else's, or someone else's push). A spec is closed when it is both `approved` and has at least one tracked task, every one of which is genuinely `done` — a single `CORRUPTED` task (a `done` ledger row whose `.gate-state` integrity hash is missing or doesn't match) never counts as done, even though its raw ledger `status` field still reads `done`.

**Bypass, reframed**: Story 3.1 AC2 requires a deliberate bypass to be "logged, not silent." Since CI's spec-delta check runs over the full PR diff regardless of what happened locally, the only way a Feature+-tier change without a spec delta reaches `main` is if a repo admin explicitly merges despite CI failing — which every mainstream git host (GitHub's "merge without waiting for requirements," GitLab's equivalent) already logs natively, tied to who did it and when. Waypoint doesn't need its own bypass-logging mechanism; it relies on the platform's existing audit trail rather than inventing a parallel one.

**This guarantee has a precondition worth stating plainly, not leaving implicit**: it only holds for a repo using a PR workflow with `waypoint gate --ci --base <ref>` wired up as a required status check. Nothing about `waypoint install` or CI integration enforces that setup — a repo that never configures branch protection, or a solo developer pushing straight to `main` with no PR at all (`brief.md`'s own stated primary user), can bypass the pre-commit hook via plain `git commit --no-verify` and leave genuinely no record anywhere: no Waypoint log (by design), no git-host audit entry (no PR, no override, nothing to log). Waypoint doesn't attempt to solve this — git fundamentally can't be made to intercept `--no-verify` — but a solo developer who wants Story 3.1 AC2's guarantee for their own commits should still route them through a PR (even opened against their own repo) so CI's required check actually gates the merge; this is a real, if unenforced, recommendation rather than a claim that MVP closes the gap for every workflow shape.

**Patch-tier flow:**
1. `waypoint new-patch <name>` → single file, no approval field, no gate hook triggered for changes under patch-classified paths.
2. Commit proceeds normally — zero added friction, by design (NFR2).

**Delta-update flow (FR4/Epic 2 Story 2.1, any tier):**
1. `waypoint update <spec-id>` appends a scaffolded `## Delta — <date>` block (ADDED/MODIFIED/REMOVED subsections) to the end of the existing spec's markdown body.
2. Human or agent fills in the delta's content directly in the spec file. Any newly-introduced requirement gets a new `pending` ledger row (see Data Models → Ledger sync on delta).
3. The updated spec is committed like any other change. There is no independent gate check for this commit beyond FR7's existing rule: a Feature/System-tier spec file is itself a Feature/System-tier path, so the commit already *is* its own spec delta — the delta block's presence in the diff satisfies FR7 directly, with nothing further to verify.

**Drift-check flow (any tier, run manually or in CI on a schedule):**
1. `waypoint check-drift` scans all `approved`/`in-progress` specs for referenced file paths/symbols.
2. Any reference no longer resolvable in the current codebase is flagged with the spec ID and location.
3. Exit code non-zero if any drift found — usable as a scheduled CI job independent of the commit-time gate.
4. **Symbol resolution (MVP scope)**: only backtick-delimited identifiers in spec prose (e.g. `` `refreshToken()` ``) are treated as symbol references. Resolution is a repo-wide word-boundary search (ripgrep-style), not a language-aware AST parse — this applies uniformly regardless of the referenced code's language. Path references are checked for existence the same way regardless of language. Per-language AST-based resolution (fewer false positives on renamed/overloaded symbols) is deferred post-MVP, consistent with PRD FR5's own "materially changed" deferral.

## Source Tree

```
waypoint/
├── packages/
│   ├── cli/                 # waypoint bin, subcommand wiring (Commander.js)
│   └── core/                 # gate, drift, ledger, delta, templates — the enforceable logic
│       ├── gate/
│       ├── drift/
│       ├── ledger/           # owns .gate-state hash compute/compare
│       └── delta/            # scaffolds and validates delta blocks (FR4)
├── templates/
│   ├── patch.md
│   ├── feature.md
│   ├── system/
│   │   ├── prd.md
│   │   ├── architecture.md
│   │   └── adr.md
│   ├── agents-md.ts
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
└── .waypoint/
    ├── config.yaml
    └── .gate-state/*.json   # written only by `waypoint verify`; not hand-edited, not meant to be committed
```

## Infrastructure and Deployment

- Distributed as an npm package; no hosted infrastructure required for MVP.
- `waypoint install` adds `.waypoint/.gate-state/` to the consuming repo's `.gitignore` — it's computed by `waypoint verify`, machine-local verification state (see Data Models), not something to commit or diff; `config.yaml` itself is committed normally.
- `.waypoint/config.yaml` in the consuming repo holds tier-classification path patterns and the check command used for task verification — schema in Data Models above. `waypoint install` pre-populates the default patch-classified patterns (`specs/patches/**`, `docs/**`, root-level `*.md`, `tasks/**`, per Story 3.4 AC3) so a fresh install doesn't over-enforce out of the box, and so `waypoint verify`'s own housekeeping commit is never blocked by the gate it must pass (see Data Models → `.waypoint/config.yaml`).
- `check_command` (e.g., `npm test`, `pytest`) is **global for MVP** — one command for the whole repo, sourced from `config.yaml`. No per-task override; every ledger task is verified against the same command. A per-task override is a plausible post-MVP addition but isn't needed until a real project hits a case requiring it. **Accepted limitation**: because the command is global and not scoped to a task, `waypoint verify <spec-id> <task-id>` can only confirm "the whole suite passes right now," not "this specific task's implementation is what makes it pass" — an agent could technically run `verify` against an unimplemented task if the suite happens to be green for unrelated reasons. This is a real, if narrow, gap in FR6's "agent can't self-report completion" guarantee, accepted for MVP rather than solved by per-task test isolation.
- `waypoint verify` runs `check_command` synchronously in the foreground — see Core Workflows → Feature-tier flow step 6 for why blocking is an acceptable tradeoff here (it's a deliberate, explicit action, not an automatic hook). Relatedly, `linked_commit` records whatever `HEAD` happens to be when `verify` is invoked, not necessarily the commit that implemented the task being verified — a looser guarantee than FR6's "linked commit + passing check" phrasing might suggest, called out here explicitly so it isn't mistaken for a tighter one.
- CI's "done-claim correctness" check (Core Workflows → Feature-tier flow, step 7) requires a **full, non-shallow checkout** (e.g. `actions/checkout` with `fetch-depth: 0`, or the equivalent on other CI providers) — a shallow clone can't resolve an older `linked_commit`'s ancestry, and would misreport a legitimately-verified task as unresolvable rather than genuinely broken. This is the one CI-side setup requirement Waypoint has, and it needs no elevated permissions, only fetch depth.
- Git hook installation happens **only** via the explicit `waypoint install` command — never as an automatic `npm postinstall` side effect. Given the framework's whole value proposition rests on the hook being trustworthy ("gates enforced outside the LLM"), an install step a user didn't consciously run would undermine that trust; `npx waypoint install` is a deliberate, visible action instead.
- CI integration is a single script invocation (`npx waypoint gate --ci --base <ref>`) added to the consuming repo's existing pipeline — Waypoint does not run its own CI infrastructure. Because CI only reads and reports (see Core Workflows → Feature-tier flow step 7), it needs no elevated permissions — no `contents: write`, no push access, nothing beyond running a script and reporting pass/fail. This holds identically for same-repo and fork-based PRs, and identically across CI providers.
- **Versioning**: the Waypoint package follows semver. A breaking change to `.waypoint/config.yaml`'s schema, the delta-block format, or the ledger schema bumps the major version and is called out explicitly in the package's changelog — consistent with the PRD's Non-Goal of not shipping automated migration tooling for MVP; a major bump is a manual-migration signal, not a silent one.

## Error Handling Strategy

- Gate violations produce a clear, actionable message (which spec is missing a delta, which file changed outside an approved task) rather than a generic failure — this is the part most likely to frustrate users if it's opaque.
- **Tier-classification authority** (resolves a possible conflict between a spec's declared frontmatter `tier` and `.waypoint/config.yaml`'s path-glob classification, per FR12/Story 3.4) — **scoped to spec files only**: a spec file's own path might be patch-classified by glob (e.g., a spec accidentally left under `specs/patches/`) while its own frontmatter declares `tier: system`. In that case, the spec's own frontmatter `tier` wins for enforcement purposes on that spec file. This rule does **not** extend to ordinary code files — there is no file→spec association mechanism in this document, and inventing one is out of scope for MVP. A code file's tier is decided purely by `.waypoint/config.yaml`'s path globs (FR12), full stop; whether that code happens to relate to a Feature or System spec doesn't change its own gate classification.
- The gate **fails closed** on ambiguity, in two distinct cases that must not be confused in logging: (1) a changed path matches no declared glob in `config.yaml` → treated as Feature tier (the safer, gated default). (2) `config.yaml` itself is missing, unparseable, or has conflicting glob patterns → **every** changed path is treated as Feature tier until the config is fixed, and the gate emits a distinct "config error" message (not a per-file tier-ambiguity message), so a user sees immediately that the problem is the config file, not their change.
- Ledger corruption on a single machine (e.g., a hand-edited `linked_commit`/`status`/`verified_by_gate` field, or one of those fields present with no corresponding `.gate-state` hash at all) is detected locally via the hash comparison specified in Data Models above — `ledger/` owns this check, scoped to that machine's own clone. Independently, and without relying on that local file at all, CI re-derives correctness by confirming every `done` task's `linked_commit` is a real, ancestor-of-HEAD commit (Core Workflows → Feature-tier flow step 7, Components → Gate Script & Verification) — a cheap structural check, not a full `check_command` re-run — so a hand-edit that evades the local check (e.g., made in a fresh clone with no `.gate-state` history) is still caught the moment the change reaches CI, without CI needing to re-execute the project's test suite once per task.
- **Bypass** (Story 3.1 AC2 — a `--no-verify`-equivalent bypass must be logged, not silent): Waypoint cannot intercept git's native `--no-verify`, but it doesn't need to — CI's spec-delta check (step 7 above) runs over the full PR diff regardless of what happened locally, so a local bypass alone can't land a Feature+-tier change without a delta **when a PR-gated workflow with `waypoint gate --ci --base <ref>` as a required check is in place**. The only way it lands anyway, under that workflow, is a repo admin explicitly merging over a failing CI check, which GitHub/GitLab/etc. already log natively (who, when, which check was overridden) — Waypoint relies on that existing audit trail instead of inventing a parallel commit-trailer convention nothing mechanically enforces. See Core Workflows → "Bypass, reframed" for the precondition this depends on, and the accepted gap for repos that don't use a PR-gated workflow at all.

## Test Strategy

- **Unit tests** (priority 1): gate logic, drift detection, ledger read/write/verify — this is deterministic code with no LLM involvement, and it's the part that must never silently fail.
- **Integration tests**: full CLI flows (`new-feature` → `approve` → `verify` → `gate --ci --base <ref>` pass) against a scratch git repo fixture.
- **Manual/agent-driven testing**: dogfooding the framework on its own development (this project can plan itself using its own Feature-tier flow once Epic 1–3 are done — a good milestone/sanity check).
- **Cross-platform** (verifies NFR5 — macOS, Linux, WSL parity): integration tests run in a CI matrix across `ubuntu-latest`, `macos-latest`, and `windows-latest`, covering specifically the parts most likely to be OS-sensitive — hook installation (`waypoint install`), and the gate script's actual execution path (shebang handling, path separators). GitHub-hosted runners don't offer a native WSL image, so `windows-latest` running under Git Bash is used as an **accepted proxy** for WSL parity, not the real thing — both are Unix-like shells layered on Windows, which covers the shebang/path-separator risk this test exists to catch, even though they aren't identical environments. A test failing on only one matrix leg is treated as an NFR5 regression, not a flaky test to retry past.

## Next Steps

1. Hand this `docs/` folder to BMAD (or your agent of choice) to generate implementation stories from the PRD's epics.
2. Build Epic 1 first (scaffolding) — everything else depends on the folder conventions existing.
3. Build Epic 3 (gate enforcement) before Epic 4 (agent integration) — you want the mechanical enforcement proven before you write the `AGENTS.md` that tells agents to trust it.
