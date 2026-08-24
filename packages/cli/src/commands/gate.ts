import { execFileSync } from 'node:child_process';
import { checkDoneClaims, gate } from '@waypoint/core';
import type { DoneClaimViolation } from '@waypoint/core';

/**
 * Thin command handler for `waypoint gate` (no arguments) — the actual
 * enforcement entry point wired to a real git hook by `waypoint install`
 * (Story 3.2 part 2). Resolves the real staged-file list via `git diff
 * --cached --name-only` (array args to `execFileSync`, never
 * shell-interpolated) and calls `@waypoint/core`'s `gate()` primitive
 * (Story 3.2 part 1) unchanged.
 *
 * Story 3.5 adds a second, `--ci --base <ref>` mode to this same command
 * (see `GateCommandOptions`/the `--ci`/`--base` branch below) — the
 * staged-diff behavior above is preserved exactly, unchanged, when neither
 * flag is passed.
 *
 * Standard git hook convention: silent on pass, one line per violation on
 * `console.error` and a non-zero exit code on failure. If resolving the
 * staged-file list itself throws (not a git repository, git unavailable),
 * that is caught and reported the same way — never a raw exception/stack
 * trace escaping to the caller (which would look like a crash rather than a
 * clear enforcement message).
 */

/** Options accepted by `waypoint gate` beyond the working directory — see `program.ts`'s `--ci`/`--base <ref>` registration. */
export interface GateCommandOptions {
  ci?: boolean;
  base?: string;
}

/**
 * Extracts a short, clear diagnostic from a thrown `execFileSync` error —
 * the first non-empty line of its stderr (or, absent that, its message) —
 * rather than surfacing a raw, potentially multi-hundred-line git error
 * verbatim. Shared by both this command's staged-diff and full-diff git
 * shell-outs.
 */
function extractGitErrorMessage(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const rawText =
    typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr
      : err instanceof Error
        ? err.message
        : String(err);
  const firstLine = rawText.split('\n').find((line) => line.trim().length > 0) ?? rawText;
  return firstLine.trim();
}

/**
 * Strips non-printable/control characters (e.g. a raw ANSI escape) from a
 * string before it's interpolated into a `console.error` line. Every field
 * on a `DoneClaimViolation` (`ledgerFile`, `taskId`, `reason`) is ultimately
 * sourced from hand-editable ledger YAML inside the very PR/checkout under
 * test — a crafted value could otherwise inject raw control/escape
 * sequences into CI log output.
 */
function sanitizeForLog(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching C0 controls + DEL to strip them.
  return value.replace(/[\x00-\x1f\x7f]/g, '?');
}

/**
 * Formats one `DoneClaimViolation` for `console.error`, in a shape parallel
 * to the existing `waypoint gate: <file> - <reason>` spec-delta style:
 * - a per-task violation names both the ledger file and the task id;
 * - a whole-ledger violation (malformed YAML, missing `tasks` array) names
 *   just the ledger file;
 * - the one shallow-checkout hint entry (no `ledgerFile` at all) is printed
 *   as a bare reason line.
 *
 * Every ledger-sourced field (`ledgerFile`, `taskId`, `reason`) is passed
 * through `sanitizeForLog` first — see its own doc comment.
 */
function formatDoneClaimViolation(v: DoneClaimViolation): string {
  const reason = sanitizeForLog(v.reason);
  if (v.ledgerFile !== undefined && v.taskId !== undefined) {
    return `waypoint gate: ${sanitizeForLog(v.ledgerFile)} (task '${sanitizeForLog(v.taskId)}') - ${reason}`;
  }
  if (v.ledgerFile !== undefined) {
    return `waypoint gate: ${sanitizeForLog(v.ledgerFile)} - ${reason}`;
  }
  return `waypoint gate: ${reason}`;
}

/**
 * `--ci --base <ref>` mode (Story 3.5): re-runs the spec-delta check over
 * the *full* PR diff (`git diff <base>...HEAD`, the triple-dot form that
 * diffs against the merge-base of `<base>` and `HEAD` — matching how
 * GitHub/GitLab compute a PR's own diff, not a plain two-dot diff which
 * would also pull in unrelated commits `<base>` gained after the PR
 * branched) via `gate({ mode: 'full-diff', ... })` unchanged, and separately
 * runs `checkDoneClaims` over every `*.ledger.yaml` under `tasks/`. Both
 * checks are read-only; this function never writes to the ledger,
 * `.gate-state`, or anywhere else.
 *
 * Reports every violation from both checks together (never just one, even
 * when both fail) and exits non-zero iff either check found a violation.
 *
 * The two checks' outcomes are gathered fully independently of one
 * another: `gate()` and `checkDoneClaims()` are each wrapped in their own
 * try/catch below, so one throwing unexpectedly still lets the other's
 * result (successful or its own internal-error message) be computed and
 * printed. The combined exit code is only decided once both outcomes are in
 * hand.
 */
async function runCiGate(cwd: string, base: string): Promise<void> {
  let changedFiles: string[];

  try {
    // Same NUL-separated, explicit-`stdio`, bounded-timeout,
    // first-stderr-line-extraction pattern as the staged-diff resolution
    // below — see its own comments for why each piece matters.
    const raw = execFileSync('git', ['diff', `${base}...HEAD`, '--name-only', '-z'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    changedFiles = raw.split('\0').filter((entry) => entry.length > 0);
  } catch (err) {
    console.error(
      `waypoint gate: unable to resolve the full diff against '${base}' (does '${base}' resolve in this checkout? a shallow clone may be missing it): ${extractGitErrorMessage(err)}`
    );
    process.exitCode = 1;
    return;
  }

  // Purely informational, non-blocking: a realistic CI-workflow copy-paste
  // mistake (wrong --base branch name, or --base HEAD) produces a diff of
  // zero files, which would otherwise silently pass both checks below with
  // no signal that --base may be misconfigured. This never sets a non-zero
  // exit code on its own.
  if (changedFiles.length === 0) {
    console.error(
      `waypoint gate: note: 0 files differ between '${base}' and HEAD -- if this is unexpected, check that --base names the correct target branch.`
    );
  }

  // Each check's outcome is gathered independently — one throwing must never
  // prevent the other's result from being computed and reported. Every
  // branch below sets `hadViolation` rather than returning early, so both
  // checks always get their turn.
  let hadViolation = false;

  try {
    const gateResult = await gate({ mode: 'full-diff', changedFiles, repoRoot: cwd });
    if (!gateResult.ok) {
      hadViolation = true;
      for (const v of gateResult.violations) {
        console.error(`waypoint gate: ${v.file} - ${v.reason}`);
      }
    }
  } catch (err) {
    hadViolation = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`waypoint gate: internal error while evaluating the gate: ${message}`);
  }

  try {
    const doneClaimResult = await checkDoneClaims(cwd);
    if (!doneClaimResult.ok) {
      hadViolation = true;
      for (const v of doneClaimResult.violations) {
        console.error(formatDoneClaimViolation(v));
      }
    }
  } catch (err) {
    hadViolation = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`waypoint gate: internal error while checking done-claims: ${message}`);
  }

  if (hadViolation) {
    process.exitCode = 1;
  }
}

export async function gateCommand(
  cwd: string = process.cwd(),
  options: GateCommandOptions = {}
): Promise<void> {
  const ciRequested = options.ci === true;
  const baseProvided = typeof options.base === 'string' && options.base.length > 0;

  // `--ci` requires `--base <ref>` in the same invocation, and vice versa —
  // a clear CLI usage error, not a silent fallback, and no git call is ever
  // attempted for either half of this mismatched pair.
  if (ciRequested !== baseProvided) {
    console.error(
      "waypoint gate: usage error: '--ci' and '--base <ref>' must both be passed together " +
        "(e.g. 'waypoint gate --ci --base main') -- neither flag alone is a valid invocation."
    );
    process.exitCode = 1;
    return;
  }

  if (ciRequested && baseProvided) {
    await runCiGate(cwd, options.base!);
    return;
  }

  let changedFiles: string[];

  try {
    // `-z`: NUL-separated, never quote-escaped output. Without it, a CRLF
    // repo would leave a trailing `\r` on every path (corrupting it before
    // it reaches `gate()`), and git's default `core.quotepath=true` would
    // C-style-escape any path with non-ASCII/special characters instead of
    // emitting it literally.
    const raw = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
      cwd,
      encoding: 'utf8',
      // A large merge (this command's explicit `pre-merge-commit` use case)
      // can exceed the ~1MB default `maxBuffer`, which otherwise surfaces as
      // a misleading generic error. `timeout` bounds how long this can hang
      // if another concurrent git process is holding `.git/index.lock`.
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
      // Without an explicit `stdio`, a failing child's raw stderr is not
      // only captured into `err.stderr` (used below) but also inherited
      // straight through to this process's own real stderr — confirmed by
      // direct reproduction. That would print git's multi-hundred-line usage
      // dump to the terminal/hook output verbatim, defeating the point of
      // extracting a clean single-line message from it below.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    changedFiles = raw.split('\0').filter((entry) => entry.length > 0);
  } catch (err) {
    // `execFileSync`'s thrown error embeds the child's full stderr inside
    // `.message` (git can emit a multi-hundred-line usage dump for something
    // as simple as "not a git repository," since `--cached` is invalid in
    // git's own no-index fallback mode). Surface just the first non-empty
    // line of the raw `.stderr` — a short, actually-clear diagnostic — rather
    // than dumping the whole thing.
    console.error(
      `waypoint gate: unable to resolve staged changes (is this a git repository?): ${extractGitErrorMessage(err)}`
    );
    process.exitCode = 1;
    return;
  }

  let result: Awaited<ReturnType<typeof gate>>;
  try {
    result = await gate({ mode: 'staged', changedFiles, repoRoot: cwd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`waypoint gate: internal error while evaluating the gate: ${message}`);
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    for (const v of result.violations) {
      console.error(`waypoint gate: ${v.file} - ${v.reason}`);
    }
    process.exitCode = 1;
  }
}
