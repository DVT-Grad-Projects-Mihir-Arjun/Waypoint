import { stringify } from 'yaml';

/**
 * Single source of truth for what `waypoint install` writes into
 * `.waypoint/config.yaml`.
 *
 * `tiers.patch` MUST include `tasks/**` — Epic 3's `waypoint verify` commits
 * only a ledger file, and if `tasks/**` weren't patch-classified that commit
 * would itself be an unenforced-tier violation with no spec delta, blocking
 * `verify` from ever completing. This is load-bearing, not a suggested
 * default (see epic-1-context.md, Technical Decisions).
 *
 * `.gitignore`, `.waypoint/config.yaml`, and `roles/**` are patch-classified
 * for the identical reason: a fresh `waypoint install`'s own first commit
 * (`.gitignore`, `.waypoint/config.yaml`, `roles/*.md`, `AGENTS.md`, etc.,
 * all written by `scaffold()` in one pass) would otherwise be blocked by the
 * very gate it just installed, with no spec delta possible for a repo that
 * has no specs yet (epic-1-5 MVP retro, Finding 1). `decisions/**` was
 * deliberately NOT added here even though `scaffold()` also creates a
 * `decisions/` directory on install: that directory is created empty, so
 * there is nothing in it for the bootstrap commit to need patch-classified —
 * adding it would have widened the unenforced surface for no bootstrap
 * benefit.
 *
 * Accepted governance tradeoff: patch-classifying `.waypoint/config.yaml`
 * and `roles/**` means a *later* edit to either — e.g. loosening
 * `tiers.patch` itself, or rewriting an agent's role-prompt instructions —
 * also requires no spec delta and is never blocked by the gate, not just the
 * bootstrap commit. Unlike `tasks/**` (safe to leave patch-classified
 * because `waypoint verify`'s `.gate-state` hash independently catches
 * tampering with a ledger's completion claims), nothing else in this
 * codebase protects `.waypoint/config.yaml` or `roles/**` from an
 * unenforced, undelta'd rewrite. This was surfaced by two independent code
 * review lenses and explicitly accepted rather than redesigned (e.g. having
 * `waypoint install` commit its own scaffold directly, keeping these files
 * under normal enforcement) — see the deferred-work.md entry sourced from
 * `epic-1-5-mvp-retro-2026-08-25.md`, Finding 1, for the full tradeoff and
 * revisit criteria. `.waypoint/**` (which would also patch-classify
 * `.gate-state/**`) was deliberately narrowed to the literal
 * `.waypoint/config.yaml` to avoid widening that blast radius any further.
 *
 * `.claude/**` and `.agents/**` are patch-classified for the same bootstrap
 * reason as `.gitignore`/`.waypoint/config.yaml`/`roles/**` above:
 * `waypoint setup-agent <agent>` writes its generated slash-command/skill
 * files to exactly these two locations (`.claude/skills/**` for Claude
 * Code; `.agents/skills/**`, shared, for Cursor/Codex/Antigravity), and a
 * user who runs `setup-agent` and then commits the result would otherwise
 * be blocked by the very gate `install` already set up, with no spec delta
 * possible for output that isn't itself a spec-governed code change — the
 * identical bootstrapping problem `install`'s own scaffold output already
 * solves for itself (epic-1-5 MVP retro, Finding 1).
 *
 * Accepted governance tradeoff, same shape as `roles/**` above: patch-
 * classifying `.claude/**` and `.agents/**` means a *later* hand-edit to an
 * already-generated skill file also goes unenforced, not just the first
 * commit that creates it — nothing in this codebase protects these paths
 * from an unenforced, undelta'd rewrite after the fact.
 */

export interface WaypointConfig {
  check_command: string;
  tiers: {
    patch: string[];
  };
}

/** Global check command run by `waypoint verify` (MVP: one command, no per-task override). */
export const DEFAULT_CHECK_COMMAND = 'npm test';

/**
 * Default patch-classified glob patterns. Order matches the schema documented
 * in architecture.md's Data Models section.
 */
export const DEFAULT_PATCH_GLOBS: readonly string[] = [
  'specs/patches/**',
  'docs/**',
  '*.md',
  'tasks/**',
  '.gitignore',
  '.waypoint/config.yaml',
  'roles/**',
  '.claude/**',
  '.agents/**',
];

/** Builds the default config object written by `waypoint install`. */
export function buildDefaultConfig(): WaypointConfig {
  return {
    check_command: DEFAULT_CHECK_COMMAND,
    tiers: {
      patch: [...DEFAULT_PATCH_GLOBS],
    },
  };
}

/** Renders the default config as YAML text, ready to write to `.waypoint/config.yaml`. */
export function renderConfigYaml(): string {
  return stringify(buildDefaultConfig());
}
