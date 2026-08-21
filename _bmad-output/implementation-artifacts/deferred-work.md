# Deferred Work

Findings from code review that are real but out of scope for their source story — not bugs to fix now, but risks or gaps worth tracking for a future story or a deliberate follow-up decision.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-install-scaffolds-the-repo-structure.md`
  summary: `packages/cli/package.json` and `packages/core/package.json` lack standard metadata fields (`description`, `license`, `repository`, `author`).
  evidence: Neither file was reviewed against npm packaging conventions during Story 1.1 since the story's scope was scaffold behavior, not package publishing readiness; matters once these packages are actually published to a registry.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-install-scaffolds-the-repo-structure.md`
  summary: `packages/cli/package.json` pins `@waypoint/core` to an exact version (`0.1.0`) rather than a caret range, so `packages/core` bug fixes won't reach installed CLIs without a manual `cli` version bump and republish.
  evidence: Confirmed by reading `packages/cli/package.json`; within an npm workspace this doesn't block local development, but it's a real distribution-time risk once the packages are published independently rather than resolved via the workspace.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-install-scaffolds-the-repo-structure.md`
  summary: `ensureGitignoreEntry` (`packages/core/src/gitignore.ts`) matches `.gitignore` lines by exact string equality, so it cannot recognize that a broader existing pattern (e.g. a bare `.waypoint/`) already covers the entry it's about to add, and will append a redundant line.
  evidence: Read the function directly — it does `content.split(/\r?\n/).some((line) => line.trim() === entry)`, which is correct for the story's literal requirement ("append if it doesn't already contain it") but not for pattern-aware `.gitignore` semantics; no functional bug today, just imprecise duplicate-detection, flagged in case a future story wants stricter gitignore hygiene.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-install-scaffolds-the-repo-structure.md`
  summary: The root `.gitignore`'s `/node_modules/` entry is anchored to the repo root only, so it won't ignore `packages/*/node_modules/` if a future contributor uses a package manager or workflow that creates per-package `node_modules` directories instead of npm workspaces' hoisted layout.
  evidence: Confirmed by reading `.gitignore` — the entry is `/node_modules/` (leading slash, root-anchored), not the common recursive `node_modules/` pattern; not a problem under the current npm-workspaces setup, but a latent gap if the tooling ever changes.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-install-scaffolds-the-repo-structure.md`
  summary: The Waypoint monorepo itself has no root `README.md` or `LICENSE` file.
  evidence: Outside Story 1.1's scope (which scaffolds a *consuming* repo's structure, not this repo's own documentation), but a real gap before any public distribution of the `waypoint` package.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-install-scaffolds-the-repo-structure.md`
  summary: `checkConflict` in `packages/core/src/scaffold.ts` follows symlinks via `statSync` without special-casing them, so a scaffolded path that is a symlink to a directory elsewhere (including outside the repo) is silently accepted and written through rather than flagged as an unusual pre-existing state.
  evidence: Read `checkConflict` directly — it calls `existsSync`/`statSync`, both of which follow symlinks by default, with no `lstatSync` check; not a security boundary this story promised to defend (the I/O matrix doesn't mention symlinks), but worth a deliberate decision later on whether symlinked scaffold paths should be accepted, warned on, or rejected.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-install-scaffolds-the-repo-structure.md`
  summary: If a transient write failure (e.g. `EACCES`, disk full) occurs partway through the plan-entry write loop in `scaffold()`, already-created paths from that same run are left in place with no rollback — a retry will report them as "kept" rather than the run being fully atomic.
  evidence: Read `scaffold()`'s main loop directly — each entry is written independently with no compensating cleanup on a later entry's failure; the story's "no partial writes" guarantee (I/O matrix, Path collision row) is about pre-flight conflict detection preventing partial writes on a *known* conflict, not about recovering from a mid-write I/O failure, so this is a narrower, lower-probability gap rather than a spec violation.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-patch-tier-spec-creation.md`
  summary: `createPatchSpec`'s name validation and cross-tier collision check don't account for case-insensitive filesystems (macOS APFS, Windows), so `Fix-Typo` and `fix-typo` are treated as distinct valid names by the regex and collision check even though they resolve to the same file on those platforms.
  evidence: Confirmed by reading `new-spec.ts`'s `NAME_PATTERN` and the `SPEC_TIERS` collision loop, both of which use plain string equality/regex matching with no case-folding; not something a mechanical patch should decide unilaterally, since fixing it requires a deliberate naming-policy call (reject mixed case? lowercase-normalize names? case-insensitive collision check only?) rather than a one-line code change.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-patch-tier-spec-creation.md`
  summary: `createPatchSpec`'s name validation regex (`/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`) accepts Windows-reserved device basenames (`con`, `aux`, `nul`, `com1`, etc.), which would fail unpredictably when writing `specs/patches/<name>.md` on Windows.
  evidence: Confirmed by reading the regex directly — none of the reserved names are excluded; a real but niche cross-platform gap, and whether to add a reserved-name blocklist is a deliberate scope/policy decision for a future story rather than a mechanical fix to this one.

- source_spec: none
  summary: `waypoint new-system <name>` (System-tier spec-set scaffolding — PRD-style requirements, an architecture stub, ADR stub(s), and phased tasks) was split out of Story 1.3 and deferred to its own future spec.
  evidence: Story 1.3 as written in epics.md bundles `new-feature` (a single spec file + matching ledger, closely reusing Story 1.2's pattern) with `new-system` (a materially new multi-file spec-set layout with its own ledger/phased-task design questions not resolved by the epics.md AC alone). Per the SCOPE STANDARD's multi-goal criteria, these are two independently shippable deliverables; the human chose to split and build `new-feature` first, deferring `new-system` to a dedicated follow-up spec.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-feature-tier-spec-creation.md`
  summary: `createPatchSpec`/`createFeatureSpec`'s exclusive-create (`'wx'`) writes protect against a same-command race on the same `<name>`, but not a cross-command race — e.g. `waypoint new-patch foo` and `waypoint new-feature foo` running concurrently could both pass their respective collision checks before either writes, since neither checks the other's target path atomically with a shared lock.
  evidence: Confirmed by reading both functions directly — each only exclusive-creates its own target file(s); nothing coordinates across the two functions or CLI invocations. Closing this fully would need a shared lock mechanism (like `scaffold.ts`'s advisory lock directory) spanning all `new-*` commands, which is a deliberate concurrency-design decision rather than a mechanical patch to one function.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-feature-tier-spec-creation.md`
  summary: The frontmatter `id` string (`` `feat-${createdAt}-${name}` `` / `` `patch-${createdAt}-${name}` ``) is constructed independently in both `new-spec.ts` (the caller) and each tier's template module (`templates/feature.ts`, `templates/patch.ts`), rather than computed once and passed in — two format strings per tier that could silently drift apart if one is ever changed without the other.
  evidence: Confirmed by reading `createFeatureSpec`/`createPatchSpec` alongside `renderFeatureSpec`/`renderPatchSpec` — both the caller and the template independently interpolate the same `feat-<date>-<name>`/`patch-<date>-<name>` pattern. Pre-existing for patch tier since Story 1.2 (not previously logged) and reproduced for feature tier in Story 1.3; a real minor duplication risk, but consolidating it touches multiple already-tested call sites, so it's a deliberate refactor for a future pass rather than a one-line fix now.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-feature-tier-spec-creation.md`
  summary: `waypoint new-feature`'s `--help` description mentions "one approval gate," but no `waypoint approve` command exists yet — not even as a discoverability stub the way `new-system` has one — so a user reading `--help` has no way to see that the referenced approval workflow is intentionally deferred to Epic 3.
  evidence: Confirmed by reading `program.ts`'s `new-feature` registration and the `STUB_COMMANDS` list — `approve` isn't registered in either form. Whether to add an `approve` stub now or reword the help text is a product/UX decision, not a mechanical fix.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-feature-tier-spec-creation.md`
  summary: `createFeatureSpec`'s two collision checks (spec path across all three tiers, and the ledger path) use the same case-sensitive `existsSync` comparisons as `createPatchSpec`, so the case-insensitive-filesystem gap already logged above for patch tier now spans two files (spec + ledger) instead of one — a case-only name clash (e.g. `Demo-Feature` vs. an existing `demo-feature`) could produce a mismatched spec/ledger pair on macOS or Windows rather than just one wrong file.
  evidence: Confirmed by reading `createFeatureSpec`'s `SPEC_TIERS` loop and its ledger-path check — neither does any case-folding. Same underlying gap as the existing patch-tier entry above; noted separately here because the failure mode is now two files instead of one, and because it deserves its own naming-policy decision alongside patch tier's, not a silent extension of the old entry.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-cross-platform-and-vendor-neutrality-verification.md`
  summary: `.github/workflows/ci.yml` triggers its full 3-OS matrix on every `push` to every branch with no path or branch filtering, so a doc-only or WIP commit on a feature branch costs the same as a real code change.
  evidence: Confirmed by reading the workflow's `on:` block — plain `push:`/`pull_request:` with no `paths`/`paths-ignore`/`branches` filters. Whether (and how) to filter is a deliberate cost/coverage tradeoff, not a mechanical fix — e.g. excluding `docs/**`/`*.md` risks silently skipping a doc change that also touched code in the same commit if the filter is too broad.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-cross-platform-and-vendor-neutrality-verification.md`
  summary: The new CI workflow exists but isn't wired into GitHub's branch-protection "required status checks," so a red 3-OS matrix run doesn't yet block a PR from being merged — the epic's stated goal ("proven, not left as an assumed property") is only half-delivered until this is turned on.
  evidence: Confirmed no code in this repo configures required status checks (that lives in GitHub's branch-protection settings, not a repo file); checking via `gh api repos/.../branches/develop/protection` returned a 403 — this private repo's current GitHub plan doesn't support branch protection at all, so this can't even be turned on today without a plan upgrade or making the repo public. Either way it's a repo-settings/billing decision affecting shared merge policy, not a code change — a deliberate, explicit action for the human to take (or ask for) rather than something a code review's patch batch should apply.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-system-tier-spec-scaffolding.md`
  summary: `waypoint new-system`'s `--help` description mentions "phased approval," but no `waypoint approve` command or phase-gating mechanism exists yet — same class of gap already logged for `new-feature`'s "one approval gate" text, now also true for `new-system`.
  evidence: Confirmed by reading `program.ts`'s `new-system` registration and the full `STUB_COMMANDS`/command list — no `approve` command or stub exists anywhere. Whether to add an `approve` stub now or reword both commands' help text is a product/UX decision spanning both tiers, not a mechanical fix to this story alone.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-system-tier-spec-scaffolding.md`
  summary: `createSystemSpec`'s directory-based collision check (`specs/systems/<name>`) is case-sensitive like `createPatchSpec`/`createFeatureSpec`'s file-based checks, so the same case-insensitive-filesystem gap already logged for patch/feature tier now also applies to system tier's directory collision.
  evidence: Confirmed by reading `specTierCollisionPath`'s `systems` branch — plain `existsSync`, no case-folding. Same underlying gap as the existing patch/feature entries above, extended here to the new directory-shaped check; still needs one deliberate naming-policy decision covering all three tiers, not a per-tier mechanical fix.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-system-tier-spec-scaffolding.md`
  summary: `createPatchSpec`/`createFeatureSpec`/`createSystemSpec` still each inline their own copy of the validate-name → install-check → cross-tier-collision-loop sequence; only the per-tier path computation (`specTierCollisionPath`) was factored into a shared helper, not the sequence itself.
  evidence: Confirmed by reading all three functions — the same four-line block (`isValidName` check, `isInstalled` check, `for (const tier of SPEC_TIERS)` loop) is repeated verbatim in each. A real consolidation opportunity (e.g. a shared `assertCreatable(cwd, name)` prelude), but deciding its exact shape is a deliberate refactor for a future pass, not a one-line fix now — especially since all three functions are independently well-tested today.

- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-update-spec-via-delta.md`
  summary: `updateSpec`'s ledger write and spec-file write are two independent, non-atomic `writeFile` calls — if the second write fails after the first succeeds (disk full, permissions, process killed), the two artifacts end up transiently out of sync (e.g. the ledger gains new rows but the spec's delta heading never gets appended, or vice versa).
  evidence: Confirmed by reading `updateSpec` directly — no rollback or transactional wrapping around either write. Lower urgency than Epic 1's creation-time write gaps: `update`'s own sync logic re-scans the spec's current `ADDED` content from scratch on every run (idempotent by description-matching), so a subsequent retry naturally catches up rather than leaving a permanently broken, unrepairable state — but it's still a real gap worth a deliberate fix (e.g. write both to temp files then rename) rather than a quick patch.

- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-check-drift-detects-stale-specs.md`
  summary: `check-drift`'s path-existence check (`existsSync`) is case-sensitive, so on the common case-insensitive dev filesystems (macOS APFS, Windows) a reference like `` `Foo.ts` `` against an actual `foo.ts` reports as resolved — exactly the class of drift (breaks on case-sensitive Linux CI) the tool exists to catch, systematically missed on the most common local dev machines.
  evidence: Confirmed by reading `resolvePathReference` — a plain `existsSync(path.join(cwd, pathValue))` with no case normalization or comparison against the actual directory listing. Same underlying class of gap already logged above for `new-patch`/`new-feature`/`new-system`'s name validation, now also affecting `check-drift`'s existence checks — still needs one deliberate cross-cutting decision, not a per-command fix.

- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-check-drift-detects-stale-specs.md`
  summary: `collectRepoFiles`'s recursive walk only branches on `entry.isDirectory()`/`isFile()`, so a symlinked file or directory is silently skipped entirely — a symbol reference resolving only through a symlinked path would be wrongly reported as stale even though its real target exists.
  evidence: Confirmed by reading the walk function directly — no `isSymbolicLink()` handling at all. Same class of gap already logged for `scaffold.ts`'s `checkConflict` (Story 1.1), which also silently follows/ignores symlink semantics without a deliberate policy; worth one shared decision covering both call sites rather than a one-off fix here.

- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-check-drift-detects-stale-specs.md`
  summary: `EXCLUDED_DIR_NAMES` covers only `.git`/`node_modules`/`dist`/`.waypoint` (per the frozen spec's own list) — it doesn't exclude other common build/output directories (`build`, `coverage`, `.next`, `vendor`, etc.) and doesn't consult `.gitignore`, so the repo-wide symbol search can be slower than necessary and could pull generated content into a match, masking real drift behind a leftover build artifact.
  evidence: Confirmed by reading `EXCLUDED_DIR_NAMES` — exactly the four directories the spec names, nothing more. Deciding whether to hardcode a broader list or consult `.gitignore` properly is a deliberate scope decision (and a bigger feature in the `.gitignore` case), not a one-line fix to this story's frozen exclusion list.
