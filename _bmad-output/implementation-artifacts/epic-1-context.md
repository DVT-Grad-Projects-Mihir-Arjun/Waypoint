# Epic 1 Context: Core CLI & Tiering

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A developer can install Waypoint and create a Patch, Feature, or System spec at the right ceremony level, with the repo scaffolded correctly on first run. This epic establishes the CLI's foundation: explicit tier selection (no automatic classification from diff size — that's deferred post-MVP), the base repo structure, and the three spec-creation commands. It also verifies — not just assumes — the framework's two core promises: identical behavior across macOS/Linux/WSL, and zero runtime dependency on any AI model or vendor, both tested from the start rather than left as design intentions.

## Stories

- Story 1.1: Install scaffolds the repo structure
- Story 1.2: Patch-tier spec creation
- Story 1.3: Feature and System-tier spec scaffolding
- Story 1.4: Cross-platform and vendor-neutrality verification

## Requirements & Constraints

- Three CLI commands are explicit, not inferred: `waypoint new-patch <name>` (no approval step), `waypoint new-feature <name>` (one approval gate before implementation tasks close), `waypoint new-system <name>` (approval at each phase boundary). Tier is always named by the command used, never guessed from change size.
- `waypoint install` must scaffold `/specs/{patches,features,systems}`, `/tasks`, `/decisions`, `/roles`, `AGENTS.md`, and `.waypoint/config.yaml` in one run, with no manual config needed afterward (single-command install is a hard requirement).
- Reinstall semantics: any path that already exists (file or user-customized content) is preserved, never overwritten. A path existing as a plain file where a directory is expected must error clearly, not crash on a raw filesystem error.
- Concurrent installs must be safe: writes serialize, or a second concurrent run is a safe no-op — never a partial/corrupted scaffold.
- `.waypoint/config.yaml` ships pre-populated with default patch-classified globs: `specs/patches/**`, `docs/**`, root `*.md`, and `tasks/**`. The `tasks/**` entry is deliberate, not incidental (see Technical Decisions).
- `.gitignore` must include `.waypoint/.gate-state/` as an ignored path immediately after install.
- Git hook installation happens only via the explicit `waypoint install` command, never as an automatic `npm postinstall` side effect — the hook must stay something the user consciously ran.
- Name validation: an empty/missing name, or one with path-traversal or invalid filesystem characters, must error with a validation message before touching the filesystem. A name colliding with an existing spec at any tier must error rather than overwrite.
- `waypoint new-patch` must complete in under ~30 seconds (NFR2), as one component of the overall under-2-minute human process budget (typing the command, filling the record, committing).
- Feature/System spec creation requires install to have run first (clear error otherwise); Feature specs get a matching ledger file with all tasks `pending`; both set frontmatter `status: draft` and `tier` matching the command used.
- Cross-platform parity (NFR5): CLI must work identically on macOS, Linux, and WSL, with Node.js 22+ as the only hard runtime requirement. Verified via a CI matrix across `ubuntu-latest`, `macos-latest`, `windows-latest` (Git Bash on windows-latest is the accepted WSL proxy, since GitHub-hosted runners lack a native WSL image), covering hook installation and the gate script's execution path. A failure on a single matrix leg counts as a real NFR5 regression, not a flaky test to retry past.
- Vendor neutrality (NFR1): none of the CLI's normal operations (`install`, `new-*`, `update`, `verify`, `approve`, `check-drift`, `status`, `gate`) may make an outbound network call to any AI model or vendor API. This is proven with a direct negative test, not left as an assumed property.
- Non-goals relevant here: no automatic tier classification from diff size for MVP; no web UI/dashboard; no bundled/required AI model.

## Technical Decisions

- Stack: TypeScript, Node.js 22+, Commander.js for CLI wiring, YAML for config/frontmatter, Vitest for tests, distributed as an npm package (`npx waypoint`).
- Monorepo layout: `packages/cli` (bin + subcommand wiring, no business logic) and `packages/core` (gate/drift/ledger/delta/templates — all enforceable logic lives here so hook, CI, and CLI share identical behavior). `templates/` holds per-tier spec templates, `agents-md.template`, and role-prompt templates.
- In a consuming repo, install produces: `specs/{patches,features,systems}/`, `tasks/*.ledger.yaml`, `decisions/*.md`, `AGENTS.md`, and `.waypoint/{config.yaml, .gate-state/*.json}`. `.gate-state/` is machine-local, gitignored, written only by `waypoint verify` — irrelevant to install itself but must be gitignored at install time.
- Spec frontmatter (all tiers) includes `id`, `tier` (patch|feature|system), `status` (draft|approved|in-progress|done), `approved_by`, `approved_at`, `created_at`.
- Why `tasks/**` must be patch-classified by default: `waypoint verify`'s own housekeeping commit (Epic 3) touches only a ledger file. If `tasks/**` weren't patch-classified, that commit would itself be an unenforced-tier violation with no spec delta, and the gate would block `verify` from ever completing. This is a deliberate default install must always include, not merely a suggested pattern.
- `.waypoint/config.yaml`'s `tiers` key is tier-keyed (not a flat patch-only list) so a future tier could add its own glob list without a schema change — only `patch` is populated for MVP.
- Distribution and install are one deliberate action: no hosted infrastructure, npm package only; hook setup never happens as a side effect of `npm install`.
- Versioning follows semver; breaking changes to config/delta/ledger schema bump the major version (no automated migration tooling for MVP).
- Test strategy for this epic: unit tests prioritized for deterministic core logic; integration tests exercise full CLI flows against a scratch git repo fixture; cross-platform verification runs as an integration-test CI matrix (see NFR5 above), specifically targeting shebang handling and path-separator sensitivity.

## Cross-Story Dependencies

- Story 1.1's scaffold is a prerequisite for Stories 1.2 and 1.3: both `new-patch` and `new-feature`/`new-system` must error if `waypoint install` was never run.
- Story 1.1 produces `AGENTS.md` and role-prompt file paths, but their *content* is Epic 4's concern (Stories 4.1/4.2) — Story 1.1 only verifies the paths are created.
- Story 1.1's default patch-classified globs (including `tasks/**`) are a dependency for Epic 3's gate/verify mechanism (Story 3.3) — without this default, `waypoint verify`'s own commit would be blocked by the gate it must pass.
- Story 1.4's vendor-neutrality and cross-platform verification depends on the commands built across all of Epic 1 (and touches `update`, `verify`, `approve`, `check-drift`, `status`, `gate` from later epics) — it is written to run as those commands come online, not solely against Epic 1's own commands.
