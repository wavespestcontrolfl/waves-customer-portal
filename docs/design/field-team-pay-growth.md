# Field Team Program — pay and growth simulation

Continues the September 4 Field Team Program, revision 2b, recovered in
`Downloads/Waves-Florida-Employee-Audit-2026-09-09`. Source:
https://claude.ai/code/artifact/7615e413-72fb-4571-8ec2-18447b3760ae.

The career ladder is Trainee → Technician I → Technician II → Service Manager →
General Manager. Technician II is the highest field title. Rates and target
earnings in revision 2b are simulation inputs. There are no approved compensation
terms in that revision.

## This implementation

The shared workspace lives at `/tech/pay-growth`, with an admin entry from Staff.
`GATE_FIELD_TEAM_PROGRAM` controls availability and is off by default. It does not
enable payroll, change employment terms, change dispatch capabilities, or promote
anyone. Current recorded hourly pay and existing review payouts retain their
existing sources of truth. The screen links to the staff document library for
issued terms.

Admins record effective-dated simulation levels and program definitions. Each
definition lists eligible service keys explicitly; category alone never grants
production credit. Observation windows, minimum samples, and the activation/90-day
commission split remain unset until entered for a simulation. Management target
bonuses and the trainee band are displayed as modeled/unset, with no invented
manager formula.

Production uses a retained allocation for one customer, property, service key, and coverage
period. Net accepted value, scheduled application count, and source reference are
recorded before credit. Equal allocation reconciles to the cent across all
scheduled applications; cancellations do not redistribute it. A completed visit
claims one ordinal only. Explicit employee shares must total 100%. Separately
priced specialty work is recorded as its own allocation and remains uncalculated
until a separate incentive amount is defined. Service revenue and
monthly billing are not used as production credit.

Service evidence is reviewed by an admin and retained in immutable revisions.
Each revision records completeness at cutoff, substantive repair reason, rework
review, source provenance, and credited participants. Unknown evidence stays
unknown. A no-application decision does not disqualify work. Corrective, duplicate,
and unnecessary visits receive no production credit. Only reviewed technician
execution counts as avoidable rework; a return must identify the same customer,
service key, and issue. The corrective technician does not inherit responsibility.

Saved simulation statements retain their source revisions and formulas. Repeating
the same calculation does not create another statement. A later statement is a
new snapshot, never an edit to previous evidence or calculations. Production
rates are captured against the original service date. Outcome modeling uses
linear interpolation between revision 2b's endpoints; the screen labels this as
an assumption of the simulation. Insufficient samples, immature observations,
unresolved responsibility, and missing definitions are separate results.
Unverified and unmapped evidence remains unresolved. A no-return finding made
before its observation window closed needs a later review. Performed services
without evidence stay in the exception count, including services with completion
timestamps whose status has not been finalized. The displayed calendar week uses
Monday as its anchor; it does not declare the eventual payroll workweek.

New-business evidence retains the originating technician independently of the
estimate creator/closer, baseline and accepted incremental net value, activation
and payment evidence, and a retained 90-day review. Missing milestone splits do
not default to 50/50. Simulation does not produce an earned or payroll-exportable
commission.

Promotion assessments retain rubric version, assessor, assessment date, critical
items, verified outcome evidence, paid development evidence, and reassessment
history. The result can show development needed or qualification for consideration;
it never changes a title or pay. Position availability applies to management
only. Public reviews do not determine promotion.

## Boundaries for the next live-pay stage

Written compensation terms, provider responsibilities, workweek allocation and
overtime reconciliation, protected earnings, correction handling, economic launch
criteria, and a component-specific launch decision remain prerequisites from
revision 2b. This implementation has no mutation or export that can convert a
simulation into earned, approved, or paid compensation. Existing payroll continues
through its current routes. The per-stop Score reader uses the same evidence as
the personal page.

## Verification

Use only synthetic records in a dedicated dev/preview database. Cover explicit
service-key eligibility, cent reconciliation, split credit, replay/concurrent
writes, effective dates, immutable records, insufficient/unresolved evidence,
commission milestones, non-vacancy technical advancement, and cross-technician
access. Render desktop and mobile and exercise the admin-to-technician journey.

After the managed worktree database is prepared and migrated, run
`node scripts/qa/field-team.cjs` with Node 20. This script rejects any database
other than the current worktree's private `waves_qa_*` database. It resets the
eight simulation tables and seeds synthetic accounts; do not use that private
database for evidence you want to retain. `--serve` keeps the verified API on the
worktree's loopback port for browser QA. It supplies no integration credentials.

Verified locally on September 9, 2026:

- Migration up/down and repeated execution on the dedicated development database.
- 64 server tests covering formulas, scope, write guards, and gate behavior.
- 91 client tests covering the new screen, selection races, existing staff/field
  navigation, protocol loading, and the shared Score tab.
- 41 authenticated HTTP/database checks, plus assertions for original rate
  retention, crew privacy, immutable history, commission milestones, prospective
  exclusion, statement deduplication, and unchanged actual pay/review payouts.
- Production build and repository prebuild checks; new feature files lint clean.
- Chrome at 1440 and 390 pixels: an admin appended service evidence and retained
  an assessment through real routes and PostgreSQL; a technician viewed their
  calculations, evidence, and ladder without management controls. No page errors
  or horizontal page overflow. Notification/message counts, document availability,
  and usage tracking were stubbed for the surrounding shell. Pay and growth,
  authentication, and feature flags used the real local API.

Screenshots and the browser report are retained locally under
`.tmp/qa/field-team-*.png` and `.tmp/qa/field-team-browser-report.json` in this
worktree. This verification did not activate a deployment or a live-pay component.
