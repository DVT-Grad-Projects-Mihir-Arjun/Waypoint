---
epics: [1, 2, 3, 4, 5]
date: 2026-08-25
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# MVP Retrospective: Epics 1–5 (Waypoint)

## Epic summary

This is a **whole-MVP retrospective**, covering all five epics of the roadmap in `_bmad-output/planning-artifacts/epics.md` (user's explicit choice, offered because auto-detection found nothing — this project's `sprint-status.yaml` uses `review` as the terminal per-story status, not literally `done`, so the skill's `detect-epic` script returned `epic: null`). Every one of the 15 stories across all 5 epics is merged into `develop` and its sprint-status entry reads `review`; each epic's own `-retrospective` key is still `optional`. No story is unfinished — the completeness check (manual, since `detect-epic` couldn't resolve an epic number under this project's status convention) confirms all 15 story files exist, each carries `status: done` in its own frontmatter, and each has a merged PR. Treated as equivalent to "no pending stories" for the verdict rule.

**Diff range:** `c82b010c9a551a4e988c278ddd7256694e675997..2204615a6190e5bb944ab443661efad2bc1c42e3` (the parent of Story 1.1's implementation commit, through the final merge of Story 5.1) — 36 commits, 15 merges, all measured (`merges_measured: 15` = `merge_count: 15`, no gap), 91 files touched, zero unmeasured binary revisions.

**Stories completed (15/15):**
- Epic 1 — Core CLI & Tiering: 1.1 (install scaffolds the repo), 1.2 (patch-tier spec creation), 1.3 (feature/system-tier spec scaffolding), 1.4 (cross-platform + vendor-neutrality verification)
- Epic 2 — Delta Spec Format & Drift Detection: 2.1 (update spec via delta), 2.2 (check-drift detects stale specs)
- Epic 3 — Mechanical Gate Enforcement: 3.1 (tier classification via config-driven globs), 3.2 (pre-commit gate, in two parts — the pure `gate()` primitive, then CLI/hook wiring), 3.3 (task ledger with verify-only completion), 3.4 (human-only approval), 3.5 (CI enforces the same gate, plus done-claim correctness)
- Epic 4 — Agent Integration Layer: 4.1 (AGENTS.md generation), 4.2 (role prompts)
- Epic 5 — Status & Reporting: 5.1 (waypoint status)

**Evidence available:** every story's own spec file (`_bmad-output/implementation-artifacts/spec-*.md`) with its full Spec Change Log recording every 3-lens review round's findings and dispositions; `deferred-work.md`'s consolidated record of every deliberately-deferred or rejected finding across all 5 epics; all 5 `epic-N-context.md` compiled context docs; `docs/prd.md` (v0.8) and `docs/architecture.md` (v0.8); the full git history; and this session's own conversation, which is the session log for every story (no session logs were lost or unavailable — this retrospective's author is the same session that ran all 15 stories).

**Missing evidence:** none of substance. The one gap worth naming: no PRIOR retrospective exists for any epic (first retro run for this project), so the "previous-retro follow-through" section below has nothing to check — confirmed by the absence of an `action_items` key in `sprint-status.yaml`.

## Findings

Grouped by aggregate view. Each carries its source and disposition (fix now / defer / accept-as-is). Findings already known and tracked in individual stories' own Change Logs or in `deferred-work.md` are not repeated here — only what this retrospective's cross-story view surfaced that no single story's own review could have.

### Behavior check (highest severity)

**Finding 1 — a fresh `waypoint install` followed by the first, most natural commit is unconditionally blocked by the pre-commit hook it just installed.** Confirmed live in a real scratch repo with `waypoint` properly npm-linked (see Behavior verification above) — not a testing artifact. `.waypoint/config.yaml`'s default `tiers.patch` globs (`specs/patches/**`, `docs/**`, `*.md` [root-level only — no `**`, confirmed by `roles/*.md` being blocked], `tasks/**`) cover `AGENTS.md` (root `*.md`) but not `.gitignore`, `.waypoint/config.yaml` itself, or any of the 4 `roles/*.md` files — all scaffolded by `waypoint install` itself. `specs/`, `tasks/`, `decisions/` are empty directories at install time so they don't appear in the first commit's diff at all, which is why this was never noticed in isolation.

This is the exact same class of bug Story 3.4 AC3 already fixed once, for a different file: `docs/architecture.md`'s own reasoning for classifying `tasks/**` as patch-tier is "`waypoint verify`'s own housekeeping commit... would itself be an unenforced-tier violation with no spec delta, and the gate would block `verify` from ever completing" — the identical mechanism now blocks `waypoint install`'s own scaffold commit, just for a different set of files nobody checked. No single story's own review caught this because: Story 1.1's tests always call `removeGateHooks()` before committing (avoiding the real hook precisely because `waypoint` isn't resolvable in the test's own process); Story 3.2/3.5's gate tests always test the hook against hand-crafted scenarios, never against `scaffold()`'s own raw output as a first commit; Story 3.4's fix was scoped to solving `verify`'s bootstrapping problem specifically, and nobody generalized the lesson to check every other install-time output.

- **Source:** `packages/core/src/config-defaults.ts`'s `DEFAULT_PATCH_GLOBS` (the four defaults); `packages/core/src/scaffold.ts`'s `buildPlan()` (every file it writes: `.gitignore` via `ensureGitignoreEntry`, `.waypoint/config.yaml`, `roles/*.md`); reproduced live per Behavior verification above.
- **Disposition:** fix now — action item below. **Upstream lesson:** when a story adds a new default patch-classified glob to close a bootstrapping gap for one specific file (as 3.4 did for `tasks/**`), the story (or its review) should check every other file `waypoint install` itself writes for the same class of gap, not just the one file that motivated the fix.

**Finding 7 — `waypoint update`'s System-tier sync pass hardcodes every newly-synced task to `phase: 1`, silently bypassing FR8's approval gate for any task added after a spec is already fully approved.** Confirmed two ways: direct source reading, and a live reproduction in a real scratch repo (not a testing artifact).

- **Source:** `packages/core/src/update-spec.ts:583` (`...(found.tier === 'system' ? { phase: 1 } : {})` — unconditional, regardless of which phase is actually open) interacting with `packages/core/src/approve.ts:459-527`'s `approveSystemSpec`, which determines what still needs approval purely from *distinct phase numbers present in the ledger* (`readLedgerDistinctPhases`) minus phases that already have a `phase_approvals` entry — it has no notion of "which task ids were reviewed," only "which phase numbers exist."
- **Live reproduction:** created a System spec with 2 phases (`t1`/phase 1, `t2`/phase 2) → `approveSpec()` twice (phase 1, then phase 2 — `status` flips to `approved`) → added a `### ADDED` bullet to the now-approved spec's Delta section → `updateSpec()` synced it as a new task `t3`, landing with `phase: 1` exactly as the source predicts → `approveSpec()` called again → result: `{"outcome":"already-approved", ...}`. The system reports nothing needs review, even though `t3` was just created and has never been seen by a human approval step. `waypoint verify` has no awareness of approval state at all and would happily mark `t3` `done`; `waypoint status`'s closing criterion (`approved && every task done`) would then exclude the whole spec — including the never-reviewed task — from the report.
- **Why no single story caught this:** Story 2.1 (`update`, Epic 2) and Story 3.4 (`approve`, Epic 3) were built and reviewed independently. No test file anywhere in the repo calls both `updateSpec()` and `approveSpec()` against the same spec — confirmed by grep: each of `updateSpec`/`approveSpec`/`verifyTask` is exercised only inside its own dedicated test file, never chained with the others (see Finding 9 in Diff-scope review, below, for the systemic version of this gap).
- **Disposition:** fix now — action item below. This is a real defeat of FR8's own stated guarantee ("an agent can't self-report completion" via human-only approval), not a cosmetic gap, in the one mechanism this entire tool exists to make mechanical rather than trust-based.

### Spec-to-implementation reconciliation

**Finding 2 — `docs/architecture.md:221`** ("Spec is closed when all tasks are `done`.") is materially incomplete relative to what Story 5.1 actually shipped and what `epics.md`'s own AC declares: the real closing criterion requires both `approved` AND every task genuinely `done` (a `CORRUPTED` task never counts), and this sentence states neither nuance. Predates Story 5.1; never updated when it shipped.
- **Disposition:** fix now (cheap, one sentence) — action item below.

**Finding 3 — every `docs/architecture.md` mention of `gate --ci` (6 locations) writes it as bare `npx waypoint gate --ci`**, never showing the `--base <ref>` flag Story 3.5 made mandatory (its own frozen spec: "`--ci` without `--base`... neither flag alone is a valid invocation"). A reader following architecture.md's own examples verbatim hits a usage error. Predates the `--base` requirement being decided during 3.5's planning.
- **Disposition:** fix now (mechanical find/replace across 6 lines) — action item below.

**Finding 4 — the packaged-templates source-tree sketch's staleness is broader than `deferred-work.md`'s existing entry describes.** That entry covers only the `templates/agents-md.template` → `agents-md.ts` line. The sketch also shows `core/drift/`, `core/ledger/`, `core/delta/` as subdirectories and `scripts/gate.sh` as a file — none of which exist; the real implementation is flat files directly under `packages/core/src/`, no `scripts/gate.sh` anywhere.
- **Disposition:** accept as already tracked, amend scope — the existing `deferred-work.md` entry already defers "the packaged-templates source-tree sketch," just narrower than it should be; the actual fix (a documentation-hygiene pass) is the same either way. No new action item; the existing deferred entry's scope note is enough.

No FR/AC was found silently dropped beyond what's already in `deferred-work.md`; no undocumented behavior was found added beyond spec; the `phase_approvals` design (Story 3.4) and the `status` closing criterion (Story 5.1) both landed in code exactly as their respective `epic-N-context.md` anticipated — only the external architecture.md doc drifted, not the implementations themselves.

### Duplication map

**Finding 5 — `readStoredHash` is byte-for-byte identical in `packages/core/src/verify.ts` and `packages/core/src/status.ts`** (10 lines: read `.gate-state/<specId>.json`, `JSON.parse`, look up `parsed[taskId]`, return string-or-null, swallow any error). Distinct from the deliberately separate, meaningfully-different ledger-parsing logic each "self-contained reader" module has (done-claim.ts's full-repo walk, approve.ts's phase extraction, status.ts's own per-task display-state computation) — those earn their separateness under this codebase's established convention; this one small, pure helper doesn't. `computeLedgerTaskHash` was already exported from `verify.ts` for exactly this kind of reuse; this could have been too.
- **Disposition:** defer — 10 lines, zero current risk, and consolidating means reopening two already-shipped, well-tested modules for a small win. Worth doing the next time either file is touched for an unrelated reason.

**Finding 6 — `packages/core/src/update-spec.ts` (634 lines) now holds three genuinely distinct concerns**: spec discovery (`findSpecById`/`findAllSpecs` and their shared helpers, added across Stories 2.1 and 5.1), shared byte-fidelity utilities other modules import (`splitFrontmatter`/`todayIsoDate`, reused by `approve.ts`), and its own original delta-sync logic (`updateSpec` and about a dozen supporting functions). Grew because two later, unrelated stories each found it natural to extend this file rather than extract a `spec-discovery.ts`.
- **Disposition:** defer — not yet a god-class (everything in it is well-tested and independently correct), no user-facing benefit to splitting now; a legitimate candidate if a fourth unrelated concern ever lands here.

CLI command files' repeated try/catch-and-clean-exit-code shape (`gate.ts`, `verify.ts`, `approve.ts`, `status.ts`, `check-drift.ts`) was checked and is an appropriately, consistently applied shared convention, not extractable duplication — the actual content differs meaningfully per command.

### Diff-scope review (cross-story boundaries)

Two independent investigations (a dedicated path-safety audit, and `bmad-review`'s adversarial/edge-case-hunter/verification-gap lenses run together against `update-spec.ts`, `verify.ts`, `approve.ts`, `done-claim.ts`, `status.ts`, `scaffold.ts` as a set) converged strongly. The headline result is reassuring: **no unpatched path-traversal or write-corruption gap exists anywhere in the codebase today** — every module that builds a filesystem path from an untrusted id already validates it. The real findings are about *consistency* and *reach* — a fix invented in one module never propagated to its siblings with the identical shape of problem.

**Finding 8 — a `null`/non-object ledger task row crashes `verifyTask`, `updateSpec`, and `approve.ts`'s `readLedgerDistinctPhases` with an uncaught `TypeError`; the identical crash-safety guard shipped in the *last* story of the MVP (`status.ts`/`done-claim.ts`, Stories 5.1/3.5) was never retroactively applied to these three earlier, write-path modules.**
- **Source:** `packages/core/src/verify.ts:503,545,573` (`tasks.find((t) => t.id === taskId)`, no null-guard); `packages/core/src/update-spec.ts:573` (`ledger.tasks.map((t) => t.description.trim())`) and `maxTaskNumber`'s `String(task.id)`; `packages/core/src/approve.ts:369-372` (`readLedgerDistinctPhases`'s phase-collecting loop). Contrast with the guard `packages/core/src/status.ts:328-335` and `done-claim.ts` already apply for the exact same shape of malformed input, added during Story 5.1's own review round.
- **Why no single story caught this:** the fix pattern (`if (!task || typeof task !== 'object') { ...skip... }`) was only introduced during the *last* story's review. Nobody went back to check whether the earlier modules with the structurally identical vulnerability needed the same treatment — exactly the kind of gap only visible once every story is looked at together.
- **Disposition:** fix now — action item below. Cheap (the exact guard shape already exists twice in this codebase to copy from), and a crash in a write-path module (`verify`, `update`, `approve`) is more consequential than a read-only report crashing, since it risks leaving a lock held or a partial write.

**Finding 9 — `waypoint update` never uses `verify.ts`'s locking mechanism, unlike every other command that reads and rewrites the same ledger file — a real concurrent-write corruption risk.**
- **Source:** `packages/core/src/update-spec.ts:570,595-597` (unlocked read-then-append-then-write of `tasks/<id>.ledger.yaml`) vs. `packages/core/src/verify.ts:349-366`'s `withVerifyLock`, whose own doc comment states it exists specifically so "concurrent `verify` calls... serialize instead of corrupting the file."
- **What happens:** `waypoint update` running concurrently with `waypoint verify` (or a second `waypoint update`) on the same spec can read a stale ledger and overwrite the other's in-flight write — silently dropping a newly-verified task's completion or a newly-synced row. This is precisely the corruption class Story 3.3's lock was built to prevent, on the identical file, from a sibling command that predates the lock's existence (Story 2.1 shipped before Story 3.3).
- **Disposition:** fix now — action item below. Extend `update-spec.ts`'s ledger write to acquire the same per-spec lock `verify.ts` already exports.

**Finding 10 — `verify.ts`'s own git shell-outs (`resolveHead`, `git add`/`git commit --only`) have no explicit timeout, unlike `done-claim.ts`'s/`approve.ts`'s git calls — and these specific calls run *inside* the exclusive per-spec lock, so a hang blocks every future `verify` call on that spec indefinitely, not just the current one.**
- **Source:** `packages/core/src/verify.ts` (git calls inside `withVerifyLock`'s critical section, no `timeout` option) vs. `packages/core/src/done-claim.ts`'s `gitStdio()` (5000ms) and `packages/core/src/approve.ts`'s `resolveApprovedBy` (3000ms) — both established during later stories, never backported to `verify.ts`'s own earlier git calls.
- **Disposition:** fix now — action item below. The severity here is higher than an ordinary missing timeout, precisely because it's the one case where the hang also poisons a shared lock, not just the current call.

**Finding 11 — `approve.ts` skips its path-safety shape check for Feature tier (reasoning "Feature tier never builds a path from the id" — true only locally), but `update-spec.ts` *does* build a ledger path from that same id for Feature tier — a malformed-id Feature spec can `approve` successfully, then fail `update` for the identical id.**
- **Source:** `packages/core/src/approve.ts:578-582` (`SPEC_ID_SHAPE_PATTERN` applied to System tier only) vs. `packages/core/src/update-spec.ts:552-557` (applied to both Feature and System tier, since Feature's own sync pass also needs a ledger path).
- **Disposition:** fix now — action item below. Apply the shape guard uniformly across every tier that has a ledger, in both modules, rather than each module scoping the check to only what *it itself* happens to touch.

**Finding 12 — four independent, never-unified implementations of "is this id path-safe," in two different styles, across four files — and the frontmatter-sourced one with the weaker style is arguably backwards.** `update-spec.ts:524` and `approve.ts:555` both define the identical `SPEC_ID_SHAPE_PATTERN` regex byte-for-byte (a strict allowlist, for frontmatter-sourced ids); `verify.ts`'s `validatePathSafeIds` and `status.ts:108`'s `isPathUnsafeId` independently define a simpler character-denylist — `status.ts`'s own doc comment explicitly cites `verify.ts`'s as precedent without reusing it. `verify.ts`'s use of the weaker style is arguably *correctly* calibrated (its ids come from a CLI argument a human/agent typed, a different trust boundary than frontmatter content a hand-edited or adversarial PR could control) — but `status.ts`'s id is *also* frontmatter-sourced, the same adversarial-input risk `approve.ts`/`update-spec.ts` already decided warrants the stricter check. This converged independently across three separate investigations run for this retrospective, which is itself the signal that it's real, not a one-off nitpick.
- **Disposition:** defer — extract one shared helper, or at minimum upgrade `status.ts` to the stricter check to match its own trust boundary, the next time any of these four files is touched for an unrelated reason.

**Finding 13 — no test anywhere chains multiple write-path commands together against the same spec; every module's tests hand-craft the artifact an upstream module would have produced instead of calling the real producer.** `status.test.ts`'s own top-of-file comment explicitly documents this choice (hand-edited ledger/frontmatter/`.gate-state` fixtures rather than calling `approveSpec()`/`verifyTask()`); `approve.test.ts` never imports `updateSpec`; `done-claim.test.ts` never imports `verifyTask`. This is the systemic gap that let Finding 7 ship undetected for the whole session.
- **Disposition:** defer as a process lesson with a concrete follow-up — action item below.

**Finding 14 — a lost-update race on spec-*file* writes (as opposed to the ledger) between `approve.ts` and `update-spec.ts`: both read the spec `.md` file's raw text at call start and write a modified version derived from that snapshot, with no lock between them.** Lower urgency than Finding 9 (spec files are edited far less frequently/concurrently than the ledger every `verify` call touches), but the same underlying gap.
- **Disposition:** defer — extend the same lock discipline to spec-file writes if Finding 9's fix is ever generalized.

**Finding 15 — `approve.ts`'s `readLedgerDistinctPhases` doc comment inaccurately claims to mirror `verify.ts`'s non-throwing `readLedgerFile` pattern, but actually throws `LedgerNotFoundError` on the identical missing/malformed-ledger condition.** Not a raw crash in practice — the CLI wrapper already catches `LedgerNotFoundError` in its known-error list and reports it cleanly — so only the doc comment's claim about matching precedent is wrong, not the behavior.
- **Disposition:** defer — a comment fix, not a behavior change.

**Finding 16 — `done-claim.ts`'s `COMMIT_HASH_PATTERN` is documented as accepting "a full 40-character hex SHA" but the actual regex (`/^[0-9a-f]{4,40}$/i`) accepts 4–40 characters, and is incompatible with a SHA-256 git repository (64-character hashes).** SHA-1 remains git's near-universal default; a latent, low-urgency gap rather than a live bug, but the doc/regex mismatch is worth tightening regardless.
- **Disposition:** defer — low real-world likelihood at MVP scale; this codebase's own Technical Assumptions already name git as the sole supported VCS with no SHA-256 commitment either way.

**Finding 17 — `done-claim.ts`'s ledger walker explicitly supports a nested `tasks/` layout, but no other ledger consumer or any real scaffolding code ever produces or expects one.** Speculative generality with no current producer — a relocated ledger would be found by `waypoint gate --ci` but reported as unreadable by every other command.
- **Disposition:** defer — reconcile the convention the next time any of these four files changes.

**Finding 18 — two minor, low-priority doc-comment inaccuracies with no behavioral consequence:** `verify.ts`'s `validatePathSafeIds` doc comment claims `taskId` is used in path construction when in the actual code only `specId` is; `status.ts` folds a path-unsafe-id spec into the generic `[LEDGER ERROR]` state, losing the specific diagnostic `verify.ts` gives for the identical condition on its own CLI-argument path.
- **Disposition:** defer — cosmetic precision, not correctness.

**Checked and clean, explicitly confirmed rather than merely assumed:** no accidental duplication between `status.ts`'s and `done-claim.ts`'s *ledger*-parsing logic (only the small, pure `readStoredHash` helper in Finding 5 above is actually duplicated — their surrounding ledger readers solve genuinely different problems and their structural similarity is this codebase's deliberate "self-contained reader per module" convention, not an oversight); `roles.ts`'s hand-maintained command references are already guarded by `packages/cli/src/role-prompts-wiring.test.ts`, so the class of drift risk logged once for `agents-md.ts` in `deferred-work.md` did not silently spread there; no god-class emerged anywhere in the top-churn files (`verify.ts`, `approve.ts`, `check-drift.ts`, `new-spec.ts`, `gate-classify.ts`, `status.ts` were each read directly and are coherent, single-purpose modules — `update-spec.ts`, Finding 6, is the one partial exception, and even that is an organizational nit, not a god-class).

## Behavior verification

Passing unit/integration tests don't substitute for running the system — every prior story's own test suite already passes (391/391 as of Story 5.1), so this section exercises the full, real, cross-story lifecycle end to end in two real scratch git repos, not what any single story's own tests already cover.

**Run 1 — direct `node dist/index.js` invocation (not npm-linked).** `waypoint install` → `git add -A && git commit` on the resulting scaffold. The commit's pre-commit hook shells to `npx waypoint gate`, which failed with `npm error could not determine executable to run` (this dev build isn't published/linked) — the commit never completed (`git log` afterward: "does not have any commits yet"). This result alone doesn't distinguish "environment artifact" from "real defect," so it was re-run properly below.

**Run 2 — `npm link`ed `waypoint` (a real, resolvable install, the closest local proxy to a published package).** Fresh scratch repo, `npx waypoint install`, then `git add -A && git commit -m "init"`:

```
waypoint gate: .gitignore - Feature/System-tier change with no spec delta in this commit
waypoint gate: .waypoint/config.yaml - Feature/System-tier change with no spec delta in this commit
waypoint gate: roles/architect.md - Feature/System-tier change with no spec delta in this commit
waypoint gate: roles/implementer.md - Feature/System-tier change with no spec delta in this commit
waypoint gate: roles/planner.md - Feature/System-tier change with no spec delta in this commit
waypoint gate: roles/reviewer.md - Feature/System-tier change with no spec delta in this commit
```

**This is a real, confirmed, high-severity defect, not an environment artifact — see Findings, Finding 1.** The commit was genuinely blocked; nothing about `npm link` vs. a published package changes the outcome, since the block is purely about which globs `.waypoint/config.yaml`'s default `tiers.patch` list covers, independent of how `waypoint` itself was resolved.

**Rest of the lifecycle, worked around with `git commit --no-verify` for the one blocked init commit** (matching how this session's own implementation subagents worked around the identical bootstrapping problem in their manual verification scripts throughout the project): `waypoint new-feature demo-auth` → `waypoint status` (correctly showed 1 open Feature spec, not approved, 0/1 tasks done) → `waypoint approve <id>` → `waypoint status` (correctly showed `approved`, still 0/1 done, so still listed) → implemented the placeholder task, added a matching `## Delta` block, committed — **this commit passed the real pre-commit hook cleanly**, confirming the gate correctly recognizes a qualifying spec delta once one exists → `waypoint verify <id> t1` → `waypoint status` (correctly reported **"no open specs"** — the closing criterion fired exactly as designed once the spec was both approved and its only task genuinely verified done) → on a second branch, an unrelated code change with no delta correctly failed `waypoint gate --ci --base main` → `waypoint check-drift` ran cleanly with nothing to flag.

**Verdict on the mechanism itself, once past the bootstrapping defect: works exactly as designed**, end to end, across every command, matching every story's own individually-tested behavior. The one real defect is scoped precisely to the very first commit after a fresh install — everything downstream of that is solid.

## Previous-retro follow-through

No prior retrospective exists for this project — `sprint-status.yaml` carries no `action_items` key at all (confirmed by direct read, not inferred from absence of a mention). Nothing to follow through on; this is the first retrospective run.

## Action items

Numbered independently of the findings above; each names the finding(s) it addresses.

1. **Fix the fresh-install/first-commit gate-blocking bootstrap defect (Finding 1).** Add `.gitignore`, `.waypoint/config.yaml`, and `roles/**` (and, for completeness, `decisions/**`) to `DEFAULT_PATCH_GLOBS` in `packages/core/src/config-defaults.ts`, so a fresh `waypoint install`'s own scaffold commit passes the gate it just installed. Add a standing regression test that runs the real `scaffold()` output through the real gate/hook (not a hand-built fixture) and asserts the resulting first commit succeeds. *Owner: next available implementation session. Remediation, proposed not applied.*
2. **Fix the `waypoint update` phase-1 approval-bypass defect (Finding 7).** `updateSpec()`'s System-tier sync pass must stamp a newly-synced task with a phase number `approveSpec()` will recognize as needing review — e.g. the highest existing phase number plus one, or (simpler and arguably more correct) refuse to guess and require the human/agent to assign a phase explicitly for a spec that's already fully approved. Either fix must be paired with a new integration test chaining `new-system → approve (all phases) → update → approve` and asserting the third `approve` call does *not* report `already-approved`. *Owner: next available implementation session. Remediation, proposed not applied.*
3. **Add the same null/non-object ledger-row guard already used by `status.ts`/`done-claim.ts` to `verify.ts`, `update-spec.ts`, and `approve.ts`'s `readLedgerDistinctPhases` (Finding 8).** *Owner: next available implementation session. Remediation, proposed not applied.*
4. **Extend `verify.ts`'s per-spec lock to `waypoint update`'s ledger read/write (Finding 9).** *Owner: next available implementation session. Remediation, proposed not applied.*
5. **Add an explicit timeout to every git shell-out inside `verify.ts`'s locked critical section (Finding 10).** Match the value already established elsewhere in this codebase (3000–5000ms). *Owner: next available implementation session. Remediation, proposed not applied.*
6. **Apply `SPEC_ID_SHAPE_PATTERN` uniformly across every ledger-bearing tier in both `approve.ts` and `update-spec.ts` (Finding 11).** *Owner: next available implementation session. Remediation, proposed not applied.*
7. **Add at least one true integration test chaining `new-system → update → approve → verify → status` in a real scratch repo (Finding 13, the systemic root cause behind Finding 7).** This is the single highest-leverage regression guard missing from the whole test suite — worth prioritizing alongside item 2, not just as a process footnote. *Owner: next available implementation session. Process lesson turned into a concrete test-suite addition, proposed not applied.*
8. **Spec reconciliation: fix `docs/architecture.md`'s stale closing-criterion sentence (Finding 2) and its 6 bare `gate --ci` examples missing `--base <ref>` (Finding 3).** Both are cheap, mechanical text fixes. *Owner: next available implementation session (or done directly as a docs-only patch). Spec reconciliation, proposed not applied — evidence attached above.*
9. **Amend `deferred-work.md`'s existing packaged-templates-tree-sketch entry to cover the additionally-stale `core/drift/`/`core/ledger/`/`core/delta/`/`scripts/gate.sh` references (Finding 4).** No new entry needed — widen the existing one's scope note. *Owner: whoever next touches that deferred-work entry.*
10. ~~Log Findings 5, 6, 12, 14, 15, 16, 17, 18 to `deferred-work.md`~~ — **done**, as part of finalizing this document (8 new entries appended, all cross-referencing this retro doc as their source).

## Acceptance verdict

**Verdict: accepted-with-open-items.**

**Criteria:** declared — every FR1–FR12 and NFR1–NFR6 in `docs/prd.md` (v0.8), and every AC in `_bmad-output/planning-artifacts/epics.md`, for all 15 stories. Every individual story's own AC set was independently verified and met at the time it shipped (each story's Spec Change Log records the verification), and no story is unfinished — all 15 are merged with `status: done` in their own frontmatter.

**Why not a clean "accepted":** two confirmed, real, high-severity findings (1 and 7) mean the MVP as a *whole system* does not yet fully deliver on its own core promises in every real usage path, even though every individual story met its own narrower AC:
- Finding 1 means the tool fails on literally the first command sequence any new adopter would run (`waypoint install` → `git commit`), unconditionally, with no workaround told to the user.
- Finding 7 means FR8's human-only-approval guarantee — arguably this tool's single most safety-critical property, and the one most explicitly designed-for across Epic 3 — has a real, reproducible bypass for a task added to a System-tier spec after any phase is already approved.

Neither finding stems from a story failing its own declared AC — both are emergent, cross-story defects invisible to any single story's own review, exactly the class of problem this whole-MVP retrospective was run to surface. Given both are clearly scoped, well-evidenced, and have concrete proposed fixes (action items 1–2), **accepted-with-open-items** is the right call rather than **rejected**: the criteria *were* met story-by-story, and the deficiencies are named, tracked findings rather than unfinished delivery.

**Weighed and found sufficient:** the Behavior verification section's full end-to-end lifecycle walkthrough (once past Finding 1's one-time bootstrap block) — `new-feature` → `approve` → implement → commit (real gate pass) → `verify` → `status` (correctly closes) → a second branch's `gate --ci --base` correctly failing on a missing delta → `check-drift` running clean — confirms the mechanism works exactly as designed across every command once the one-time bootstrap defect is worked around.

## Open questions

- **Should Finding 1's fix (widening `DEFAULT_PATCH_GLOBS`) also cover `decisions/**`, even though nothing currently writes to that directory?** Recommend yes for consistency (it's scaffolded by `waypoint install` alongside the other now-covered paths), but no story has ever populated it, so there's no live reproduction to point at the way there is for `.gitignore`/`.waypoint/config.yaml`/`roles/*.md`.
- **Should Finding 7's fix require an explicit phase argument from the caller, or auto-assign the next integer phase?** Both close the bypass; auto-assignment is more convenient but silently invents a phase boundary nobody explicitly designed, which is arguably the same class of "the tool decided something a human should decide" problem this whole approval mechanism exists to avoid. A human answer here would materially change how action item 2 gets implemented.
- **Is Finding 12's "four independent guards" duplication worth a shared helper now, or genuinely fine to leave until one of the four files is next touched anyway?** No urgency either way; recorded so the next retrospective doesn't need to re-derive it.
