import { stringify } from 'yaml';

/**
 * Single source of truth for a feature spec's matching task ledger — same
 * approach as `renderConfigYaml()` in `../config-defaults.ts`: build a plain
 * object matching the schema in docs/architecture.md's Data Models section,
 * then hand it to `yaml`'s `stringify()`, rather than hand-formatting YAML
 * text (which would drift from the schema silently).
 */

export interface FeatureLedgerTask {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'done';
  linked_commit: string | null;
  verified_by_gate: boolean;
}

export interface FeatureLedger {
  spec_id: string;
  tasks: FeatureLedgerTask[];
}

/**
 * Renders a new feature ledger with exactly one `pending` task (`t1`),
 * mirroring the spec's single placeholder task in its `## Task List`
 * section. `linked_commit`/`status`/`verified_by_gate` are only ever written
 * by `waypoint verify` after this point (Epic 3's scope) — here they start
 * at their untouched defaults.
 */
export function renderFeatureLedgerYaml(specId: string, taskDescription: string): string {
  const ledger: FeatureLedger = {
    spec_id: specId,
    tasks: [
      {
        id: 't1',
        description: taskDescription,
        status: 'pending',
        linked_commit: null,
        verified_by_gate: false,
      },
    ],
  };

  return stringify(ledger);
}
