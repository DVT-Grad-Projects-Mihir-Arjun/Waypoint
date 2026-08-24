import { execFileSync } from 'node:child_process';
import { gate } from '@waypoint/core';

/**
 * Thin command handler for `waypoint gate` (no arguments) — the actual
 * enforcement entry point wired to a real git hook by `waypoint install`
 * (Story 3.2 part 2). Resolves the real staged-file list via `git diff
 * --cached --name-only` (array args to `execFileSync`, never
 * shell-interpolated) and calls `@waypoint/core`'s `gate()` primitive
 * (Story 3.2 part 1) unchanged.
 *
 * Standard git hook convention: silent on pass, one line per violation on
 * `console.error` and a non-zero exit code on failure. If resolving the
 * staged-file list itself throws (not a git repository, git unavailable),
 * that is caught and reported the same way — never a raw exception/stack
 * trace escaping to the caller (which would look like a crash rather than a
 * clear enforcement message).
 */
export async function gateCommand(cwd: string = process.cwd()): Promise<void> {
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
    const stderr = (err as { stderr?: unknown }).stderr;
    const rawText =
      typeof stderr === 'string' && stderr.trim().length > 0
        ? stderr
        : err instanceof Error
          ? err.message
          : String(err);
    const firstLine = rawText.split('\n').find((line) => line.trim().length > 0) ?? rawText;
    console.error(
      `waypoint gate: unable to resolve staged changes (is this a git repository?): ${firstLine.trim()}`
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
