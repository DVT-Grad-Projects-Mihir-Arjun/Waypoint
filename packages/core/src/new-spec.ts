import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderPatchSpec } from './templates/patch.js';

/**
 * Thrown when `.waypoint/config.yaml` doesn't exist (or isn't a regular
 * file) — the repo hasn't been scaffolded yet. Callers should report
 * `error.message` and exit non-zero.
 *
 * Message is deliberately command-agnostic: this type is exported from
 * `@waypoint/core` and may be reused by future `new-feature`/`new-system`
 * commands (Story 1.3), so it must not bake in `new-patch`-specific framing.
 * Any command-specific prefix belongs at the CLI layer.
 */
export class WaypointNotInstalledError extends Error {
  constructor() {
    super(
      "this repository has not been initialized for Waypoint " +
        "('.waypoint/config.yaml' not found). Run 'waypoint install' first."
    );
    this.name = 'WaypointNotInstalledError';
  }
}

/**
 * Thrown when `<name>` fails validation: empty/missing, too long, or
 * containing a path separator, `..`, or any character outside
 * `[a-zA-Z0-9_-]` (which also rejects dotfiles, since the pattern requires
 * an alphanumeric first character). Thrown before any filesystem check or
 * write.
 */
export class InvalidSpecNameError extends Error {
  readonly invalidName: string;

  constructor(invalidName: string) {
    super(
      `'${invalidName}' is not a valid spec name. Names must be non-empty, at ` +
        `most ${MAX_NAME_LENGTH} characters, and contain only letters, numbers, '_', ` +
        "and '-', starting with a letter or number (no path separators, no '..', no " +
        'dotfiles).'
    );
    this.name = 'InvalidSpecNameError';
    this.invalidName = invalidName;
  }
}

/**
 * Thrown when `<name>` already exists as a spec at any tier
 * (`specs/patches/<name>.md`, `specs/features/<name>.md`,
 * `specs/systems/<name>.md`). Nothing is overwritten.
 */
export class SpecNameCollisionError extends Error {
  readonly collidingPath: string;

  constructor(collidingPath: string) {
    super(`a spec already exists at '${collidingPath}'. Choose a different name.`);
    this.name = 'SpecNameCollisionError';
    this.collidingPath = collidingPath;
  }
}

/** Result of a successful `createPatchSpec()` call. */
export interface CreatePatchSpecResult {
  /** Absolute path to the newly-written patch spec file. */
  path: string;
  /** The spec's frontmatter `id` (`patch-<date>-<name>`). */
  id: string;
}

// Matches the Design Notes regex exactly: rejects empty, path separators,
// '..', dotfiles, and anything else likely to escape `specs/patches/`.
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Keeps `<name>.md` well clear of typical filesystem filename limits
// (commonly 255 bytes) so an over-long name is rejected with the clear
// validation message below, not a raw OS error from the write itself.
const MAX_NAME_LENGTH = 100;

function isValidName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    NAME_PATTERN.test(name)
  );
}

/**
 * `YYYY-MM-DD`, from the local calendar date at write time (not UTC) — a
 * user running the command late at night or early morning should get the
 * date that matches their own "today," not UTC's.
 */
function todayIsoDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const SPEC_TIERS = ['patches', 'features', 'systems'] as const;

/**
 * Creates a patch-tier spec at `specs/patches/<name>.md` in `cwd`.
 *
 * Order of checks (each must fully precede the next, per the story's
 * Boundaries & Constraints):
 * 1. Validate `<name>` — before any filesystem check or write.
 * 2. Confirm the repo is installed (`.waypoint/config.yaml` exists).
 * 3. Confirm `<name>` doesn't collide with an existing spec at any tier.
 * 4. Write exactly one file: `specs/patches/<name>.md`.
 *
 * Patch tier has no approval step and no task ledger: the written
 * frontmatter has no `approved_by`/`approved_at`/ledger reference, and no
 * `tasks/*.ledger.yaml` file is created or touched.
 */
export async function createPatchSpec(
  cwd: string,
  name: string
): Promise<CreatePatchSpecResult> {
  if (!isValidName(name)) {
    throw new InvalidSpecNameError(name);
  }

  const configPath = path.join(cwd, '.waypoint', 'config.yaml');
  // A directory sitting at the config path is treated the same as "not
  // installed" — proceeding would be wrong, since there's no real config to
  // have installed the repo.
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new WaypointNotInstalledError();
  }

  for (const tier of SPEC_TIERS) {
    const candidate = path.join(cwd, 'specs', tier, `${name}.md`);
    if (existsSync(candidate)) {
      throw new SpecNameCollisionError(candidate);
    }
  }

  const createdAt = todayIsoDate();
  const content = renderPatchSpec(name, createdAt);
  const targetPath = path.join(cwd, 'specs', 'patches', `${name}.md`);

  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    // Exclusive create ('wx'): if another concurrent `new-patch` call won
    // the race between the collision check above and this write, fail
    // clearly instead of silently overwriting its file.
    await writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SpecNameCollisionError(targetPath);
    }
    throw err;
  }

  return { path: targetPath, id: `patch-${createdAt}-${name}` };
}
