# PRD Quality Review — Waypoint

## Overall verdict
v0.3 holds up well: the tier/gate thesis is stated once and traced consistently through FRs, success metrics, and epics, decisions are surfaced honestly (FR8's enforcement-boundary admission is a standout), and scope is fenced with Non-Goals plus a roundtripped Assumptions Index. What's at risk is mostly at the edges — a couple of unbounded adjectives in the NFR/AC layer, one load-bearing but untagged assumption (git as the sole VCS), a small metric-to-thesis mapping that doesn't quite fit, and a minor headcount ambiguity in the role-prompt requirement. None of these block moving forward; they're the kind of gaps a fast pre-build pass would close.

## Decision-readiness — strong
The PRD states real decisions rather than hedging them. Background Context resolves the brief's open question ("automatic vs. explicit tier classification") toward explicit, names why, and defers the alternative with a concrete trigger condition ("once real usage data exists on where the tier boundary should sit"). The two `[NOTE FOR PM]` callouts in Background Context sit at genuine unresolved tensions — the FR7 bypass-flag escalation question and the FR8/FR9 enforcement-boundary question — each with an owner and a re-visit trigger, not a rhetorical question answered in the next clause. FR8 and FR9 both go further than most PRDs would: FR8 admits its own enforcement is documentation-layer only and doesn't technically stop an agent with shell access, and FR9 explicitly disclaims that Waypoint can guarantee or test agent compliance. That's a trade-off named with what's given up, not smoothed over.

No findings — this dimension is doing its job.

## Substance over theater — strong
No personas exist, which is correct for a solo/small-team capability tool, not a gap (see Shape fit). NFR1–NFR6 each carry a product-specific bound (zero vendor dependency, ~30s, 2s gate runtime, three named OSes, single-command install) rather than boilerplate "must be scalable/secure" language. The Goals bullets ("Make gate enforcement mechanical... rather than dependent on an agent choosing to comply") are specific to this product's thesis and wouldn't drop cleanly into a generic PRD. No Differentiation section exists purely because a template expects one — the brief comparison is referenced, not re-litigated.

No findings.

## Strategic coherence — adequate
The thesis — ceremony (tier) and enforcement (gate) are decoupled dials, and every competitor couples them — is stated once in Background Context and then actually drives prioritization: FR1–3 establish tiers, FR6–7 establish gates, FR12 is added specifically because the gate mechanism the architecture assumes had no defined classification logic. Success Metrics avoid vanity-metric theater (no DAU/MAU-style activity counts) and include a named counter-metric (false-positive rate) against the Patch-tier speed goal.

One reconciliation is shakier than the rest: Success Metrics maps the brief's fourth metric ("zero agent-specific code paths in the core") onto NFR1 (model/vendor dependency) and NFR5 (identical OS behavior). NFR5 is about macOS/Linux/WSL parity — it says nothing about whether the *core* has agent-tool-specific branches (Claude Code vs. Cursor vs. bare CLI), which is what the brief's metric was actually about. That leaves the PRD's own vendor-neutral thesis — arguably its central claim — without a metric or NFR that actually tracks it; FR9/FR10 (tool-agnostic `AGENTS.md`, plain-markdown role prompts) are the real evidence for that claim, but nothing measures "no agent-specific code paths in `@waypoint/core`" the way NFR5 measures OS parity.

### Findings
- **medium** Fourth success metric reconciled to the wrong NFR (§ Success Metrics) — the brief's "zero agent-specific code paths in the core" is mapped to NFR5 (OS parity), which doesn't test tool-agnosticism; the thesis's most distinctive claim ends up untracked by any measurable statement. *Fix:* either add a thin NFR ("core library contains no `if (agent === ...)` branching; CLI/gate/drift behavior is identical regardless of invoking tool") or explicitly note that FR9/FR10 are the load-bearing evidence for this metric instead of NFR1/NFR5.

## Done-ness clarity — adequate
Most FRs carry a testable consequence: FR1's "no required approval step," FR5's narrowed path/symbol-only scope with an explicit deferral of "materially changed" detection, FR7's block condition, FR12's fail-closed default are all clear enough for an engineer to write a test against. FR9 and FR8 are notably careful about not overclaiming testability (FR9: "whether an agent actually follows it is a property of that agent, not something Waypoint can guarantee or test for").

Two spots still lean on an adjective instead of a bound, which the rubric calls out explicitly for NFR sections:
- NFR4 ("gate script shall run in under 2 seconds on a **typical repo**") gives a numeric bound but qualifies it with an undefined "typical" — repo size/file count isn't specified, so it's unclear what repo an engineer should benchmark against, and this is the exact NFR meant to keep gates from discouraging use per the brief's stated risk.
- Story 3.4 AC3 ("pre-populates `specs/patches/**` **and other obviously-safe defaults**") doesn't enumerate what else counts as obviously-safe, so "done" for this AC is a judgment call, not a checklist.

Separately, FR10 and Story 4.2 both specify "3–4 role prompts" while naming exactly four (Planner, Architect, Implementer, Reviewer) in both places — it's unclear whether one is optional/deferrable or the range is just imprecise wording.

### Findings
- **medium** Unbounded "typical repo" in performance NFR (§ NFR4) — the 2-second gate budget has no defined repo-size baseline to benchmark against. *Fix:* state a concrete baseline (e.g., "under 2 seconds on a repo with ≤2,000 tracked files and ≤50 open specs") or point to a fixture repo used for the benchmark.
- **medium** Unenumerated "obviously-safe defaults" (§ Story 3.4, AC3) — the default patch-classified path list isn't specified beyond `specs/patches/**`, leaving the AC's completion criterion subjective. *Fix:* enumerate the full default pattern list (e.g., `specs/patches/**`, `docs/**`, `*.md` at repo root) so AC3 is a checklist, not a judgment call.
- **low** Ambiguous "3–4" role-prompt count against 4 named roles (§ FR10, Story 4.2) — both list Planner/Architect/Implementer/Reviewer by name but require only "3–4," without saying which role is optional. *Fix:* either commit to exactly 4, or name which role is droppable and under what condition.

## Scope honesty — adequate
Non-Goals is substantive and explicitly self-contained ("carried forward explicitly from `brief.md`'s MVP Scope 'Out' list"), including a v0.3 addition (spec-format-versioning) that closes a real omission. The Assumptions Index is well-formed: three assumptions, each with confidence and an explicit "if wrong, changes" column, plus a closing flag that A1/A3 are expensive to reverse mid-build — this is de-scoping and risk surfaced honestly, not silently assumed.

One load-bearing assumption isn't tagged at all: the entire gate/enforcement mechanism (FR7, Story 3.1's pre-commit hook, the ledger's `linked_commit` field, architecture.md's git-hook-based design) assumes git as the sole VCS. Nothing in Technical Assumptions (A1–A3) or Non-Goals names this, even though a wrong assumption here would invalidate Epic 3 as designed — comparable in blast radius to A1 (monorepo) and A3 (Node/TypeScript), which *are* tagged.

### Findings
- **medium** Untagged git-as-sole-VCS assumption (§ Technical Assumptions; affects FR7, NFR3, Epic 3) — the gate mechanism is designed entirely around git pre-commit hooks and commit-linked task verification, with no `[ASSUMPTION]` tag or Non-Goal acknowledging that non-git VCS users are out of scope. *Fix:* add an `[ASSUMPTION: A4]` entry ("git is the consuming repo's VCS; gate hook mechanism is git-specific") to the index alongside A1–A3, given it carries similar rebuild cost if wrong.

## Downstream usability — strong
IDs are contiguous with no gaps or duplicates across FR1–FR12, NFR1–NFR6, and Stories 1.1–5.1. Cross-references consistently resolve to named locations rather than "see above": FR12 → architecture.md's Error Handling Strategy (verified, matches its fail-closed language), NFR6 → Story 3.4 AC3 (verified), Story 2.2's out-of-scope note → FR5's scope note (verified), Story 3.3's note → Background Context's `[NOTE FOR PM]` (verified), FR9 → Story 4.1's note (verified). This is above the rubric's bar — pulling any single FR or Story out in isolation still tells a reader where its caveats live. Glossary terms (Spec, Delta, Tier, Gate, Ledger) are defined once and used throughout; minor casing inconsistency is noted in Mechanical notes below but doesn't impede extraction.

No findings.

## Shape fit — strong
This is correctly shaped as a capability spec for a single-operator/solo-developer tool, not forced into a consumer-product mold: no personas, no UJs with named protagonists, and Success Metrics are process/operational (time-to-commit, gate coverage, reviewability) rather than user-facing engagement metrics. That matches both the rubric's "internal tool, single-operator role" guidance and the brief's stated primary target user. The PRD is also appropriately un-formalized where formality would be overhead (no UJ section attempted and padded) while staying substantive on the parts that matter for a technical capability spec (FR-level detail, Assumptions Index, Non-Goals).

No findings.

## Mechanical notes
- **Glossary casing drift**: "Feature tier" (FR7, no hyphen) vs. "Feature-tier" (Success Metrics, FR12, Story 3.1 — hyphenated) vs. the Glossary's own phrasing, which names tiers without a "tier" suffix at all ("Feature (one approval gate)"). Same pattern for Patch-tier/Patch tier. Low-impact but worth a pass before this feeds a style-sensitive downstream doc.
- **ID continuity**: clean. FR1–FR12, NFR1–NFR6, Epics 1–5, and all Stories are contiguous and uniquely numbered with no gaps.
- **Assumptions Index roundtrip**: clean. All three inline `[ASSUMPTION: A1/A2/A3]` tags have a matching index row, and all three index rows have a corresponding inline tag. (See Scope honesty finding above for a fourth assumption that should exist but doesn't.)
- **Cross-references**: all checked references resolve (see Downstream usability above) — no dangling "see above" or broken pointers found.
- **UJ protagonist naming**: N/A — no UJs in this PRD, which is appropriate per Shape fit.
