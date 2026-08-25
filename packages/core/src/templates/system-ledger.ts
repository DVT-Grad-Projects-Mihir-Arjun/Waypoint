import { stringify } from 'yaml';

/**
 * Single source of truth for a system spec's matching phased task ledger —
 * same approach as `renderFeatureLedgerYaml()` in `./feature-ledger.ts`:
 * build a plain object, then hand it to `yaml`'s `stringify()`, rather than
 * hand-formatting YAML text (which would drift from the schema silently).
 *
 * Kept as its own file (not a reuse of `FeatureLedgerTask`/`FeatureLedger`)
 * because System-tier tasks carry a `phase` field Feature-tier tasks don't —
 * the two ledger shapes are allowed to diverge without one tier's schema
 * change forcing a change on the other.
 */

export interface SystemLedgerTask {
  id: string;
  phase: number;
  description: string;
  status: 'pending' | 'in-progress' | 'done';
  linked_commit: string | null;
  verified_by_gate: boolean;
}

export interface SystemLedger {
  spec_id: string;
  tasks: SystemLedgerTask[];
}

/**
 * Renders a new system ledger with exactly two `pending` tasks (`t1`/`t2`),
 * one per phase, mirroring `prd.md`'s two placeholder tasks in its
 * `## Phase 1`/`## Phase 2` sections. `linked_commit`/`status`/
 * `verified_by_gate` are only ever written by `waypoint verify` after this
 * point (Epic 3's scope) — here they start at their untouched defaults.
 */
export function renderSystemLedgerYaml(
  specId: string,
  phase1Task: string,
  phase2Task: string
): string {
  const ledger: SystemLedger = {
    spec_id: specId,
    tasks: [
      {
        id: 't1',
        phase: 1,
        description: phase1Task,
        status: 'pending',
        linked_commit: null,
        verified_by_gate: false,
      },
      {
        id: 't2',
        phase: 2,
        description: phase2Task,
        status: 'pending',
        linked_commit: null,
        verified_by_gate: false,
      },
    ],
  };

  return stringify(ledger);
}
