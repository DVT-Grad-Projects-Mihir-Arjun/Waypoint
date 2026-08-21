import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDrift, extractReferences, listEligibleSpecs } from './check-drift.js';
import { createFeatureSpec, createSystemSpec } from './new-spec.js';
import { scaffold } from './scaffold.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-check-drift-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Hand-sets a spec file's frontmatter `status` field (waypoint approve is out of this story's scope). */
function setStatus(specPath: string, status: string): void {
  const raw = readFileSync(specPath, 'utf8');
  writeFileSync(specPath, raw.replace(/^status: .*$/m, `status: ${status}`), 'utf8');
}

/** Appends extra markdown to the end of a spec file's body (after any frontmatter). */
function appendBody(specPath: string, extra: string): void {
  const raw = readFileSync(specPath, 'utf8');
  writeFileSync(specPath, `${raw.trimEnd()}\n\n${extra}\n`, 'utf8');
}

// -- extractReferences --------------------------------------------------------

describe('extractReferences', () => {
  it('classifies a slash-containing token as path-like', () => {
    const refs = extractReferences('See `packages/core/src/foo.ts` for details.');
    expect(refs).toEqual([{ type: 'path', value: 'packages/core/src/foo.ts' }]);
  });

  it('classifies a bare <name>.<ext> token as path-like', () => {
    const refs = extractReferences('Update `package.json` accordingly.');
    expect(refs).toEqual([{ type: 'path', value: 'package.json' }]);
  });

  it('strips a trailing :<line> suffix from a path-like token before resolution', () => {
    const refs = extractReferences('See `packages/core/src/foo.ts:42` for the exact line.');
    expect(refs).toEqual([{ type: 'path', value: 'packages/core/src/foo.ts' }]);
  });

  it('classifies an identifier() token as symbol-like, stripping the trailing ()', () => {
    const refs = extractReferences('Calls `refreshToken()` internally.');
    expect(refs).toEqual([{ type: 'symbol', value: 'refreshToken' }]);
  });

  it('classifies a PascalCase token as symbol-like', () => {
    const refs = extractReferences('See the `UserSession` class.');
    expect(refs).toEqual([{ type: 'symbol', value: 'UserSession' }]);
  });

  it('ignores an ordinary backticked word that is neither path- nor symbol-shaped', () => {
    const refs = extractReferences('The task status is `pending` until reviewed, never `null`.');
    expect(refs).toEqual([]);
  });

  it('ignores lowercase identifiers with no call parens (not PascalCase, not a call)', () => {
    const refs = extractReferences('The variable `count` tracks retries.');
    expect(refs).toEqual([]);
  });

  it('ignores single-hump capitalized words and all-caps acronyms (not genuine multi-hump PascalCase)', () => {
    const refs = extractReferences(
      '`Given` a user, `When` they log in, `Then` a `TODO` is created.'
    );
    expect(refs).toEqual([]);
  });

  it('still classifies a genuine multi-hump PascalCase identifier as symbol-like', () => {
    const refs = extractReferences('See `CheckDriftResult` for the shape.');
    expect(refs).toEqual([{ type: 'symbol', value: 'CheckDriftResult' }]);
  });

  it('ignores a URL entirely rather than misclassifying it as a stale path', () => {
    const refs = extractReferences('See `https://example.com` for details.');
    expect(refs).toEqual([]);
  });

  it('ignores a decimal-number-shaped token rather than misclassifying it as a stale path', () => {
    const refs = extractReferences('Bump the version to `1.0` (or `2.5`).');
    expect(refs).toEqual([]);
  });

  it('de-duplicates the same reference repeated multiple times in one body', () => {
    const refs = extractReferences('Calls `refreshToken()` here and `refreshToken()` again.');
    expect(refs).toEqual([{ type: 'symbol', value: 'refreshToken' }]);
  });

  it('returns an empty array for a body with no backtick tokens at all', () => {
    expect(extractReferences('Plain prose, nothing quoted.')).toEqual([]);
  });
});

// -- listEligibleSpecs --------------------------------------------------------

describe('listEligibleSpecs', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('excludes draft specs', async () => {
    await createFeatureSpec(tmpDir, 'still-draft');
    const eligible = await listEligibleSpecs(tmpDir);
    expect(eligible).toEqual([]);
  });

  it('includes an approved feature spec', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');

    const eligible = await listEligibleSpecs(tmpDir);
    expect(eligible).toEqual([{ id: created.id, tier: 'feature', files: [created.path] }]);
  });

  it('includes an in-progress feature spec', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'in-progress');

    const eligible = await listEligibleSpecs(tmpDir);
    expect(eligible.map((e) => e.id)).toEqual([created.id]);
  });

  it('excludes a done spec', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'done');

    const eligible = await listEligibleSpecs(tmpDir);
    expect(eligible).toEqual([]);
  });

  it('applies status as the only filter, with no tier exclusion — a hand-approved patch spec is included too', async () => {
    mkdirSync(path.join(tmpDir, 'specs', 'patches'), { recursive: true });
    const patchPath = path.join(tmpDir, 'specs', 'patches', 'trivial-fix.md');
    const patchId = 'patch-2026-08-21-trivial-fix';
    writeFileSync(
      patchPath,
      `---\nid: ${patchId}\ntier: patch\nstatus: approved\ncreated_at: 2026-08-21\n---\n\n# trivial-fix\n\n## Summary\n\nA trivial patch.\n`
    );

    const eligible = await listEligibleSpecs(tmpDir);
    expect(eligible).toEqual([{ id: patchId, tier: 'patch', files: [patchPath] }]);
  });

  it('for an eligible system spec, includes prd.md plus architecture.md and adr.md', async () => {
    const created = await createSystemSpec(tmpDir, 'billing');
    setStatus(created.prdPath, 'approved');

    const eligible = await listEligibleSpecs(tmpDir);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.id).toBe(created.id);
    expect(new Set(eligible[0]!.files)).toEqual(
      new Set([created.prdPath, created.architecturePath, created.adrPath])
    );
  });
});

// -- checkDrift — I/O matrix rows ---------------------------------------------

describe('checkDrift — stale path reference', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('flags a backtick-referenced path that no longer exists, naming the spec and the path, with a non-empty findings list', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See `packages/core/src/does-not-exist.ts` for context.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([
      {
        specId: created.id,
        specPath: created.path,
        type: 'path',
        reference: 'packages/core/src/does-not-exist.ts',
      },
    ]);
  });

  it('strips a trailing :<line> suffix before checking existence', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See `packages/core/src/does-not-exist.ts:42` for context.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.reference).toBe('packages/core/src/does-not-exist.ts');
  });
});

describe('checkDrift — stale symbol reference', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('flags a backtick-referenced symbol found nowhere in the repo, naming the spec and the symbol', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'Calls `totallyMissingHelper()` during login.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([
      {
        specId: created.id,
        specPath: created.path,
        type: 'symbol',
        reference: 'totallyMissingHelper',
      },
    ]);
  });

  it('flags a missing PascalCase symbol the same way', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See the `GhostClass` type.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([
      { specId: created.id, specPath: created.path, type: 'symbol', reference: 'GhostClass' },
    ]);
  });

  it("does not resolve a symbol against its own backtick occurrence in the spec being scanned (self-match doesn't count)", async () => {
    // Deliberately no other file in the repo contains "totallyMissingHelper"
    // anywhere — the only occurrence is the reference itself. If the
    // resolver counted that occurrence, this would never be flagged as
    // stale, and the drift check would be permanently vacuous for symbols.
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'Calls `totallyMissingHelper()` during login.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toHaveLength(1);
  });
});

describe('checkDrift — valid references', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('does not flag a path reference that resolves, and exits clean (no findings)', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    // AGENTS.md is written by scaffold() and really exists at the repo root.
    appendBody(created.path, 'See `AGENTS.md` for the agent contract.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.referencesChecked).toBe(1);
  });

  it('does not flag a symbol reference that resolves against real code elsewhere in the repo', async () => {
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'util.ts'), 'export function realHelper() {}\n');

    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'Calls `realHelper()` on login.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.referencesChecked).toBe(1);
  });
});

describe('checkDrift — draft/done specs skipped', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('does not flag a stale reference in a draft spec (excluded by the status filter)', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    // status stays 'draft' (default) — never set to approved/in-progress.
    appendBody(created.path, 'See `packages/core/src/does-not-exist.ts` for context.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.nothingToCheck).toBe(true);
  });

  it('does not flag a stale reference in a done spec (excluded by the status filter)', async () => {
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'done');
    appendBody(created.path, 'See `packages/core/src/does-not-exist.ts` for context.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.nothingToCheck).toBe(true);
  });
});

describe('checkDrift — nothing to check', () => {
  it('reports nothing-to-check plainly (not an error), exit-relevant findings empty, when no specs exist at all', async () => {
    await scaffold(tmpDir);

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.specsScanned).toBe(0);
    expect(result.nothingToCheck).toBe(true);
  });

  it('reports nothing-to-check when specs exist but none are approved/in-progress', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    appendBody(created.path, 'See `packages/core/src/does-not-exist.ts` for context.');
    // status stays 'draft'.

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.nothingToCheck).toBe(true);
  });

  it('reports nothing-to-check when an eligible spec exists but has no classifiable reference at all', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'The task status is `pending` until reviewed.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.specsScanned).toBe(1);
    expect(result.referencesChecked).toBe(0);
    expect(result.nothingToCheck).toBe(true);
  });
});

describe('checkDrift — materially-changed symbol (out of MVP scope)', () => {
  beforeEach(async () => {
    await scaffold(tmpDir);
  });

  it('does not flag a symbol whose behavior/signature diverged but which still exists by name', async () => {
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    // The spec claims this takes no arguments; the real signature has since
    // changed to take one. MVP is existence-only, so this must not be
    // flagged — detecting the divergence itself is explicitly deferred.
    writeFileSync(
      path.join(tmpDir, 'src', 'util.ts'),
      'export function realHelper(reason: string) {}\n'
    );

    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'Calls `realHelper()` on login.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
  });
});

// -- Acceptance criteria ------------------------------------------------------

describe('checkDrift — acceptance: ordinary words are never flagged or resolution-checked', () => {
  it('never counts or flags a backticked word that is neither path- nor symbol-shaped', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'The task status is `pending`, never `null`.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.referencesChecked).toBe(0);
  });
});

describe('checkDrift — acceptance: every finding names its own spec', () => {
  it('names each drifted spec separately when drift spans multiple specs, not just the first one found', async () => {
    await scaffold(tmpDir);
    const first = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(first.path, 'approved');
    appendBody(first.path, 'See `packages/core/src/missing-one.ts` for context.');

    const second = await createFeatureSpec(tmpDir, 'billing-webhook');
    setStatus(second.path, 'approved');
    appendBody(second.path, 'See `packages/core/src/missing-two.ts` for context.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toHaveLength(2);
    const bySpec = new Map(result.findings.map((f) => [f.specId, f.reference]));
    expect(bySpec.get(first.id)).toBe('packages/core/src/missing-one.ts');
    expect(bySpec.get(second.id)).toBe('packages/core/src/missing-two.ts');
  });
});

describe('checkDrift — system tier scans architecture.md and adr.md too', () => {
  it('flags a stale symbol reference written into architecture.md, attributed to the system spec id from prd.md', async () => {
    await scaffold(tmpDir);
    const created = await createSystemSpec(tmpDir, 'billing');
    setStatus(created.prdPath, 'approved');
    appendBody(created.architecturePath, 'Relies on `vanishedComponent()` at startup.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([
      {
        specId: created.id,
        specPath: created.architecturePath,
        type: 'symbol',
        reference: 'vanishedComponent',
      },
    ]);
  });
});

// -- Code review follow-ups ---------------------------------------------------

describe('checkDrift — ordinary capitalized prose words are never flagged', () => {
  it('does not flag Given/When/Then/TODO backtick-quoted in ordinary prose', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(
      created.path,
      '`Given` a logged-in user, `When` they refresh, `Then` the session ' +
        'persists. `TODO` write more scenarios.'
    );

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.referencesChecked).toBe(0);
    expect(result.nothingToCheck).toBe(true);
  });
});

describe("checkDrift — a URL is never flagged as a stale path", () => {
  it('ignores a backtick-quoted URL entirely', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See `https://example.com` for the upstream API docs.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.referencesChecked).toBe(0);
  });
});

describe('checkDrift — a decimal-shaped token is never flagged as a stale path', () => {
  it('ignores a backtick-quoted version-looking decimal number', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'Bump the schema version to `1.0`.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.referencesChecked).toBe(0);
  });
});

describe('checkDrift — absolute/traversal path references never resolve as found', () => {
  it('flags an absolute-looking path reference as stale, even if that absolute path exists on the host machine', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    // /etc/hosts exists on the machine running the test, but must never be
    // probed — an absolute-looking reference is refused outright.
    appendBody(created.path, 'See `/etc/hosts` for context.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([
      { specId: created.id, specPath: created.path, type: 'path', reference: '/etc/hosts' },
    ]);
  });

  it('flags a path reference containing a .. traversal segment as stale, even if it would otherwise resolve outside the repo root', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'See `../does-not-matter/AGENTS.md` for context.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([
      {
        specId: created.id,
        specPath: created.path,
        type: 'path',
        reference: '../does-not-matter/AGENTS.md',
      },
    ]);
  });
});

describe('checkDrift — a $-prefixed symbol resolves correctly when it exists in the repo', () => {
  it('does not flag `$scope()` when "$scope" is genuinely present elsewhere in the repo', async () => {
    await scaffold(tmpDir);
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'controller.js'), 'this.$scope.digest();\n');

    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'Calls `$scope()` to trigger a digest cycle.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.referencesChecked).toBe(1);
  });

  it('still flags `$scope()` when "$scope" is genuinely absent from the rest of the repo', async () => {
    await scaffold(tmpDir);
    const created = await createFeatureSpec(tmpDir, 'auth-refresh');
    setStatus(created.path, 'approved');
    appendBody(created.path, 'Calls `$scope()` to trigger a digest cycle.');

    const result = await checkDrift(tmpDir);

    expect(result.findings).toEqual([
      { specId: created.id, specPath: created.path, type: 'symbol', reference: '$scope' },
    ]);
  });
});
