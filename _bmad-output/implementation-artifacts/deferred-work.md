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
