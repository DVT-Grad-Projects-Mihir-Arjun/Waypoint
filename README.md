# Waypoint

**Right-sized spec ceremony for AI-assisted development.**

Waypoint is a lightweight, vendor-neutral spec-driven development (SDD) framework that scales its own process to the size of the change being made, and enforces the parts that matter with mechanical checks a coding agent can't quietly skip — a pre-commit/CI gate and a task-completion ledger, not just an instruction in a prompt. It's plain markdown, YAML, and a thin CLI, so it works with any coding agent (Claude Code, Cursor, Codex, or a human with a terminal) — no proprietary IDE, no bundled model, no server.

## Why

Most spec-driven-development tools force a tradeoff:

- Comprehensive multi-agent processes (like BMAD) produce review overload on small changes — a three-file fix buried under hundreds of lines of generated process.
- Structured phase-based tools have gates that are really just prompted instructions, which an agent can bypass without anyone noticing.
- Low-ceremony delta-based tools (like OpenSpec) are fast, but have no enforcement at all — rigor is entirely a matter of discipline, and it erodes under deadline pressure.

Waypoint's answer: **change size determines process weight**, and **gates are enforced outside the LLM**. A one-line config tweak and a new subsystem don't get the same ceremony, but whichever ceremony applies, it's a real gate — a git hook and a CI check that inspect the actual diff and the actual ledger file, not the agent's word for it.

See [`docs/brief.md`](docs/brief.md) for the full problem statement and [`docs/prd.md`](docs/prd.md) / [`docs/architecture.md`](docs/architecture.md) for the complete requirements and design.

## Core concepts

**Three tiers, chosen explicitly, never inferred.** Every change is recorded as a spec at one of three tiers — you pick the tier by which command you run, not by an automatic heuristic on diff size:

| Tier        | For                                                     | Approval                                | Artifacts                                                                       |
| ----------- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| **Patch**   | A small, self-contained change with no design ambiguity | None                                    | `specs/patches/<id>.md`                                                         |
| **Feature** | A change that adds behavior or needs upfront design     | One gate, granted once                  | `specs/features/<id>.md` + `tasks/<id>.ledger.yaml`                             |
| **System**  | Work spanning multiple architecture-level decisions     | Phased — once per ledger phase boundary | `specs/systems/<id>/{prd.md,architecture.md,adr.md}` + `tasks/<id>.ledger.yaml` |

When unsure, prefer the lowest tier that honestly captures the change's design ambiguity and blast radius — escalating a Patch to a Feature later is normal and cheap.

**Specs are the source of truth, edited via deltas.** A Feature/System spec isn't rewritten wholesale as requirements evolve — `waypoint update` appends a dated `## Delta` block (`### ADDED` / `### MODIFIED` / `### REMOVED`) to the existing spec, and syncs any `### ADDED` bullets into new task-ledger rows. The spec's full history stays visible in one document.

**Gates are mechanical, not conventions.** `waypoint install` writes real git hooks (`pre-commit` and `pre-merge-commit`) that call `waypoint gate`: it blocks a commit that touches Feature/System-tier code with no accompanying spec delta staged in the same batch. The identical check runs again in CI (`waypoint gate --ci --base <ref>`) over the full pull-request diff, so a local `--no-verify` bypass still gets caught before merge.

**Task completion is verified, not self-reported.** An agent can mark a task `in-progress` by hand, but only `waypoint verify <spec-id> <task-id>` can mark it `done`: it runs your project's `check_command`, and only on success does it atomically write `linked_commit`, `status: done`, and `verified_by_gate: true` to the ledger, then commits just that ledger file. A locally-stored integrity hash (`.waypoint/.gate-state/`, gitignored) detects a hand-edit of those fields after the fact, and CI independently re-derives correctness by confirming every `done` task's `linked_commit` is a real, ancestor-of-HEAD commit — so a fabricated completion claim can't survive a PR.

**Approval is deliberately human-only.** `waypoint approve` is the sole mechanism that moves a spec from `draft` toward `approved` (Feature tier: once; System tier: once per phase boundary). It's excluded from `AGENTS.md`'s list of agent-facing commands by convention — not because the CLI blocks agent invocation, but because the whole point of the gate is a human decision in the loop.

**Commands can show up natively in your agent's own UI.** `waypoint install` alone makes every workflow verb discoverable via `AGENTS.md` — an agent has to be told to go read it. `waypoint setup-agent <agent>` goes a step further: it generates that agent's own native command/skill files (e.g. `.claude/skills/waypoint-verify/SKILL.md` for Claude Code), one per verb except `install` and the human-only approval gate, so they appear directly in that tool's command list. Supports `claude-code`, `antigravity`, `cursor`, and `codex` (or `all` for every one at once) — idempotent, and never overwrites a file you've since customized. Requires `waypoint install` to have already run. Same as `install`, commit the result yourself — `setup-agent` never commits anything on its own, and its generated files (`.claude/**`, `.agents/**`) are patch-classified by default specifically so committing them isn't blocked by the gate.

## Installation

Waypoint isn't published to a package registry yet. To use it today, build it from source and link the CLI locally:

```bash
git clone https://github.com/DVT-Grad-Projects-Mihir-Arjun/Waypoint.git
cd Waypoint
npm install
npm run build
cd packages/cli && npm link && cd -   # puts a `waypoint` command on your PATH
```

Requires Node.js 22 or later.

## Quickstart

Inside the repo you want to add Waypoint to:

```bash
waypoint install
```

This scaffolds `specs/{patches,features,systems}/`, `tasks/`, `decisions/`, `roles/`, an `AGENTS.md` describing the workflow to any agent, `.waypoint/config.yaml` (tier-classification config), and the git hooks that enforce the gate. Commit the result yourself — `install` never commits anything on its own, and the scaffolded files (`.gitignore`, `.waypoint/config.yaml`, `roles/**`) are patch-classified by default specifically so this first commit isn't blocked by the gate it just installed.

**A trivial change** — patch tier, no gate, no ledger:

```bash
waypoint new-patch fix-typo-in-readme
# edit specs/patches/patch-<date>-fix-typo-in-readme.md, then commit alongside your code change
```

**A real feature** — one approval gate, a checked task ledger:

```bash
waypoint new-feature auth-refresh
# fill in specs/features/feat-<date>-auth-refresh.md and its task list
waypoint approve feat-<date>-auth-refresh          # human-only: grants the gate
# implement t1, then:
waypoint verify feat-<date>-auth-refresh t1        # runs check_command, marks t1 done+verified
waypoint status                                    # see what's still open across every spec
```

**Evolving a spec after the fact:**

```bash
# hand-add a bullet under the spec's "### ADDED" delta section, then:
waypoint update feat-<date>-auth-refresh           # syncs it into a new ledger task, appends a fresh delta block
```

**Checking for stale references** (a spec pointing at a file or symbol that no longer exists):

```bash
waypoint check-drift
```

## CLI reference

| Command                               | Description                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `waypoint install`                    | Scaffold the Waypoint repo structure and install the git-hook gate                       |
| `waypoint new-patch <name>`           | Create a new Patch-tier spec                                                             |
| `waypoint new-feature <name>`         | Create a new Feature-tier spec + task ledger                                             |
| `waypoint new-system <name>`          | Create a new System-tier spec set + phased task ledger                                   |
| `waypoint update <spec-id>`           | Sync new `### ADDED` bullets into the ledger; append a fresh delta block                 |
| `waypoint approve <spec-id>`          | Human-only approval gate — Feature tier once, System tier per phase                      |
| `waypoint verify <spec-id> <task-id>` | Run `check_command`; on success, record the task as done + verified                      |
| `waypoint check-drift`                | Flag spec references to files/symbols that no longer resolve                             |
| `waypoint status`                     | Read-only report of every open spec, its approval state, and task completion             |
| `waypoint gate [--ci --base <ref>]`   | The enforcement check itself — runs as a git hook by default, or in full-PR-diff CI mode |
| `waypoint setup-agent <agent \| all>` | Generate native slash-command/skill files for a coding-agent tool (`claude-code`, `antigravity`, `cursor`, `codex`, or `all`) |

Run `waypoint <command> --help` for a command's full description.

## How it fits together

A single core validation/gate library (`@waypoint/core`) is invoked from three surfaces — the CLI, the git hook, and CI — so the same code decides "does this change need a spec delta" and "is this task really done" everywhere, instead of the hook quietly checking something slightly different from the CLI command. See [`docs/architecture.md`](docs/architecture.md) for the full design: file formats, the gate's enforcement logic, the ledger's tamper-detection mechanism, and the CI integration contract.

## Repository layout (this monorepo)

```
packages/
  core/   @waypoint/core — scaffolding, gate, drift, ledger, and delta logic
  cli/    waypoint — thin Commander.js wrapper around @waypoint/core
docs/
  brief.md          project brief: problem statement, proposed solution, scope
  prd.md            full functional/non-functional requirements
  architecture.md   technical design: data models, workflows, tech stack
```

## Contributing / development

```bash
npm install
npm run build   # tsc -b across both workspaces
npm test        # vitest, full suite
```

Both packages are TypeScript, ESM (`type: module`), and tested with Vitest — see `packages/core/src/*.test.ts` and `packages/cli/src/*.test.ts` for the existing conventions (real scratch git repos for anything that touches hooks, commits, or the filesystem; no mocking of `git` itself).
