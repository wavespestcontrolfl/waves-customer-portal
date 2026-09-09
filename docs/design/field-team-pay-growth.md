# Field Team Program — simulation foundations

This continues the September 4 Field Team Program, revision 2b. The ladder is
Trainee → Technician I → Technician II → Service Manager → General Manager;
Technician II is the highest field title. No compensation terms are activated.

The review stack separates foundations, the staff API, reusable review forms,
and the connected Staff/technician workspaces. The dependent API and UI use
`GATE_FIELD_TEAM_PROGRAM`, default off. Live wages, payroll export, payment,
customer communications and automatic promotion remain outside this program.

Rules, levels, accepted-value allocations, service revisions, production models,
new-business evidence, assessments and statements retain append-only history.
A service can claim one original application ordinal. The accepted net value
is divided by the original scheduled count, with deterministic cent remainders;
cancellation never redistributes it. Crew shares total 100%. Database uniqueness
also covers allocations without a property and one claiming row per service.
Claims require a retained allocation and positive ordinal; absent or half-present
allocation pairs cannot permanently consume a service's claim.
The database also rejects application ordinals beyond the retained allocation's
scheduled count. Production requires the allocation's exact service key.
The calculator derives every crew member's cents from that allocation and the
full retained split; it never trusts a supplied participant dollar amount.

Each new effective definition retains its monetary formula inputs. Already-stored
revision 2b definitions resolve through a fixed legacy version definition;
unknown versions do not borrow current rates. Production uses the selected rule,
commission its retained rate and milestone split, and outcomes its retained
curves. Interpolation is explicitly a linear simulation assumption.

Unverified evidence and service keys missing from the effective definition stay
unresolved, including claimed exclusions.
Verified, mapped exclusions need no allocation or role rate: they receive zero
production credit without consuming an application claim.
A rework finding needs a linked later return, same-issue confirmation and date.
Missing cutoffs, minimum samples, observation windows and commission splits do
not become passing results or implicit defaults. A premature no-return review
needs a later review after the complete observation window.
Contradictory no-return links remain unresolved. The 90-day commission portion
requires the retained review timestamp to be on or after the milestone.

Customer merges leave immutable accepted-value ownership intact. The API follows
active merge history when resolving those allocations and preserving their caps.
Promotion evidence retains assessor, rubric, critical items and reassessments;
management qualification also requires paid development and a separate vacancy.

Verification uses Node 20 and synthetic records in a worktree-owned development
database. Run `npx jest --runInBand --coverage=false server/tests/field-team-rules.test.js server/tests/customer-dedupe.test.js` for formulas, historical versions,
unresolved evidence and merge behavior. All four migrations were verified on real
Postgres with repeated up/down execution inside rollback; duplicate null-scope
allocations and second service claims were rejected by their database indexes,
and malformed allocation/ordinal pairs were rejected by the claim-shape check.
The capacity trigger rejects missing allocations and above-capacity ordinals,
including non-claim revisions, while accepting the last planned ordinal.
