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
  createSystemSpec,
  WaypointNotInstalledError,
  InvalidSpecNameError,
  SpecNameCollisionError,
  LedgerNameCollisionError,
} from './new-spec.js';
export type {
  CreatePatchSpecResult,
  CreateFeatureSpecResult,
  CreateSystemSpecResult,
} from './new-spec.js';

export { renderPatchSpec } from './templates/patch.js';
export { renderFeatureSpec, PLACEHOLDER_TASK_DESCRIPTION } from './templates/feature.js';
export { renderFeatureLedgerYaml } from './templates/feature-ledger.js';
export type { FeatureLedger, FeatureLedgerTask } from './templates/feature-ledger.js';

export {
  renderSystemPrd,
  renderSystemArchitectureStub,
  renderSystemAdrStub,
  PLACEHOLDER_PHASE_1_TASK_DESCRIPTION,
  PLACEHOLDER_PHASE_2_TASK_DESCRIPTION,
} from './templates/system.js';
export { renderSystemLedgerYaml } from './templates/system-ledger.js';
export type { SystemLedger, SystemLedgerTask } from './templates/system-ledger.js';

export {
  updateSpec,
  SpecNotFoundError,
  PatchTierUpdateNotSupportedError,
  DuplicateSpecIdError,
  LedgerNotFoundError,
} from './update-spec.js';
export type { UpdateSpecResult } from './update-spec.js';

export { checkDrift } from './check-drift.js';
export type { DriftFinding, CheckDriftResult } from './check-drift.js';
