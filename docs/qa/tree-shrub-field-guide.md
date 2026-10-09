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
An untouched suggestion blocks the client completion action until an actual
quantity and unit are entered. The existing typed server compliance check also
rejects missing actuals. Normal completion records actual use. The shared reviewed-area calculation is
in PR #5050; palm counts/individual canopy measurements and calibrated scoops
must never be substituted with bed area or tank capacity.

Dependencies: built on #5049 at `27af8bdd749b32e8ff77e479492f090d1640e354`;
its latest removal of speculative seasonal/rate configuration is preserved.
Only the consumed T&S identity metadata extends its name entries.
`mix-amount.js` extends the canonical formatter from #5015
(415340c8242b945e7f35d9317cd8b5858b441da3) with an opt-in truck-measure mode:
cup ranges round inward, single cup amounts round down, quarter teaspoons are
preferred with eighths only when needed. Existing inventory displays keep their
default behavior. Reconcile this extension when #5015 lands.
The draft was retargeted to main before any parent merge so the repository's
required PR verification can run; it still depends on #5049 and #5050.
The owner merges; this lane stops before merge.

## Evidence

- Real admin and VisitProtocol components rendered with synthetic API fixtures,
  at 1440px and 390px. All 12 admin months and five representative phone months
  across three tank sizes exercised without horizontal overflow or page errors.
- Snapshot expansion: two owned spreaders only; switching to push shows 092807.
  Merit expansion: soil kit only. Label link verified in place.
- Final preview caught large oil doses rounding up in the inherited formatter.
  Dedicated truck-measure tests now pin 1¼ / 5 / 140¾ fl oz for the 1% oil
  reference, with approximation marks; range bounds stay inside their sources.
- Product equipment and the phone mix-size selector share the same state.
  Program safety rules remain visible in both admin and technician guides;
  detailed notes remain available. Lawn 0-0-16 Winterizer does not count toward
  palm feeding history. Ambiguous catalog aliases or equally tight name matches
  are withheld.
- Review follow-up passed 264 server checks and 24 client checks. The canonical
  completion-prefill request is registered as reviewed but unsupported/unverified
  for Intelligence Bar parity. The requested 11px admin label override is retained.
- Screenshots reviewed in-session. Native attachment unavailable with installed
  gh 2.90.0; no screenshot attachments are claimed.
- 259 focused server tests passed after reconciling #5049's latest changes,
  including 34 dispatch-route checks and seven cases proving default-product
  reads enforce the existing technician assignment/status/date scope before
  resolving any product or application history. Administrators retain access.
- A temporary merge with #5050 at `41a7e958a3014559aee7e84934e3242f8eb4d583`
  passed 98 client checks and the production build, including brand/domain
  checks. Two combined-flow cases exercised automatic Snapshot suggestions
  with early/late reviewed bed measurements, blank initial doses, rate-driven
  totals, partial coverage and preserved manual actuals. No request wrote data.
  The temporary merge was aborted; this PR does not duplicate #5050's diff.
  When integrating, keep both `buildSelectedProduct`'s `applicationMethodOverride`
  parameter from #5049 and #5050's `productUsesServiceArea` classification.
- All 1,602 pending migrations applied to this worktree's isolated Railway
  staging QA database. Four real PostgreSQL cases passed (and passed again
  after reconciliation): idempotent equipment/product seeds, dark/on behavior,
  property-scoped treatment history with retractions, and unavailable-history
  failure. Fixtures roll back. No production database was accessed.

## Open content inputs

Exact labels for 13-0-13, Sequestar and the kit copper (palm bud drench use); KPHITE method/container
match; Mainspring program-range choice; and the later
March/May/October/November program decisions remain unresolved. Their
holds are visible. Talus (residential use prohibited) and Headway (turf-only
label) were removed from the program on 2026-10-05, with no replacement product. Both LESCO bag prices remain pending, never zero.

Label summaries and source URLs live together in
`server/config/tree-shrub-field-guide.json`. The 8-0-12 bag and KPHITE T&O
manufacturer PDFs were rechecked for this build; the other summaries retain
the source versions reviewed for the approved mockup. The company palm chart
is explicitly distinguished from the fertilizer bag directions.

## Program date rules (2026-10-05)

Visits start on the customer's signup date (6x about every 60 days, 9x about
every 40), and the quarterly 4x track is retired. Each visit uses the card for
its calendar month, and all 12 cards now name Snapshot and the season's palm
feed (8-0-12 October to May, 0-0-16 June to September) as routine lines. The
existing due gates decide what shows: the palm feed waits until 3 calendar
months after the last feed, Snapshot waits 60 days and one per quarter, and the
June 1 to September 30 N/P blackout still blocks 8-0-12.

TriStar 8.5 SL (acetamiprid, Group 4A) is a conditional secondary line on nine
cards (Jan to Apr, Jun to Oct), for live finds only: whitefly, mealybug, aphid and
soft scale (wax, cottony cushion), foliar only. It is not for armored scale (use
Distance, oil or a Zylam drench; owner 2026-10-09). Its label summary uses the
Cleary label 62432_4 (06/29/2021, EPA 8033-106-1001): 8.5 to 16.5 fl oz per 100
gal for hard and soft scales and whiteflies, 4 applications a year, 7 days
between applications, 25.3 fl oz per acre per application, 92.5 fl oz per acre
per year. It has no catalog row yet, so Fast Complete never suggests it.

Zylam Liquid (PBI-Gordon, EPA 2217-937) now lists the soil-drench dose beside the
foliar rate: 0.18 to 0.4 fl oz per foot of plant height, for single shrubs and
sagos. A sago is measured from the soil to the frond tip, never by trunk
diameter (3 to 5 times the dose), and a hedge is never drenched. The yearly limit
is 78.9 fl oz per acre, or 1.81 fl oz per 1,000 sq ft of bed area (Waves' reading),
sprays and drenches together. The per-foot dose is a rate row only: the tank
calculator still uses the foliar per-gallon range.

## Program text changes (2026-10-09)

Technician-facing text only; no gate, migration or price change. TriTek oil and
KPHITE are conditional secondary lines on every card that offers them (live finds
or root-rot history only), so neither is a Fast Complete suggestion any more.
Mn Combo, Azatin O, the routine copper line and the routine ornamental fungicide
line are gone from the T&S cards; manganese is the palm Mn sulfate secondary line
only. The freeze policy (a loose spear is a photo, a note and an office call: no bud drench until a copper label is verified) and the joint mosquito account check live in the program
notes. The palm chart divisor stays 105: one application stays under the 1 lb
nitrogen per 1,000 sq ft limit in the Sarasota County fertilizer codes. The
sold tiers are 6 and 9 visits a year.
