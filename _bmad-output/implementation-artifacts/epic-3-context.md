# Epic 3 Context: Mechanical Gate Enforcement

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A developer gets enforcement they can actually trust: code can't land without a corresponding spec delta, a task's completion can't be self-reported by an agent, and approval can't be silently self-granted — all backed by mechanical checks, not convention. This epic delivers the config-driven tier classifier, the pre-commit gate, a task ledger whose completion fields only an explicit `verify` command may write, human-only approval, and a CI check that independently re-derives both guarantees over the full PR diff so enforcement holds even when local hooks were skipped or missing.

## Stories

- Story 3.1: Tier classification via config-driven globs
- Story 3.2: Pre-commit gate blocks missing spec deltas
- Story 3.3: Task ledger with verify-only completion
- Story 3.4: Human-only approval
- Story 3.5: CI enforces the same gate, plus done-claim correctness

## Requirements & Constraints

- Every changed file must resolve to exactly one tier classification (patch/unenforced vs. feature-or-above/enforced) via config-declared glob patterns; a path matching no pattern defaults to enforced (fail-closed), logged clearly rather than silently passed through.
- A missing, empty, or malformed config must force every path to enforced tier and emit a distinct "config error" message, never a per-file ambiguity message.
- Deletions and renames are classified by their (removed or new) path — never a way to dodge enforcement.
- A spec file's own frontmatter `tier` overrides its path-glob classification for that spec file only; ordinary code files are governed purely by the glob mechanism.
- The pre-commit gate must block a commit that changes enforced-tier code with no spec delta in the same commit, resolve a well-defined diff base for the first commit / a merge / an amend, and complete in under 2 seconds at up to 2,000 tracked files and 50 open specs.
- A task's `linked_commit`, `status: done`, and `verified_by_gate` may only ever be written by an explicit verify command that checks a linked commit passes — never by hand-edit, free-text agent output, or any automatic hook.
- Re-verifying an already-done task with a valid stored integrity hash is a no-op; a done task with a missing or mismatched hash must be flagged as corrupted, not silently trusted or overwritten.
- Concurrent verify runs against the same or sibling tasks must serialize writes; a per-task hash file update must merge, never replace the whole file.
- Approval is restricted to a human-run command: idempotent (no-op if already approved), errors on a missing or patch-tier spec-id, and for System-tier specs records each phase boundary's approval distinctly.
- CI must independently re-check the same spec-delta rule over the full PR diff, plus verify every ledger task claiming `done` actually has a valid, ancestor-of-HEAD linked commit — failing the build by name on a blank/fabricated/unresolvable commit or unparseable ledger file — within a bounded time budget (e.g. under 60s), using a full non-shallow checkout, with no elevated permissions and identical behavior across CI providers and forks.
- CI must write nothing anywhere; a local `--no-verify` bypass only defers enforcement to CI, never escapes it.

## Technical Decisions

This is the final v0.5/v0.6 design (superseding earlier automatic-hook/trailer-based drafts from v0.2–v0.3):

- **`gate()` is a pure function**: `gate(input: GateInput): GateResult` where `GateInput` is `{ mode: "staged"|"full-diff", changedFiles: string[], repoRoot: string }` and `GateResult` is `{ ok: boolean, violations: [...] }`. It only ever sees a resolved file list, never a commit SHA/ref, so pre-commit (staged files, no commit object yet) and CI (`git diff <base>...<head>`, full PR diff) call the identical implementation — one violation-detection codepath, not two that can drift apart.
- **`waypoint verify <spec-id> <task-id>` is the sole write path for ledger completion fields.** It is an explicit, synchronous, human/agent-invoked CLI command — not a git hook, not automatic on commit. It calls `runCheck()` (runs `check_command` from config in the current working tree, no isolation/checkout); on success it writes `linked_commit` (current HEAD), `status: done`, `verified_by_gate: true`, and a `.gate-state` integrity hash as one atomic in-memory update, then commits *only* the ledger file via isolated staging (never a broad `add -A`). Failure of the check, or of the commit step itself, rolls the whole write back — no partial state where a hash exists for an uncommitted ledger row.
- **CI is a pure, read-only checker** (`npx waypoint gate --ci`): it never writes to the ledger, `.gate-state`, or anywhere else, and needs no elevated permissions. It does two independent checks over the full PR diff: (1) `gate()` for missing spec deltas, and (2) for every task the ledger claims `done`, `git merge-base --is-ancestor <linked_commit> HEAD` — a cheap structural ancestor check, deliberately *not* a per-task re-run of `check_command` (that wouldn't scale and can't reliably re-checkout an arbitrary historical commit under shallow/squash conditions). Requires a full, non-shallow checkout.
- **`tasks/**` is deliberately patch-classified** in `.waypoint/config.yaml`'s default globs: without it, `verify`'s own ledger-only commit would itself be an unenforced-tier violation with no spec delta, and the gate would block `verify` from ever completing its own housekeeping.
- **Bypass is handled via the git host's native audit trail, not a Waypoint-specific log.** Since CI re-checks the full diff regardless of local hooks, the only way an undelta'd change lands is a repo admin explicitly overriding a failing required CI check — already logged by GitHub/GitLab natively. This precondition (PR-gated workflow with `gate --ci` as a required check) is explicit; a solo dev pushing straight to `main` with no PR has no audit trail to rely on, and that gap is accepted for MVP.
- **`approve` is a documented convention, not a technical block against shell access** — its actual "not agent-callable" guarantee comes from Epic 4 excluding it from `AGENTS.md`'s action list, not from anything this epic's `approve` command itself enforces.
- **Ledger corruption detection**: `.waypoint/.gate-state/<spec-id>.json` (machine-local, gitignored) stores `sha256(canonicalJSON({id, status, verified_by_gate, linked_commit}))` per task, written only by `verify`, checked on subsequent local runs; a `done` task with no stored hash is flagged exactly like a mismatched one. This is local-only tamper detection — CI's ancestor check is the independent, non-local backstop for the same guarantee.

## Cross-Story Dependencies

- Story 3.1's classification is a hard prerequisite for 3.2 — the gate can't decide what to block without it.
- Story 3.2 and 3.3 both feed Story 3.5: CI re-derives 3.2's spec-delta rule over the full diff, and re-derives 3.3's done-claim guarantee via the ancestor check on `linked_commit`.
- Story 3.3 depends on Epic 1's default `tasks/**` patch-tier classification (Story 1.1) — without it, `verify`'s own commit is unbuildable against the gate.
- Story 3.4 has a known, time-boxed interim gap: until Epic 4 Story 4.1 generates `AGENTS.md` with `approve` excluded, nothing yet stops an agent from calling it directly.
- Story 3.5's done-claim check depends on Story 3.3's ledger schema (`linked_commit`, `status`, `verified_by_gate`) and glob-enumerates `tasks/**/*.ledger.yaml` from the repo root — the same mechanism, not left for the implementer to invent.
