import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderPatchSpec } from './templates/patch.js';
import { PLACEHOLDER_TASK_DESCRIPTION, renderFeatureSpec } from './templates/feature.js';
import { renderFeatureLedgerYaml } from './templates/feature-ledger.js';
import {
  PLACEHOLDER_PHASE_1_TASK_DESCRIPTION,
  PLACEHOLDER_PHASE_2_TASK_DESCRIPTION,
  renderSystemAdrStub,
  renderSystemArchitectureStub,
  renderSystemPrd,
} from './templates/system.js';
import { renderSystemLedgerYaml } from './templates/system-ledger.js';

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
 * (`specs/patches/<name>.md`, `specs/features/<name>.md`, or
 * `specs/systems/<name>` — the latter checked as a directory-or-file, since
 * System's own output is a spec-set directory, not a single `<name>.md`
 * file). Nothing is overwritten.
 */
export class SpecNameCollisionError extends Error {
  readonly collidingPath: string;

  constructor(collidingPath: string) {
    super(`a spec already exists at '${collidingPath}'. Choose a different name.`);
    this.name = 'SpecNameCollisionError';
    this.collidingPath = collidingPath;
  }
}

/**
 * Thrown when `tasks/<id>.ledger.yaml` (`id` = the spec's full frontmatter
 * `id`, e.g. `feat-2026-08-21-demo-feature` — not the bare `<name>`) already
 * exists. Nothing is overwritten in either case this is thrown:
 * - The simple case: the ledger path already collides before either new
 *   file is written, so nothing has been written yet.
 * - The TOCTOU case: the spec file was already written by this call, but
 *   the ledger write then lost a race to something else that created the
 *   same ledger path in the meantime. The just-written spec file is rolled
 *   back before this error is thrown, so this error still always means
 *   "neither file exists as a result of this call," not just "neither file
 *   was ever attempted."
 */
export class LedgerNameCollisionError extends Error {
  readonly collidingPath: string;

  constructor(collidingPath: string) {
    super(
      `a task ledger already exists at '${collidingPath}'. Choose a different name.`
    );
    this.name = 'LedgerNameCollisionError';
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

/** Result of a successful `createFeatureSpec()` call. */
export interface CreateFeatureSpecResult {
  /** Absolute path to the newly-written feature spec file. */
  path: string;
  /** Absolute path to the newly-written matching task ledger file. */
  ledgerPath: string;
  /** The spec's frontmatter `id` (`feat-<date>-<name>`), also the ledger's `spec_id`. */
  id: string;
}

/** Result of a successful `createSystemSpec()` call. */
export interface CreateSystemSpecResult {
  /** Absolute path to the newly-written `specs/systems/<name>/` directory. */
  specDir: string;
  /** Absolute path to the newly-written `prd.md` inside `specDir`. */
  prdPath: string;
  /** Absolute path to the newly-written `architecture.md` inside `specDir`. */
  architecturePath: string;
  /** Absolute path to the newly-written `adr.md` inside `specDir`. */
  adrPath: string;
  /** Absolute path to the newly-written matching task ledger file. */
  ledgerPath: string;
  /** The spec's frontmatter `id` (`system-<date>-<name>`), also the ledger's `spec_id`. */
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
type SpecTier = (typeof SPEC_TIERS)[number];

/**
 * The filesystem path checked for a name collision at a given tier —
 * tier-shape-aware, since System's own output is a spec-set directory, not
 * a single file:
 * - `patches`/`features`: `specs/<tier>/<name>.md`, a file (unchanged
 *   behavior from before this helper existed).
 * - `systems`: `specs/systems/<name>`, no extension, checked as a
 *   directory-or-file — whatever already sits at that path (a leftover
 *   plain file included) counts as a collision.
 *
 * Shared by `createPatchSpec`/`createFeatureSpec`/`createSystemSpec` so all
 * three tiers detect a cross-tier collision against `systems` the same way.
 */
function specTierCollisionPath(cwd: string, tier: SpecTier, name: string): string {
  return tier === 'systems'
    ? path.join(cwd, 'specs', tier, name)
    : path.join(cwd, 'specs', tier, `${name}.md`);
}

/**
 * True only if `.waypoint/config.yaml` exists and is a regular file. Any
 * failure along the way — the path missing, a directory sitting there
 * instead, or `statSync` itself throwing (e.g. `EACCES` reading the parent
 * directory, or an ENOENT race if the path is removed between the
 * `existsSync` and `statSync` calls) — is treated the same as "not
 * installed," so a raw filesystem error never surfaces in place of the
 * documented `WaypointNotInstalledError`.
 */
function isInstalled(cwd: string): boolean {
  const configPath = path.join(cwd, '.waypoint', 'config.yaml');
  try {
    return existsSync(configPath) && statSync(configPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Best-effort rollback of a just-written spec file when its paired ledger
 * write subsequently fails, for any reason. Swallows its own failure — same
 * best-effort pattern as `scaffold.ts`'s lock release — so a rollback error
 * never masks the error that triggered the rollback in the first place.
 */
async function rollbackSpecFile(targetPath: string): Promise<void> {
  await rm(targetPath, { force: true }).catch(() => {
    // Best-effort: nothing more can be done here, and the caller's own
    // error (the real reason we're rolling back) must still win.
  });
}

/**
 * Best-effort rollback of a just-written `specs/systems/<name>/` directory
 * (and everything already written inside it) when a later write in the same
 * `createSystemSpec()` call fails, for any reason. Same best-effort,
 * swallow-your-own-failure pattern as `rollbackSpecFile()` above — a
 * rollback error must never mask the error that triggered it.
 */
async function rollbackSpecDir(specDir: string): Promise<void> {
  await rm(specDir, { recursive: true, force: true }).catch(() => {
    // Best-effort: see rollbackSpecFile()'s comment above.
  });
}

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

  // A directory sitting at the config path (or any other statSync failure)
  // is treated the same as "not installed" — proceeding would be wrong,
  // since there's no real config to have installed the repo.
  if (!isInstalled(cwd)) {
    throw new WaypointNotInstalledError();
  }

  for (const tier of SPEC_TIERS) {
    const candidate = specTierCollisionPath(cwd, tier, name);
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

/**
 * Creates a feature-tier spec at `specs/features/<name>.md`, plus its
 * matching task ledger at `tasks/<id>.ledger.yaml` — keyed by the spec's
 * full frontmatter `id` (`feat-<date>-<name>`), not the bare `<name>`,
 * matching `docs/architecture.md`'s documented `tasks/<spec-id>.ledger.yaml`
 * convention so Epic 3's `waypoint verify <spec-id> <task-id>` can locate it
 * directly — in `cwd`.
 *
 * Order of checks (each must fully precede the next, per the story's
 * Boundaries & Constraints):
 * 1. Validate `<name>` — before any filesystem check or write.
 * 2. Confirm the repo is installed (`.waypoint/config.yaml` exists).
 * 3. Confirm `<name>` doesn't collide with an existing spec at any tier.
 * 4. Confirm `<id>`'s ledger path doesn't already collide.
 * 5. Write both files: `specs/features/<name>.md` and
 *    `tasks/<id>.ledger.yaml`.
 *
 * Feature tier has one approval gate (frontmatter `approved_by`/`approved_at`,
 * both `null` until `waypoint approve` runs — Epic 3's scope) and exactly one
 * placeholder task/ledger-row pair — parsing a human-edited task list into
 * ledger rows is `waypoint update`'s delta-sync scope (Epic 2 Story 2.1),
 * out of bounds here.
 */
export async function createFeatureSpec(
  cwd: string,
  name: string
): Promise<CreateFeatureSpecResult> {
  if (!isValidName(name)) {
    throw new InvalidSpecNameError(name);
  }

  // Same "directory at the config path (or any other statSync failure)
  // counts as not installed" rule as createPatchSpec.
  if (!isInstalled(cwd)) {
    throw new WaypointNotInstalledError();
  }

  for (const tier of SPEC_TIERS) {
    const candidate = specTierCollisionPath(cwd, tier, name);
    if (existsSync(candidate)) {
      throw new SpecNameCollisionError(candidate);
    }
  }

  // `id` must be computed before the ledger-path collision check (and
  // reused, not recomputed, for the actual write below) since the ledger
  // filename is keyed by the full `id`, not the bare `<name>`.
  const createdAt = todayIsoDate();
  const id = `feat-${createdAt}-${name}`;
  const ledgerPath = path.join(cwd, 'tasks', `${id}.ledger.yaml`);
  if (existsSync(ledgerPath)) {
    throw new LedgerNameCollisionError(ledgerPath);
  }

  const specContent = renderFeatureSpec(name, createdAt);
  const ledgerContent = renderFeatureLedgerYaml(id, PLACEHOLDER_TASK_DESCRIPTION);
  const targetPath = path.join(cwd, 'specs', 'features', `${name}.md`);

  await mkdir(path.dirname(targetPath), { recursive: true });

  try {
    // Exclusive create ('wx'): same TOCTOU protection as createPatchSpec —
    // if another concurrent call won the race between the collision check
    // above and this write, fail clearly instead of silently overwriting.
    await writeFile(targetPath, specContent, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SpecNameCollisionError(targetPath);
    }
    throw err;
  }

  try {
    // `tasks/`'s own mkdir is deliberately inside this try, not hoisted
    // above the spec write like `specs/features`'s: the spec write has
    // already succeeded by this point, so a failure here — whether from
    // this mkdir (e.g. `tasks/` blocked by a pre-existing plain file:
    // ENOTDIR on Linux, EEXIST on macOS) or from the writeFile itself
    // (EEXIST from a lost TOCTOU race, EACCES, ENOSPC, ...) — must roll the
    // spec file back the same way, for the same reason: leaving it in place
    // would orphan it, and every future retry of this name would hit
    // SpecNameCollisionError forever with no repair path.
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, ledgerContent, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    await rollbackSpecFile(targetPath);
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LedgerNameCollisionError(ledgerPath);
    }
    throw err;
  }

  return { path: targetPath, ledgerPath, id };
}

/**
 * Creates a system-tier spec-set at `specs/systems/<name>/` (`prd.md`,
 * `architecture.md`, `adr.md` — matching docs/architecture.md's own
 * `templates/system/` source-tree listing exactly), plus a matching phased
 * task ledger at `tasks/<id>.ledger.yaml` (`id` = `system-<date>-<name>`), in
 * `cwd`.
 *
 * Order of checks (each must fully precede the next, per the story's
 * Boundaries & Constraints):
 * 1. Validate `<name>` — before any filesystem check or write.
 * 2. Confirm the repo is installed (`.waypoint/config.yaml` exists).
 * 3. Confirm `<name>` doesn't collide with an existing spec at any tier
 *    (via `specTierCollisionPath`, tier-shape-aware for `systems`).
 * 4. Confirm `<id>`'s ledger path doesn't already collide.
 * 5. Write all four files: `specs/systems/<name>/{prd.md,architecture.md,adr.md}`
 *    and `tasks/<id>.ledger.yaml`.
 *
 * System tier has the same single `approved_by`/`approved_at: null` pair as
 * Feature tier (nothing has been approved yet regardless of tier) plus two
 * phase sections, each with exactly one placeholder task/ledger-row pair —
 * the actual per-phase `waypoint approve` mechanism is Epic 3's scope, out
 * of bounds here.
 *
 * No partial writes survive any failure: if any of the four writes fails
 * after an earlier one already succeeded, the whole `specs/systems/<name>/`
 * directory (and the ledger file, if that step was reached) is rolled back
 * before this rejects — the same "neither/none written" contract
 * `createFeatureSpec` already guarantees for its two files.
 */
export async function createSystemSpec(
  cwd: string,
  name: string
): Promise<CreateSystemSpecResult> {
  if (!isValidName(name)) {
    throw new InvalidSpecNameError(name);
  }

  // Same "directory at the config path (or any other statSync failure)
  // counts as not installed" rule as createPatchSpec/createFeatureSpec.
  if (!isInstalled(cwd)) {
    throw new WaypointNotInstalledError();
  }

  for (const tier of SPEC_TIERS) {
    const candidate = specTierCollisionPath(cwd, tier, name);
    if (existsSync(candidate)) {
      throw new SpecNameCollisionError(candidate);
    }
  }

  // `id` must be computed before the ledger-path collision check (and
  // reused, not recomputed, for the actual write below) since the ledger
  // filename is keyed by the full `id`, not the bare `<name>`.
  const createdAt = todayIsoDate();
  const id = `system-${createdAt}-${name}`;
  const ledgerPath = path.join(cwd, 'tasks', `${id}.ledger.yaml`);
  if (existsSync(ledgerPath)) {
    throw new LedgerNameCollisionError(ledgerPath);
  }

  const specDir = path.join(cwd, 'specs', 'systems', name);
  const prdPath = path.join(specDir, 'prd.md');
  const architecturePath = path.join(specDir, 'architecture.md');
  const adrPath = path.join(specDir, 'adr.md');

  const prdContent = renderSystemPrd(name, createdAt);
  const architectureContent = renderSystemArchitectureStub();
  const adrContent = renderSystemAdrStub();
  const ledgerContent = renderSystemLedgerYaml(
    id,
    PLACEHOLDER_PHASE_1_TASK_DESCRIPTION,
    PLACEHOLDER_PHASE_2_TASK_DESCRIPTION
  );

  await mkdir(specDir, { recursive: true });

  try {
    // Exclusive create ('wx') on the first file written into the new
    // directory: if another concurrent `new-system` call won the race
    // between the collision check above and this write (e.g. it also
    // reached `mkdir(specDir, ...)` first, which `recursive: true` lets
    // both callers succeed at), fail clearly instead of silently mixing
    // this call's files into that call's directory.
    await writeFile(prdPath, prdContent, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Someone else — a concurrent `new-system` call that won the TOCTOU
      // race, most likely — already owns `specDir`: it (or its own
      // in-progress files) must not be deleted out from under it, so no
      // rollback here, only the collision error.
      throw new SpecNameCollisionError(specDir);
    }
    // Any other failure (EACCES, disk full, ...) means `mkdir(specDir, ...)`
    // above already created the (possibly empty) directory before this
    // write was attempted, and nothing else could have raced in to claim
    // it (that case is EEXIST, handled above) — so it's this call's own,
    // and must not survive as an orphan: the collision check above treats
    // any existing path at `specs/systems/<name>` as a collision, so
    // leaving it behind would make every future retry of this name fail
    // forever with no repair path.
    await rollbackSpecDir(specDir);
    throw err;
  }

  try {
    // `prd.md` above already exclusively claimed `specDir` for this call, so
    // `architecture.md`/`adr.md` are also written exclusively ('wx'): if
    // either path somehow already has content (a TOCTOU race, or leftover
    // state from an interrupted prior attempt), fail clearly and roll back
    // rather than silently overwriting it.
    await writeFile(architecturePath, architectureContent, { encoding: 'utf8', flag: 'wx' });
    await writeFile(adrPath, adrContent, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    await rollbackSpecDir(specDir);
    throw err;
  }

  try {
    // Same "the spec-set has already succeeded by this point, so a failure
    // here must roll it all back" reasoning as createFeatureSpec's own
    // ledger-write step.
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, ledgerContent, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    await rollbackSpecDir(specDir);
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LedgerNameCollisionError(ledgerPath);
    }
    throw err;
  }

  return { specDir, prdPath, architecturePath, adrPath, ledgerPath, id };
}
