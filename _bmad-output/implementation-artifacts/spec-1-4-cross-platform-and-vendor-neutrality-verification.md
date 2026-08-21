---
title: 'Story 1.4: Cross-platform and vendor-neutrality verification'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: 'f8ccdb9f48aff2de63da5eda977f3d5caf791013'
review_loop_iteration: 1
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Waypoint's two core promises — identical behavior on macOS/Linux/WSL and zero vendor/AI-model network calls — are only design intentions today, with no automated check proving either one.

**Approach:** Add a GitHub Actions CI workflow that runs the full test suite across a 3-OS matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`), and a direct negative test asserting none of the CLI's currently-existing commands (`install`, `new-patch`, `new-feature`) make an outbound network call.

## Boundaries & Constraints

**Always:**
- Add `.github/workflows/ci.yml`: a matrix job over `ubuntu-latest`/`macos-latest`/`windows-latest` running `npm ci`, `npm run build`, and `npm test` on every `push` and `pull_request`, with `fail-fast: false` so all three legs always run to completion and report independently.
- No matrix leg may be marked `continue-on-error` or otherwise allowed to fail — a single-leg failure must fail the overall workflow, per the story's own "not a flaky test to retry past" requirement.
- Add a vendor-neutrality test that spies on `http.request`/`http.get`/`https.request`/`https.get`/`fetch`, runs `install` → `new-patch` → `new-feature` end to end against a scratch temp directory, and asserts every spy was never called.
- Add a root `.gitattributes` forcing LF line endings repo-wide, so `packages/cli/src/index.ts`'s `#!/usr/bin/env node` shebang (and any future shell/hook script) is never silently corrupted to CRLF by a Windows checkout — this is what actually makes the new `windows-latest` matrix leg a meaningful test of shebang handling, per `epic-1-context.md`'s Technical Decisions.
- Add a source-level test asserting `packages/cli/src/index.ts` starts with the exact `#!/usr/bin/env node` line, LF-terminated (not CRLF) — a direct, build-independent check of shebang handling.
- Add a path-construction test asserting `createPatchSpec`/`createFeatureSpec`'s returned paths equal `path.join(...)`-constructed expectations exactly — makes explicit that the existing suite's `path.join`-built assertions (which the new Windows leg now exercises) are this story's path-separator-sensitivity verification, per the same Technical Decisions note.

**Ask First:** none anticipated — scope is fixed by the Always bullets above.

**Never:**
- Add hook-installation or gate-script CI coverage — neither exists yet (Epic 3). The workflow runs the whole test suite generically, so it will start covering hook/gate behavior automatically once Epic 3 adds tests for them, with no changes needed to this workflow file.
- Test `update`/`verify`/`approve`/`check-drift`/`status`/`gate` for vendor neutrality — none of those commands exist yet (Epics 2/3/5); the vendor-neutrality test covers only commands that exist today and is written to be trivially extended (add one more command call) as each lands.
- Touch `install`/`new-patch`/`new-feature`'s own implementation — this story only adds a workflow file and a test file.
- Add retry-on-failure or flaky-test-tolerance logic anywhere in the workflow.

</frozen-after-approval>

## Code Map

- `.github/workflows/ci.yml` (new) -- 3-OS matrix CI (`ubuntu-latest`/`macos-latest`/`windows-latest`) running `npm ci && npm run build && npm test` on every push/PR, `fail-fast: false`, no leg allowed to fail
- `packages/cli/src/vendor-neutrality.test.ts` (new) -- spies on `node:http`/`node:https`/`fetch`, runs `installCommand` → `newPatchCommand` → `newFeatureCommand` (`packages/cli/src/commands/install.ts`, `new-patch.ts`, `new-feature.ts`) against one scratch tmp-dir fixture, same `mkdtempSync`/`afterEach rmSync` pattern as `install.test.ts:1`
- `packages/cli/src/install.test.ts` -- reuse as a style reference only (no changes); its `todayIsoDateForTest()` pattern is not needed here since this test never inspects a ledger filename
- `.gitattributes` (new) -- force LF repo-wide so the shebang and any future shell script survive a Windows checkout unmodified
- `packages/cli/src/index.ts` -- no code change; its existing `#!/usr/bin/env node` first line is the subject of the new shebang test
- `packages/cli/src/shebang.test.ts` (new) -- reads `index.ts`'s raw source, asserts the exact LF-terminated shebang line
- `packages/core/src/new-spec.test.ts` (extend) -- add one test asserting `createPatchSpec`/`createFeatureSpec`'s returned paths equal `path.join(...)`-built expectations exactly

## Tasks & Acceptance

**Execution:**
- [x] `.github/workflows/ci.yml` -- add the 3-OS matrix CI workflow -- gives NFR5 continuous, automated verification instead of an untested design intention
- [x] `packages/cli/src/vendor-neutrality.test.ts` -- add the network-call negative test covering `install`/`new-patch`/`new-feature` -- direct proof of NFR1, per the AC's own "a negative test asserts this directly" wording
- [x] `.gitattributes` -- force LF line endings repo-wide -- makes the Windows leg a meaningful shebang-handling test instead of a checkout-corruption risk
- [x] `packages/cli/src/shebang.test.ts` -- assert `index.ts`'s exact, LF-terminated shebang line -- direct, build-independent shebang-handling verification
- [x] `packages/core/src/new-spec.test.ts` -- add the `path.join`-equality test for `createPatchSpec`/`createFeatureSpec` -- makes path-separator-sensitivity verification explicit rather than implicit

**Acceptance Criteria:**
- Given `.github/workflows/ci.yml`, when inspected, then it defines a matrix over exactly `ubuntu-latest`, `macos-latest`, and `windows-latest`, runs build+test on each, and marks no leg `continue-on-error`
- Given the vendor-neutrality test, when it runs, then it asserts zero calls to `http.request`, `http.get`, `https.request`, `https.get`, and `fetch` across a full `install` → `new-patch` → `new-feature` run
- Given `.gitattributes` and the shebang test, when `index.ts` is checked out on any OS, then its first line stays byte-identical (`#!/usr/bin/env node\n`)
- Given the new path-construction test, when it runs on any OS, then the asserted paths match `path.join(...)` exactly

## Spec Change Log

- 2026-08-21: Implemented per spec. Both tasks complete; `npm test` (68/68, including the new vendor-neutrality test) and `npm run build` both pass. Both acceptance criteria independently re-verified: the CI workflow YAML was parsed and inspected directly (exact 3-OS matrix, `fail-fast: false`, no `continue-on-error`/retry anywhere in the file), and the vendor-neutrality test was run standalone and confirmed passing, asserting zero calls to `http.request`/`http.get`/`https.request`/`https.get`/`fetch` across a full `install` → `new-patch` → `new-feature` run. The real cross-platform Actions signal can only be observed after pushing, per the spec's own Design Notes. No boundary/constraint deviations.
- 2026-08-21: Review (blind-hunter) found that `epic-1-context.md`'s Technical Decisions explicitly name "shebang handling and path-separator sensitivity" as this story's specific cross-platform test focus, but neither the workflow nor the vendor-neutrality test exercised either concern. Human chose to expand scope now rather than defer: added three frozen Always bullets (`.gitattributes` forcing LF, a shebang source-check test, and a `path.join`-equality test) plus their corresponding tasks/ACs. KEEP: the CI workflow shape, the vendor-neutrality test's design, and everything else already implemented survive unchanged — this is additive, not a revision of prior work. Re-implementing next, alongside 10 mechanical patch-level findings from the same review round.
- 2026-08-21: All 3 scope additions and all 10 mechanical findings applied: `.gitattributes` (LF repo-wide) and `.nvmrc` (single Node-version source of truth, replacing the hardcoded `'22'`) added at the repo root; `ci.yml` gained `defaults.run.shell: bash` (making the Windows leg an actual Git-Bash/WSL-proxy run), `timeout-minutes: 15`, `permissions: { contents: read }`, a `concurrency` cancel-in-progress group, and `cache: 'npm'`; `vendor-neutrality.test.ts` now also spies on `net.connect`/`child_process.exec`/`child_process.spawn`, checkpoints its assertions after each of `install`/`new-patch`/`new-feature` (so a failure names exactly which command was responsible), guards its `afterEach` cleanup against an unassigned `tmpDir` and a Windows `EBUSY`/`EPERM` failure, and carries an explicit 30s test timeout; `shebang.test.ts` and two new path-separator-sensitivity tests in `new-spec.test.ts` were added per the scope amendment. `npm test` now 71/71; `npm run build` and the YAML structural check (exact matrix, `fail-fast: false`, no `continue-on-error`/retry, all new fields present) re-verified independently, all pass. 2 lower-priority findings (no path/branch filtering on CI triggers; the workflow isn't wired as a required branch-protection status check — this repo's current GitHub plan doesn't even support that yet) logged to `deferred-work.md` as deliberate policy/plan decisions for the human, not mechanical fixes.

## Design Notes

`fail-fast: false` is deliberate: it ensures all three OS legs finish and report independently, so a real cross-platform bug shows exactly which platform(s) it affects rather than being masked by GitHub's default fail-fast cancellation of in-flight legs. The workflow intentionally does not reference hooks, `gate()`, or `verify`/`approve`/`check-drift`/`status` — see the Never section; this keeps the CI file stable as those commands land in later epics, since it verifies "the whole test suite, cross-platform" rather than any specific command.

The true integration signal (the matrix actually running green on all three OS runners) can only be observed after this branch is pushed to GitHub — it cannot be executed locally. Verification below is limited to local test/build success plus a structural check that the YAML parses and matches the intended shape; treat the first real Actions run on the pushed branch as the final confirmation.

## Verification

**Commands:**
- `npm test` -- expected: `vendor-neutrality.test.ts` passes, confirming zero network calls across `install`/`new-patch`/`new-feature`
- `npm run build` -- expected: unaffected, still passes (this story adds no production code)
- `node -e "console.log(require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')))"` -- expected: parses without error; inspect the printed object to confirm the `os` matrix and the three `run` steps

**Manual checks (if no CLI):**
- After pushing, open the GitHub Actions run for this branch and confirm all three OS legs (`ubuntu-latest`, `macos-latest`, `windows-latest`) actually ran and passed

## Suggested Review Order

**CI workflow**

- The whole matrix: 3 OSes, `fail-fast: false`, no leg allowed to fail, Git-Bash shell pinning, timeout, least-privilege permissions, cancel-in-progress concurrency, npm caching, and a single-source Node version.
  [`ci.yml:1`](../../.github/workflows/ci.yml#L1)

**Vendor-neutrality negative test (NFR1)**

- Full spy surface (`http`/`https`/`fetch`/`net.connect`/`child_process`) and the per-command checkpoint helper that names exactly which command failed.
  [`vendor-neutrality.test.ts:64`](../../packages/cli/src/vendor-neutrality.test.ts#L64)

- Best-effort `afterEach` cleanup, guarded against an unassigned `tmpDir` and a Windows cleanup failure.
  [`vendor-neutrality.test.ts:47`](../../packages/cli/src/vendor-neutrality.test.ts#L47)

**Shebang and path-separator verification (NFR5)**

- Build-independent shebang check, reading `index.ts`'s raw source rather than `dist/`.
  [`shebang.test.ts:12`](../../packages/cli/src/shebang.test.ts#L12)

- `.gitattributes` forcing LF is what makes the shebang test meaningful on a Windows checkout.
  [`.gitattributes:1`](../../.gitattributes#L1)

- Explicit `path.join(...)`-equality tests naming the path-separator-sensitivity verification.
  [`new-spec.test.ts:479`](../../packages/core/src/new-spec.test.ts#L479)

**Peripherals**

- Single source of truth for the CI Node version, referenced by `ci.yml`'s `node-version-file`.
  [`.nvmrc:1`](../../.nvmrc#L1)
