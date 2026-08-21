export { scaffold, ScaffoldConflictError } from './scaffold.js';
export type { ScaffoldResult } from './scaffold.js';

export {
  buildDefaultConfig,
  renderConfigYaml,
  DEFAULT_CHECK_COMMAND,
  DEFAULT_PATCH_GLOBS,
} from './config-defaults.js';
export type { WaypointConfig } from './config-defaults.js';

export { ensureGitignoreEntry } from './gitignore.js';

export {
  createPatchSpec,
  createFeatureSpec,
  WaypointNotInstalledError,
  InvalidSpecNameError,
  SpecNameCollisionError,
  LedgerNameCollisionError,
} from './new-spec.js';
export type { CreatePatchSpecResult, CreateFeatureSpecResult } from './new-spec.js';

export { renderPatchSpec } from './templates/patch.js';
export { renderFeatureSpec, PLACEHOLDER_TASK_DESCRIPTION } from './templates/feature.js';
export { renderFeatureLedgerYaml } from './templates/feature-ledger.js';
export type { FeatureLedger, FeatureLedgerTask } from './templates/feature-ledger.js';
