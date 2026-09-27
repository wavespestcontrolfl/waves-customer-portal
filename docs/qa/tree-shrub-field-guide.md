# Tree & Shrub field guide verification

The approved standalone mockup is implemented in the existing admin Protocols
page and scheduled Job Card → Service Protocol view. Admin structural headings
use the owner's 11px override; body and phone headings remain 14px or larger.
Product rows expand in place. Granules offer LESCO 092807 / 1235445; soil delivery
uses the FlowZone attachment; foliar rows offer B&G 1 gal, FlowZone 4 gal, and
110 gal rig. No unverified dial settings render.

`GATE_TREE_SHRUB_FIELD_GUIDE` defaults OFF. Existing `GATE_JOB_CARD` and
`GATE_PROTOCOL_SOP` are also required for the job's procedure view. This change
does not flip any deployed gate. Published text corrections and the migration
are not gated: the approved palm products/chart replace the obsolete ones,
and unsupported label recipes are withheld. No customer communications or
application writes occur when a guide or completion drawer opens.

The migration seeds four confirmed equipment models and two 50 lb LESCO SKUs
without guessed prices, serials, purchase dates or calibrations. Existing
matches and admin edits are preserved. Equipment checklist replacement is
narrow and audited. Rollback intentionally retains referenced seed data.

Completion suggestions extend PR #5049's canonical default-products path.
Only the reviewed routine granular identities are eligible: Snapshot and the
month's LESCO palm fertilizer. They require an unambiguous active catalog match
and a linked service property. The existing application ledger excludes
retractions, checks the property, and conservatively holds ambiguous history.
Snapshot checks the quarter, 60-day interval and rolling label-rate allowance;
palm products share a three-calendar-month / four-feeding history. These checks
use recorded history; they cannot establish unrecorded applications.

Suggestions remain editable drafts. Snapshot's weed-specific rate and each
palm's measured canopy dose start blank, rather than inheriting old catalog
rates. Conditional foliar/soil products still require selection for a finding.
Normal completion records actual use. The shared reviewed-area calculation is
in PR #5050; palm counts/individual canopy measurements and calibrated scoops
must never be substituted with bed area or tank capacity.

Dependencies: draft child of #5049; the unchanged `mix-amount.js` is the exact
canonical formatter from #5015 (415340c8242b945e7f35d9317cd8b5858b441da3).
Reconcile #5015 and retarget this child to main before #5049 is squash-merged.
The owner merges; this lane stops before merge.

## Evidence

- Real admin and VisitProtocol components rendered with synthetic API fixtures,
  at 1440px and 390px. All 12 admin months and five representative phone months
  across three tank sizes exercised without horizontal overflow or page errors.
- Snapshot expansion: two owned spreaders only; switching to push shows 092807.
  Merit expansion: soil kit only. Talus hold and label link verified in place.
- Screenshots reviewed in-session. Native attachment unavailable with installed
  gh 2.90.0; no screenshot attachments are claimed.
- Focused client/server tests, production build and brand/domain checks run.
  Final counts and PostgreSQL migration/integration results are recorded in the
  PR after the checks complete.

## Open content inputs

Exact labels for 13-0-13, Mn Combo, Sequestar and Copper; KPHITE method/container
match; Talus and Headway replacements; Mainspring program-range choice; and the
later March/May/October/November program decisions remain unresolved. Their
holds are visible. Both LESCO bag prices remain pending, never zero.

Label summaries and source URLs live together in
`server/config/tree-shrub-field-guide.json`. The 8-0-12 bag and KPHITE T&O
manufacturer PDFs were rechecked for this build; the other summaries retain
the source versions reviewed for the approved mockup. The company palm chart
is explicitly distinguished from the fertilizer bag directions.
