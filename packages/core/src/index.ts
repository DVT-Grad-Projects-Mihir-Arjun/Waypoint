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
