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
