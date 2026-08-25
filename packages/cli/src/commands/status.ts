import { computeStatus } from '@waypoint/core';
import type { SpecStatusEntry, StatusResult } from '@waypoint/core';

/**
 * Thin command handler for `waypoint status` (no arguments) — all mechanism
 * (spec discovery, ledger/`.gate-state` reads, the closing-criterion filter)
 * lives in `@waypoint/core`'s `computeStatus()`; this just wires it to the
 * CLI and renders the result as plain, terminal-readable text, matching
 * `check-drift.ts`'s established plain-text output style (no ANSI colors, no
 * emoji, one line per item). Takes no arguments and defaults `cwd` to
 * `process.cwd()`, matching every other command's signature convention.
 *
 * Purely a reporter: makes no write of any kind and no network/`git` call,
 * mirroring `check-drift`'s own read-only contract. Matches
 * `check-drift.ts`'s try/catch -> clean exit-code pattern: an unexpected
 * throw from `computeStatus` is caught and reported as a single clean
 * message rather than escaping raw, and `process.exitCode` is set to `1`
 * when the result itself contains an anomaly worth a human's attention (a
 * `CORRUPTED` task or a `[LEDGER ERROR]` spec) — an ordinary open/unapproved
 * spec is expected, everyday state and leaves the exit code untouched.
 */
export async function statusCommand(cwd: string = process.cwd()): Promise<void> {
  try {
    const result = await computeStatus(cwd);

    if (result.entries.length === 0) {
      console.log('waypoint status: no open specs.');
      return;
    }

    const byTier: Record<'patch' | 'feature' | 'system', SpecStatusEntry[]> = {
      patch: [],
      feature: [],
      system: [],
    };
    for (const entry of result.entries) {
      byTier[entry.tier].push(entry);
    }

    for (const tier of ['patch', 'feature', 'system'] as const) {
      const entries = byTier[tier];
      if (entries.length === 0) continue;

      console.log(`${tierLabel(tier)} (${entries.length}):`);
      for (const entry of entries) {
        console.log(`  ${renderEntryLine(entry)}`);
      }
    }

    console.log(renderCountsLine(result));

    if (hasAnomaly(result)) {
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

/**
 * `true` iff `result` contains at least one anomaly worth a human's
 * attention — a `CORRUPTED` task anywhere, or a `[LEDGER ERROR]` spec.
 * Deliberately does NOT flag an ordinary open/unapproved spec (including
 * `unapprovedInProgress`) — that's normal, expected state for this report,
 * distinct from something actually wrong.
 */
function hasAnomaly(result: StatusResult): boolean {
  return result.entries.some((entry) => {
    if (entry.tasks === 'ledger-error') return true;
    if (entry.tasks === 'not-applicable') return false;
    return entry.tasks.some((t) => t.state === 'CORRUPTED');
  });
}

function tierLabel(tier: 'patch' | 'feature' | 'system'): string {
  return tier === 'patch' ? 'Patch' : tier === 'feature' ? 'Feature' : 'System';
}

function renderCountsLine(result: StatusResult): string {
  const { patch, feature, system } = result.counts;
  return `waypoint status: ${result.entries.length} open spec${
    result.entries.length === 1 ? '' : 's'
  } (patch: ${patch}, feature: ${feature}, system: ${system}).`;
}

/**
 * Renders one spec's row: id, approval state (or N/A), task completion
 * summary, and any additive flags. A `CORRUPTED` task gets its own distinct,
 * bracketed `[CORRUPTED]` marker — visually parallel to the existing
 * `[UNAPPROVED, IN PROGRESS]` flag and to `[LEDGER ERROR]` below — in
 * addition to (not instead of) the plain count already folded into the task
 * summary, since a `CORRUPTED` task is the single most safety-relevant
 * signal this report can surface and must not be missable by a human
 * skimming past an otherwise-ordinary-looking count.
 */
function renderEntryLine(entry: SpecStatusEntry): string {
  if (entry.approved === 'not-applicable' || entry.tasks === 'not-applicable') {
    return `${entry.id} -- approval: not applicable, tasks: not applicable`;
  }

  const approvalText = entry.approved ? 'approved' : 'not approved';

  if (entry.tasks === 'ledger-error') {
    return `${entry.id} -- approval: ${approvalText}, tasks: [LEDGER ERROR] could not read task ledger`;
  }

  const total = entry.tasks.length;
  const done = entry.tasks.filter((t) => t.state === 'done').length;
  const corrupted = entry.tasks.filter((t) => t.state === 'CORRUPTED').length;

  let taskSummary = `${done}/${total} done`;
  if (corrupted > 0) {
    taskSummary += `, ${corrupted} CORRUPTED`;
  }

  const flags: string[] = [];
  if (entry.unapprovedInProgress) flags.push('UNAPPROVED, IN PROGRESS');
  if (corrupted > 0) flags.push('CORRUPTED');
  const flagText = flags.length > 0 ? ` ${flags.map((f) => `[${f}]`).join(' ')}` : '';

  return `${entry.id} -- approval: ${approvalText}, tasks: ${taskSummary}${flagText}`;
}
