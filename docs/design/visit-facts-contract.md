# Visit facts contract

Status: Step 1 of the owner's plan to sync the tech's Complete Service form
with the customer service report (owner rulings 2026-09-28). This step adds a
registry, this doc and a CI test. **It changes no runtime behavior.**

- Registry (source of truth): `server/config/visit-facts-contract.js`
- Guard: `server/tests/visit-facts-contract.test.js` (static, no DB)
- Typed form facts are **generated**, not hand-listed: from each form's
  `findingsFields` in `server/services/project-types.js`, with requiredness
  from `REQUIRED_FINDINGS_FIELDS` and named readers from the report
  builders' own key lists (see [Typed findings](#typed-findings-typedformfacts)).
  The "Typed form facts" tables at the end of this doc are generated too
  (`node server/scripts/generate-visit-facts-doc.js`).
- Decision entry: `docs/design/DECISIONS.md`, "Visit facts contract (2026-09-28)"

## Why

Report PRs kept drawing the same review finding: a customer-facing claim with
no recorded fact behind it. The fix is to name every fact before anything
renders it: what the visit records, who fills it in, where it is stored,
which report section reads it, and what the report shows when it is missing.
A report section may only claim what a fact in this registry supports. A
form field that no report reads is either marked as a gap or removed.

Production, last 30 days (100 visits, owner audit 2026-09-28): recurring pest
69. Observations were recorded on 0 of 69 recurring pest visits,
recommendations on 2 of 69, and photos on 2 of 100 visits. Every product row
has a method and targets. 140 of 240 pest product rows have an area.

## Owner rulings this contract follows (2026-09-28)

1. The tech sees **no new field lists**. Voice fill (owner ruling 2026-09-27:
   every completion except WDO and pre-treat) writes the same facts the form
   writes. The full form stays behind "Show all fields".
2. **"Found"** (pests, where) and **"Treated"** (areas) are read-only summary
   lines filled from voice.
3. **Tips from your tech** (`server/services/service-report/tip-library.js`)
   and the per-service **Recommendations** vocabulary
   (`client/src/lib/service-completion-choices.js`, gate
   `GATE_SERVICE_REPORT_COMPLETION_CHOICES`) merge into **one searchable,
   prefilled Recommendations list**.
4. The Next-steps chips were retired on 2026-09-27. There is no next-step fact.
5. The **office note never reaches the report writer**. The report writer's
   inputs are the tech's notes box (`service_records.technician_notes`,
   redacted with `redactAccessCodes`) and the structured facts below. The raw
   `technician_notes` column is internal and never appears on a report: the
   customer sees only the screened parse of the AI draft (see
   `technician_notes` below).
6. **WDO and pre-treat are out of scope** (see below).
7. **Per-product standard amounts are deferred** ("protocols later"). Voice
   fill must never guess an amount.

## Vocabulary

**Capture** (a fact can have several):

| capture | meaning |
|---|---|
| `tap` | the tech types or picks it on the Complete Service form (`client/src/pages/admin/SchedulePage.jsx` CompletionPanel) or the Fast Complete sheet |
| `voice` | voice fill must write it. Voice fill ships **dark** on the Fast Complete report flow (`GATE_FAST_COMPLETE_REPORT`): where product went down, the pests named and how the sprays went down are read from the note (`server/services/visit-voice-facts.js`) and sent as the visit's areas serviced (a product's area only when one place was heard), each product's targets and the sprays' method. Lane voice fill ships **dark** too (`GATE_LANE_VOICE_FILL`): a bed bug, fire ant, tick, bee & wasp, mud dauber or recurring mosquito visit's places and one value per finding group are read from the note (`server/services/visit-lane-facts.js`); the office form's Generate fills only fields nobody picked, and the tech's Fast Complete sheet shows them on its record card for the tech to confirm, both sending them as `areasServiced` and `structuredObservations`. Typed voice fill ships **dark** too (`GATE_TYPED_VOICE_FILL`): a typed form's pick fields and counts (cockroach, the German and palmetto knockdowns, flea, pest inspection, mosquito event, wildlife trapping, rodent exclusion, sanitation and inspection; step 4: rodent trap checks, rodent and termite bait stations), and the technician's own 0-5 rating where they set the score, are read from the note (`server/services/visit-typed-facts.js`, a count or rating only when its quote states the number, judged by the completion's own `validateTypedFindings`), and the office form's Generate fills only fields still empty, and the tech's Fast Complete sheet (with `GATE_FAST_COMPLETE_REPORT`) shows them on its record card for the tech to confirm, with the activity score where the tech sets it, both sending them in `structuredFindings` as a tap would; free-text fields stay `tap`, and station pins stay on the station map. Every other `voice` fact is still filled by `tap` |
| `prefill` | defaulted from the protocol, the product label or the service config; the tech confirms it |
| `derived` | computed by the server from other facts or photos |
| `photo` | an uploaded image, optionally captioned |

**When missing:** `hidden` means the section or line doesn't render.
`fallback` means a less specific source is used. `filler` means fixed
zero-state copy. `required` means the form will not submit without it.

## Shared fact sets

Most lines reuse the first three sets; typed lines generate the fourth from
their form. Each line section below lists only what it adds or changes.

### Basic form facts (`genericCompletionFacts`)

Stored in `service_records.structured_notes` (built in
`complete-scheduled-service.js`), except `technician_notes`, which has its
own column.

A writer listed as a plain path must name the storage key. A writer that
submits the value under another name (the client's camelCase
`applicationMethod`, `structuredObservations`, `technicianNotes`, …)
declares that `writerSymbol`. The test checks **every** declared writer, not
just one of them.

`complete-scheduled-service.js`'s `structuredNotes` object literal writes
more keys than the 14 below — review-ask scheduling, backfill/invoice-mint
provenance, delivery posture, WaveGuard equipment compliance, drive costing,
telemetry. Those are internal completion bookkeeping, never a
customer-report input, so they are NOT registry facts: they are named with a
reason in `UNREGISTERED_INTERNAL_KEYS` (`server/config/visit-facts-contract.js`).
The test extracts every key the object literal actually writes (including
ones merged in through a `...(cond ? { key } : {})` spread) and fails if a
key is neither a registered fact's storage key nor in that allow-list — so a
brand-new key can't quietly become a customer-facing report input, or quietly
stay internal, without a decision either way.

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `areas_treated` ("Treated") | voice, tap | `structured_notes.areasTreated` | Areas treated / coverage (report-data.js) | fallback to the request's `areasServiced` |
| `observations` | voice, tap | `structured_notes.observations` | Findings (report-data.js) | hidden |
| `form_observations` | voice, tap | `structured_notes.formObservations` | Findings, form-sourced only | hidden |
| `finding_rows` | derived | `service_findings.title` | Findings list | hidden |
| `recommendations` | prefill, tap | `structured_notes.recommendations` | Recommendations | hidden |
| `form_recommendations` | prefill, tap | `structured_notes.formRecommendations` | Recommendations, form-sourced only | hidden |
| `tech_tips` | prefill, tap | `structured_notes.techTips` | Tips from your tech (`techNote`, `GATE_TECH_TIPS`) | hidden |
| `blog_post` | tap only | `structured_notes.blogPost` | From the Waves blog (`payload.blogPost`, `GATE_REPORT_BLOG_POST`) | hidden |
| `protocol_actions_completed` | prefill, tap | `structured_notes.protocolActionsCompleted` | What we did (protocol actions) | hidden |
| `protocol_action_scopes_completed` | derived | `structured_notes.protocolActionScopesCompleted` | Treatment scope (interior/exterior) + re-entry countdown retained/zeroed decision (`structuredActionScope`/`treatmentScope`, report-data.js) | fallback to area-text/product-based scope classification |
| `technician_notes` (internal) | voice, tap, derived | `service_records.technician_notes` | AI report writer prompt ("Service Notes", `redactAccessCodes`); Visit summary / Today's Result body **only** through `technicianReportCustomerCopy`'s screened parse | fallback to the deterministic summary |
| `customer_concern_text` | tap only | `structured_notes.customerConcernText` | Customer concern grounding | hidden |
| `customer_recap` | derived (server-generated; the full form deliberately does not post it) | `structured_notes.customerRecap` | Visit summary paragraph | fallback to the generated summary |
| `visit_time_on_site` ("Time on site") | derived, tap | `structured_notes.timeOnSite` | `visitTiming.onSiteMinutes` (`metrics-band.js` `computeOnSiteMin`, report-data.js); rendered on non-WaveGuard reports with duration display on (ReportViewPage.jsx) | fallback to `visit_duration_allocation`, then the raw started/ended span |
| `visit_duration_allocation` | derived | `structured_notes.visitDurationAllocation` | Same "Time on site" line, fallback source when `visit_time_on_site` is absent | fallback |
| `customer_interaction` | voice, tap | `structured_notes.customerInteraction` | Customer interaction line | hidden |
| `visit_outcome` | prefill, tap | `structured_notes.visitOutcome` | No-application copy branch | fallback `completed` |
| `reentry_exterior_minutes` | prefill, tap | `service_records.advisory.exterior_reentry_min` | Re-entry ready-time summary (`reentry.js`) | fallback to the computed default |
| `reentry_interior_minutes` | prefill, tap | `service_records.advisory.interior_reentry_min` | Re-entry ready-time summary (`reentry.js`) | fallback to the computed default |

`reentry_exterior_minutes` / `reentry_interior_minutes` are NOT
`structured_notes` keys — they live on the `service_records.advisory` jsonb
column (same one `technician_notes`/`finding_rows` sit outside of), frozen by
the SAME unconditional block (`if (serviceRecordCols.advisory &&
useServiceReportV1)`, not gated on typed vs. untyped) that computes the
product-label REI / service-line default and applies the tech's stepper
override. `reentry.js` reads both back to build the customer-facing
"ready at …" summary the report and the delivery paths use.

`technician_notes` is **not** a customer-facing fact. The column is the
tech's notes box, which can hold access or billing notes, and AGENTS.md
forbids raw `technician_notes` on any report. Customer exposure runs only
through the AI writer, with redaction: `generate-report`
(`server/routes/admin-schedule.js`) reads the notes box through
`redactAccessCodes`, writes its two-section WHAT WE DID / WHAT WE FOUND draft
back into the box, and the report shows only
`technicianReportCustomerCopy`'s re-screened parse of that draft. An extra
line, banned copy or an access code rejects the parse, and the report falls
back to its deterministic summary. Tagged `[found]`/`[next]` lines feed the
internal merged protocol lists, which the report document never renders.
Parked `[Next]` lines travel as `internalRecommendations`, not in the
writer's Service Notes.

`customer_concern_text` is the only fact marked tap-only (`tapOnly` +
`reason`). It holds the customer's own words. Customer texts and calls shape
voice-fill questions but never fill in findings.

`protocol_action_scopes_completed` is a derived companion to
`protocol_actions_completed`: each entry pairs a completed action's label
with its interior/exterior scope, `treatmentApplied` and `dryDown` metadata.
It is never itself a rendered report line — it's the authoritative input
`structuredActionScope`/`treatmentScope`
(`normalizeAdvisoryForTreatmentScope`) uses to decide whether interior or
exterior treatment occurred and whether the customer-facing re-entry
countdown is retained or zeroed. (Formerly listed only in
`UNREGISTERED_INTERNAL_KEYS`, which dropped its real writer/reader edges —
codex follow-up on #5190.)

`visit_time_on_site` / `visit_duration_allocation` are customer-visible on a
non-WaveGuard report when the admin "Show duration when reliable" setting is
on: `metrics-band.js`'s `computeOnSiteMin` prefers `visit_time_on_site`
(the client's running-timer/admin-typed minutes, or the server's packet
duration allocation), falls back to `visit_duration_allocation`, then to the
raw `started_at`/`ended_at` span; `report-data.js` carries the result as
`visitTiming.onSiteMinutes`, and `ReportViewPage.jsx` renders it as "Time on
site" (suppressed entirely for WaveGuard members). (Formerly listed only in
`UNREGISTERED_INTERNAL_KEYS` as "duration costing bookkeeping" — codex
follow-up on #5190; `timeOnSiteAdjusted` and `visitDriveCostAllocation`
remain internal-only bookkeeping.)

### Product facts (`productFacts`), one set per `service_products` row

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `product_application_method` | prefill, voice, tap | `service_products.application_method` | What we did; premium primary move | hidden |
| `product_targets` | prefill, voice, tap | `service_products.targets` | What we did; bug files; lawn (lawn line only) / T&S (tree_shrub line only) treatment cards | hidden |
| `product_application_area` | voice, tap | `service_products.application_area` | What we did; treated areas | hidden |
| `product_area_value` | voice, tap | `service_products.area_value` | What we did; lawn/T&S treatment card area (lawn / tree_shrub lines only) | hidden; required for perimeter spray |
| `product_area_unit` | prefill, voice, tap | `service_products.area_unit` | What we did; lawn/T&S treatment card area (lawn / tree_shrub lines only) | hidden |
| `product_total_amount` | prefill, voice, tap | `service_products.total_amount` | What we did | hidden |
| `product_amount_unit` | prefill, voice, tap | `service_products.amount_unit` | What we did | hidden |
| `product_application_rate` | prefill, voice, tap | `service_products.application_rate` (the client sends `rate`) | What we did (rate) | hidden |
| `product_rate_unit` | prefill, voice, tap | `service_products.rate_unit` | What we did (rate) | hidden |
| `product_name` | prefill (catalog) | `service_products.product_name` | Product identity card (name) | hidden |
| `product_category` | prefill (catalog) | `service_products.product_category` | Product identity card (category) | hidden |
| `product_active_ingredient` | prefill (catalog) | `service_products.active_ingredient` | Product identity card (active ingredient) | hidden |
| `product_epa_reg_number` | prefill (catalog) | `service_products.epa_reg_number` | Product identity card (EPA registration) | hidden |

Each measurement names its unit fact (`qualifiedBy`): a value without its
unit is not interpretable, and the test fails if a measurement is registered
without one. The dark pest "what to expect" section needs method, area and target on
each product. All three are here. **Targets on the full form are prefilled
from the product label. They describe the product mix, not pests found.**

The four identity/regulatory facts are resolved server-side from the catalog
row the tech picked (`completionCatalogRowsById`), never typed by the tech —
there is no client writer edge. `report-data.js`'s public application card
renders all four (`product.name` / `category` / `active_ingredient` /
`epa_reg`).

`productFacts(opts)` takes an `extraReaders` map so a lawn- or
tree-&-shrub-specific reader edge (the treatment-card sections) is scoped to
the ONE line whose builder actually runs — `productFacts()` itself is reused
by every service line, and `lawn-report-v2.js` / `tree-shrub-report-v2.js`
never run for, say, a termite or rodent completion.

### Photos (`photoFacts`)

The photo and its caption are separate facts. An uncaptioned photo is still
a photo: `report-data.js` `photoUrl()` renders it from its key alone, and the
tree & shrub closeout gate counts uploads, not captions.

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `completion_photos` | photo | `service_photos.s3_key` (legacy `s3_url` on old rows) | Photos gallery | hidden (required on tree & shrub) |
| `completion_photo_caption` | derived (AI suggestion), tap | `service_photos.caption` (nullable) | Caption under each photo; AI report writer grounding under `GATE_REPORT_PHOTO_CONTENT` (up to 5 captions, `redactAccessCodes`) | fallback to the photo's state badge or a generic line; the writer gets no photo text |

### Typed findings (`typedFormFacts`)

Typed lines are **generated from the code that defines the forms**, not
hand-listed. For each typed line, `typedFormFacts(<form>)` emits one fact per
field in that form's `findingsFields` (`project-types.js`): every
non-internal field, plus any internal field the completion validator
requires. Internal optional fields are office-only data, not report facts.

- **Key, label, field type** come from the field.
- **applicability** is `companion` when the field is `companionOnly` in
  `project-types.js` — legal ONLY when the form runs as a COMPANION section
  beside a different primary type (`activity-indicators.js`
  `validateTypedFindings` rejects it on a primary submission as an unknown
  field) — and `both` otherwise (every non-`companionOnly` field is legal on
  a primary OR a companion submission of the same form). Today this is only
  `companion` on `tree_shrub`'s detail fields (palm/shrub/bed module
  questions); every other typed form's fields are `both`.
- **when missing** is `required` exactly when `REQUIRED_FINDINGS_FIELDS`
  (`activity-indicators.js`) lists the key, and `hidden` otherwise. A
  `requiredUnless` field (flea `activity_areas`) stays `hidden` with a note,
  because the validator enforces it only conditionally. An internal
  `pesticideOnly` field (`tree_shrub`'s `pollinator_status` /
  `irac_frac_logged`) is the same conditional shape — CONDITIONALLY required
  whenever the visit's products include an insecticide/other pesticide
  (`validateTreeShrubTypedCompliance`, mirrored pre-submit by the client's own
  `f.pesticideOnly` gate) — but `REQUIRED_FINDINGS_FIELDS` has no way to name
  a conditional requirement, so `typedFactFields` includes it by its
  `pesticideOnly` flag alone (rather than dropping it as an unrequired
  internal field) and it too stays `hidden` with a note (codex follow-up on
  #5190: these two fields were previously dropped from the registry entirely,
  losing their real writer/reader edges). A `both`-applicability
  field's requiredness can also differ when the SAME form runs as a
  **companion** section: `activity-indicators.js`
  `COMPANION_REQUIRED_FINDINGS_FIELDS` adds fields the companion validator
  requires beyond the base list (today only `tree_shrub`'s
  `treatments_completed` — hidden on a primary submission, rejected as
  missing on a companion one, codex P2 round 5). When that companion-context
  value differs from `whenMissing`, the fact also carries
  `companionWhenMissing` (a `companionOnly` field has no primary context at
  all, so its single `whenMissing` is already the companion-context value).
- **Readers**: every non-internal field renders in the generic typed
  findings list (`activity-indicators.js` `buildTypedReportSnapshot`). Named
  readers come from the builders' own key lists: `report-data.js`
  `TYPED_AREA_FIELD_KEYS` (areas treated), `cockroach-report-v2.js`
  `COCKROACH_V2_DASHBOARD_FIELD_KEYS`, and the `values.<key>` reads in
  `termite-report-v2.js` (`TYPED_REPORT_BUILDERS` in the registry). A few
  per-key readers (Today's Result stories, the rodent narrative) are
  registered by hand, and the test checks that the key appears in
  each reader file. A `pesticideOnly` field's readers are its compliance
  enforcement instead — `tree-shrub-closeout.js`'s
  `validateTreeShrubTypedCompliance` (server) and `SchedulePage.jsx`'s
  pre-submit mirror (`f.pesticideOnly`, client) — since it never renders on
  the customer report (`TYPED_FINDINGS_LIST` is skipped for every internal
  field, `pesticideOnly` included).
- **Storage** is `service_data.typedReportSnapshot.values.<key>` for a
  `both`-applicability field, and `service_data.companionReportSnapshots[].values.<key>`
  for a `companion`-only field — `complete-scheduled-service.js` freezes a
  companion-only field ONLY into the companion snapshot array
  (`buildTypedReportSnapshot` called once per companion section,
  `companion.values` sourced from the client's `companionFindings` array),
  never into the primary `typedReportSnapshot`; a primary submission
  carrying one is rejected as unknown. A `both` field is the opposite case: it
  is legal on EITHER a primary or a companion submission of the same form, and
  `complete-scheduled-service.js` freezes it into whichever snapshot the
  submission actually was — so the fact ALSO carries `companionStorage`
  (`service_data.companionReportSnapshots[].values.<key>`, same key, not a
  second fact) naming the second path (codex P2 round 5: advertising only the
  primary path let a storage-driven consumer miss the field whenever the
  visit was a companion, e.g. `tree_shrub`'s `plant_groups` /
  `landscape_condition` on a T&S-as-companion visit). The two-program combos
  retired on 2026-08-31 (`20260831000070`) also keep their (non-companion-only)
  keys under `service_data.companionReportSnapshots[].values.<key>` for their
  residual frozen visits, which `report-data.js` and `termite-report-v2.js`
  still read.
- **Writers** are `project-types.js` (declares the key); for a `companion`-only
  field, the form's `companionFindings` array and the completion service's
  `companionReportSnapshots`; for a `both` field, BOTH writer pairs — the
  primary form (`typedFindings`) / completion service (`typedReportSnapshot`)
  edge AND the companion form (`companionFindings`) / completion service
  (`companionReportSnapshots`) edge, matching its two storage paths above.

The test re-derives all of this on its own. A typed line must carry exactly
its form's fields, with requiredness matching `REQUIRED_FINDINGS_FIELDS`. A
builder in `TYPED_REPORT_BUILDERS` must read exactly its registered keys, and
every one must be a field of its form. A typed fact written by hand fails.
Field options, tiers and customer copy are covered in
[the specialty completion contract](specialty-service-completion-contract.md).

### Shared facts every typed line also carries (`typedSharedCompletionFacts`)

The Complete Service form is the SAME form for a typed or an untyped
completion — a typed submission layers `structuredFindings` on top of it, it
never replaces it. `complete-scheduled-service.js` freezes
`customerRecap`, `customerInteraction`, `protocolActionsCompleted`,
`protocolActionScopesCompleted`, `customerConcernText`, `timeOnSite`,
`visitDurationAllocation`, `recommendations`, `formRecommendations`,
`techTips`, `visitOutcome`, the `technician_notes` column and the re-entry
timing pair (`reentry_exterior_minutes` / `reentry_interior_minutes`, on
`service_records.advisory`) into the record unconditionally, and
`report-data.js` / `reentry.js` / `metrics-band.js` read them the same way
for a typed report (`buildProtocolPayload`; the visit-summary resolution
that falls back from `customerRecap` to the screened
`technicianReportCustomerCopy` parse of `technician_notes`; the
no-application copy branch keyed on `visitOutcome`; `structuredCustomerConcern`
feeding the pest/lawn/tree-&-shrub V2 builders' "what you flagged" card;
`computeOnSiteMin` feeding the customer-visible "Time on site" line the same
way as an untyped report; `formRecommendations` is the provenance-guaranteed
copy the "What we recommend" section actually renders, since the merged
`recommendations` value can carry raw `[Next]` technician-note lines that
must never egress — codex P2 round 5). Every typed line below adds this
subset of [the basic form facts](#basic-form-facts-genericcompletionfacts) —
sourced from `genericCompletionFacts` itself, never hand-copied — beside its
generated typed facts. (`customer_concern_text`, `protocol_action_scopes_completed`,
`visit_time_on_site` and `visit_duration_allocation` joined this shared set as
a codex follow-up on #5190 — they were previously typed-line-invisible even
though the SAME unconditional freeze already wrote them there.)

### Typed photo summary (`typedPhotoSummaryFact`)

Every typed line also adds ONE more shared fact outside `typedFormFacts` (it
is not a `findingsFields` entry): `typed_photo_summary`, the
technician-reviewed AI photo summary (`typedPhotoSummary` on the client,
`photoSummaryText` server-side) frozen at
`service_data.typedReportSnapshot.photoSummary` — a sibling of `.values`, not
a field inside it. `report-data.js` renders it on every typed report; the
rodent-trapping line adds `rodent-report-narrative.js`'s own read of the same
field as an extra reader.

### Typed activity score (`typedActivityScoreFacts`)

A typed line whose form has an `ACTIVITY_INDICATORS` entry
(`activity-indicators.js`) also adds `typed_activity_score` — the 0-5 gauge
value the customer ActivityCard and its cross-visit trend chart read
(codex P2 round 5: nothing else here registered it, so a storage-driven
consumer had no way to see the ONLY record of a manually-scored gauge).
`complete-scheduled-service.js` freezes the score onto
`service_data.typedReportSnapshot.activity.{score,source,derivedFrom}` AND
inserts it as its OWN `service_activity_scores` row (`score` / `source` /
`derived_from`) in the same transaction; `activity-scores-store.js`'s
`loadActivityCustomerView` is what actually builds the gauge + history chart
from that table, so it is the registered reader.

On a COMBINED visit where this form runs as a **companion**, `SchedulePage.jsx`
sends the score inside `companionFindings[].activityScore`, and
`complete-scheduled-service.js` freezes it onto
`service_data.companionReportSnapshots[].activity.score` before inserting the
SAME `service_activity_scores` trend row — the fact carries this as
`companionStorage` (same `score` key, not a second fact) plus the matching
`companionReportSnapshots` / `companionFindings` writer edges, mirroring the
typed-findings `both`-applicability shape above (codex follow-up on #5190:
only the trend-table storage and a generic `activityScore` writer token were
previously registered, missing the companion path entirely).

Not every typed form has a gauge: `typedActivityScoreFacts(typedForm)` is
called uniformly on every typed line and returns nothing when the form has no
`ACTIVITY_INDICATORS` entry (`tree_shrub`, `palm_injection`,
`rodent_sanitation`, `mosquito_event`, `one_time_lawn_treatment` — sanitation
deliberately has none: contamination is a cleanup measure, not an activity
trend). The nine lines that DO get it: `cockroach`, `termite_bait`,
`rodent_trapping`, `rodent_exclusion`, `rodent_bait_station`, `wildlife`,
`flea`, `termite_treatment`, `rodent_inspection`. A form with `derive` (a
findings-field prefill, e.g. cockroach's `activity_level`) captures
`prefill, voice, tap` — the tech can still touch/override the prefilled value;
a manually-scored form (`derive: null`, e.g. rodent trapping) captures only
`voice, tap`.

## Per-line facts

### Recurring pest (`recurring_pest`)
Catalog: `pest_general_*`, `waveguard_membership`. Uses the basic form facts,
product facts and photos, plus:

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `pest_activity_rating` | prefill, voice, tap | `service_records.client_pest_rating` | Activity rating / pest pressure | hidden |
| `pests_found_where` ("Found") | voice | none | none | **gap** |

### One-time pest (`one_time_pest`)
Catalog: `one_time_pest_control`, `fire_ant`, `tick_control`,
`bee_wasp_removal`, `mud_dauber_removal`, `pest_initial_cleanout`,
`bed_bug_treatment`. These use the basic form: the typed one-time pest form
was retired on 2026-07-30 and bed bug on 2026-07-31. Facts are the same as
recurring pest, without the `pests_found_where` gap entry.

### Pest re-service (`reservice_pest`)
Catalog: `pest_re_service`. Completed through the full form or Fast Complete
(`client/src/components/tech/FastCompleteSheet.jsx`). Facts are the same as
recurring pest, plus:

- `visit_outcome` is also read by `reservice-report.js`. The re-service copy
  for inspect-only visits never says areas were re-treated
  (`GATE_RESERVICE_REPORT_COPY`).
- Fast Complete's `completionBody` sends `visitOutcome`, products (method,
  targets, area, amount and unit, rate and unit, and linear ft for perimeter
  spray), `areasServiced`, the rating and `technicianNotes`. Photos are
  staged and promoted at completion, not sent in the body.
- `fast_complete_customer_text` (storage `structured_notes.completionSmsStatus`)
  has a **gated writer**. With `GATE_FAST_COMPLETE_RECAP` off (the default) the
  sheet pins `sendCompletionSms`, `requestReview` and `includePayLink` to
  `false` and the customer gets no text. With it on, the sheet posts
  `customerRecapMode: 'reservice_fixed'` (review ask and pay link stay off) and
  **no `customerRecap`**. The server, only while both gates are on and the
  visit is a pest re-service, sends **one** fixed text built from the saved
  address, areas and product targets and methods
  (`services/reservice-fixed-recap.js`), never AI and never signed, through its
  normal consent-checked path, and stores the sent body in
  `structured_notes.completionSmsBody`. The "keep kids and pets off" sentence
  needs a recorded liquid application; a clause with no recorded fact is
  dropped.

### Lawn (`lawn`)
Catalog: `lawn_care_6week`, `lawn_care_monthly`, `lawn_care_quarterly`,
`lawn_care_recurring`, and the basic-form one-time add-ons `dethatching`,
`plugging` and `top_dressing`. Uses the basic form facts, product facts and
photos, plus:

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `lawn_assessment_observations` | photo, derived | `lawn_assessments.observations` | Lawn diagnosis / insights card | fallback to the AI summary |
| `lawn_assessment_ai_summary` | derived | `lawn_assessments.ai_summary` | Lawn diagnosis / insights card (fallback source) | fallback |
| `turf_height_reading` | voice, tap | `turf_height_readings.manual_height_in` | Mowing height card | hidden |
| `turf_height_gauge_photo` | photo | `turf_height_readings.gauge_photo_id` | Mowing height card (gauge photo) | hidden |

`lawn-report-v2.js` reads `observations || aiSummary || customerSummary`;
`lawn_assessments` has no `customer_summary` column, so `aiSummary`
(`lawn_assessments.ai_summary`, written by `knowledge-bridge.js`) is the real
second source and is registered as its own fact — `customerSummary` is dead
code on this path. Product facts on this line get the lawn-specific
treatment-card readers (`productFacts({ extraReaders: {...} })`); no other
line does.

The numeric reading and the gauge photo are separate facts: either can be
present without the other (a photo-only row stores a null reading), and
`report-data.js` resolves the photo id onto `mowingHeight.photoUrl`
independently of the reading. `turf_height_gauge_photo` isn't sent by
SchedulePage.jsx today — it's registered because
`complete-scheduled-service.js` and `turf-height-service.js` both persist and
read the column.

### Mosquito (`mosquito`)
Catalog: `mosquito_monthly`, `mosquito_seasonal`. Uses the basic form facts,
product facts and photos. `finding_rows` is also read by
`mosquito-report-v2.js`, which matches finding text for the habitat watch
(standing water, foliage, lanai). If the tech records no observation, the
habitat watch has nothing to show.

### Bora-Care wood treatment (`bora_care`)
Catalog: `bora_care`. A one-time termite-adjacent wood treatment completed
through the SAME basic Complete Service form as `one_time_pest` / `lawn`'s
one-time add-ons (`completion-lane-registry.js` `ONE_TIME_GENERIC_BY_DESIGN`)
— the form doesn't branch UI by catalog key, so it carries the same basic
form facts, product facts and photos as `one_time_pest`. It does not carry
the pest activity rating: `detectServiceLine` reads "bora" as termite and the
Pest Pressure rating is only enabled for its configured service lines
(default pest + mosquito), so a Bora-Care completion never captures one. Its beetle/wood-decay-fungi targets don't exist in
`termite_treatment`'s option list and it doesn't share `one_time_pest`'s pest
vocabulary or `lawn`'s condition vocabulary, so it stays its own basic-form
line rather than joining either one (codex follow-up on #5190; was
previously parked as an unregistered active service with no line of its
own).

### Typed lines

Each typed line below is one typed form. Its typed facts are listed in the
generated [Typed form facts](#typed-form-facts-generated) tables. Every line
also adds the [shared facts above](#shared-facts-every-typed-line-also-carries-typedsharedcompletionfacts)
(`customer_recap`, `customer_interaction`, `protocol_actions_completed`,
`protocol_action_scopes_completed`, `customer_concern_text`, `visit_time_on_site`,
`visit_duration_allocation`, `recommendations`, `form_recommendations`,
`tech_tips`, `technician_notes`, `reentry_exterior_minutes`,
`reentry_interior_minutes`) and, on the nine lines with a gauge,
[`typed_activity_score`](#typed-activity-score-typedactivityscorefacts);
only the *other* facts each line adds by hand are named here.

- **Tree & shrub** (`tree_shrub`, form `tree_shrub`): `tree_shrub_program`,
  `tree_shrub_6week`, `tree_shrub_quarterly`. No gauge (`ACTIVITY_INDICATORS`
  has no `tree_shrub` entry). Adds the typed photo summary,
  `tree_shrub_assessment_observations` and `tree_shrub_assessment_ai_summary`
  (`tree_shrub_assessments.observations` / `.ai_summary` — same
  observations-then-AI-summary fallback as lawn; `tree_shrub_assessments` has
  no `customer_summary` column either), product facts (with the tree-&-shrub
  treatment-card readers) and photos. `completion_photos` is **required**
  here (`TREE_SHRUB_MIN_CLOSEOUT_PHOTOS` uploads); the caption stays
  optional. Its palm / shrub / bed module detail fields are `companionOnly`
  (`applicability: 'companion'` in the generated table, storage
  `service_data.companionReportSnapshots[].values.<key>`) — they only ever
  populate when tree_shrub runs as a COMPANION section beside a different
  primary type. `treatments_completed` is the opposite shape: it's `both`
  (recorded on a primary submission too, `autoFilled`), but the companion
  validator additionally REQUIRES it (`COMPANION_REQUIRED_FINDINGS_FIELDS`) —
  the server can't derive a companion T&S's own treatments from the visit's
  ONE shared products list, so the fact carries `companionWhenMissing:
  'required'` alongside its primary `whenMissing: 'hidden'`. Also carries the
  two internal `pesticideOnly` compliance fields, `pollinator_status` and
  `irac_frac_logged` — conditionally required whenever an insecticide/other
  pesticide product is applied (see [Typed findings](#typed-findings-typedformfacts)).
- **Cockroach** (`cockroach`, form `cockroach`): `cockroach_control`,
  `german_roach`, `german_roach_initial`. Has a gauge
  (`typed_activity_score`, `roach_activity`, derived from `activity_level`).
  Adds the typed photo summary,
  product facts, photos and `cockroach_work_from_products`: the form's
  `work_completed` chips are `autoFilled` (hidden) and derived at completion
  from the submitted product rows (`cockroach-work-from-products.js`), so the
  report's "What we did" reads them as before. Records completed earlier keep
  the chips the tech picked.
- **Termite bait** (`termite_bait`, form `termite_bait_station`,
  `20260612000001`): `termite_bait`, `termite_active_annual`,
  `termite_active_bait_quarterly`, `termite_monitoring`,
  `termite_cartridge_replacement`, `termite_installation_setup`. Adds the
  typed photo summary, product facts and photos.
- **Rodent trapping** (`rodent_trapping`, form `rodent_trapping`):
  `rodent_trapping`, `rodent_trapping_exclusion`,
  `rodent_trapping_sanitation`, `rodent_trapping_exclusion_sanitation`,
  `rodent_trapping_followup`, `rodent_trap_check_additional`,
  `trap_only_retainer_monthly`, `trap_only_retainer_standard`,
  `trap_only_retainer_plus`. The combo keys record exclusion and sanitation
  on this same form (its "(combo)" fields). Adds the typed photo summary
  (also read by `rodent-report-narrative.js`), product facts and photos.
- **Rodent exclusion** (`rodent_exclusion`, form `rodent_exclusion`):
  `rodent_exclusion`, `rodent_exclusion_only`, `rodent_bird_box`,
  `rodent_wire_mesh`. No species field; all four fields are required. Adds
  the typed photo summary, product facts and photos.
- **Rodent bait stations** (`rodent_bait_station`, form
  `rodent_bait_station`, `20260612000001`): `rodent_bait_quarterly`,
  `rodent_bait_setup`. Adds the typed photo summary, product facts and
  photos.
- **Wildlife** (`wildlife`, form `wildlife_trapping`): `wildlife_trapping`.
  Adds the typed photo summary, product facts (the same always-visible
  Products Applied picker as every other lane; `service_products` rows are
  never excluded for wildlife) and photos.
- **Flea** (`flea`, form `flea`): `flea_tick`. Adds the typed photo summary,
  product facts and photos.
- **Palm** (`palm`, form `palm_injection`): `palm_injection`,
  `palm_injection_semiannual`. Adds the typed photo summary, product facts
  and photos. The basic-form `palm_treatment` row is archived (see Retired
  catalog keys).
- **Termite treatment** (`termite_treatment`, form `termite_treatment`):
  `termite_liquid`, `termite_trenching`, `termite_spot_treatment`,
  `termite_pretreatment`, `foam_drill`, `foam_recurring` (`20260713100000`,
  `20260808070000`). Adds the typed photo summary, product facts and photos.
- **Rodent inspection** (`rodent_inspection`, form `rodent_inspection`):
  `rodent_inspection`, `rodent_general_one_time` (`20260612000012`,
  `20260712200000`). Diagnostic/one-time — adds the typed photo summary,
  product facts and photos.
- **Rodent sanitation** (`rodent_sanitation`, form `rodent_sanitation`):
  `rodent_sanitation_light`, `rodent_sanitation_standard`,
  `rodent_sanitation_heavy` (`20260612000012`, `20260712200000`). Adds the
  typed photo summary, product facts and photos.
- **Mosquito event** (`mosquito_event`, form `mosquito_event`):
  `mosquito_one_time` (`20260611000012`). One-time event spray — adds the
  typed photo summary, product facts and photos.
- **One-time lawn treatment** (`one_time_lawn_treatment`, form
  `one_time_lawn_treatment`): `lawn_care_one_time` (`20260611000012`),
  `lawn_pest_knockdown` (`20260809000000`), `lawn_re_service`
  (`20260618000001`). Outside the recurring WaveGuard flow — adds the typed
  photo summary, product facts and photos.

A new active service becomes a line the same two ways: a typed one by adding
it with its `typedForm` (its facts then generate), a basic-form one by giving
it its own `genericCompletionFacts()` entry (or joining an existing line's
`catalogKeys` if its vocabulary genuinely matches that line) — as `bora_care`
did above.

### Retired catalog keys

Archived rows no new visit books. `RETIRED_CATALOG_KEYS` maps each one to the
migration that retired it, and the test fails if a line lists one:
`pest_termite_bait_quarterly` and `lawn_tree_shrub_combo` (`20260831000070`),
`lawn_fertilization` and `palm_treatment` (`20260519000003`). Their frozen
reports still render through the same facts as the active keys.

## Excluded: WDO and pre-treat

`wdo_inspection` (FDACS-13645) and `termite_slab_pretreat` (typed pointer
`pre_treatment_termite_certificate`, the FBC certificate) stay on the
compliance Projects flow. They never produce a customer Service Report, and
voice fill does not cover them. The registry lists them in
`EXCLUDED_SERVICE_LINES`, and the test fails if either one appears as a line
identifier OR inside any line's `catalogKeys` (the same both-places check the
retired-key test runs for `RETIRED_CATALOG_KEYS`).

## How to add a fact

A typed form field needs **no registry edit**: add it to the form's
`findingsFields` in `project-types.js` (and to `REQUIRED_FINDINGS_FIELDS` if
the form requires it), then regenerate the doc tables with
`node server/scripts/generate-visit-facts-doc.js`. If a type-specific builder
in `TYPED_REPORT_BUILDERS` starts reading the field, add it to that entry's
`keys` (and a `sections` label); the test fails until you do. For any other
fact:

1. Add the fact to the right line in `server/config/visit-facts-contract.js`,
   or to a shared builder if every line using that builder records it. Give
   it `key`, `label`, `capture[]`, `storage` (one dotted path whose last
   segment is the real key), `writers` (the server writer plus the client
   surface that submits it; a writer that submits it under another name is
   `{ file, writerSymbol }`), `readers` and `whenMissing`.
2. If a report reads it generically instead of by name, give that reader a
   `readerSymbol`: an identifier that appears in the reader file.
3. If nothing reads it yet, set `readers: []` and `status: 'gap'`, and add
   a `<line>.<key>` bullet to **Known gaps** below. The test enforces both
   directions.
4. On a voice-fill line, a fact captured only by `tap` needs `tapOnly: true`
   and a `reason`.
5. A measurement names its unit fact in `qualifiedBy`.
6. Add a row to the matching table in this doc.
7. Run `cd server && npx jest tests/visit-facts-contract.test.js --runInBand`.

A report section must not render a claim unless a fact here supports it. To
add a new claim, add the fact first.

## Known gaps

Facts marked `status: 'gap'` in the registry, one bullet per
`<line>.<fact key>`. The test checks both directions: every registry gap is
listed here, and every bullet here is still a gap fact on that line.

- `recurring_pest.pests_found_where`: **recurring pest has no pests-found
  fact.** "Found" (pests, where) is supposed to be a voice-filled summary
  line, but nothing records it today. The observations vocabulary is
  species-neutral and was unused on 0 of 69 visits, and product targets are
  the label list, not finds. Voice fill has to add the storage.

## Data-quality and writer gaps

These are not registry facts, so the test doesn't check them:

- **Per-product area is missing on 100 of 240 pest product rows** (last 30
  days). `product_application_area` has readers, but the data is often empty.
- **The AI report writer never sees the photos themselves.** With
  `GATE_REPORT_PHOTO_CONTENT` on (#5145) it gets up to 5 tech-reviewed
  captions and a photo summary; with it off, only `photoCount`. An
  uncaptioned photo gives the writer nothing to ground on.
- The pest "what to expect" section must read only the facts above: method,
  area and targets per product, never free text. (Cross-sell V2 was deleted
  2026-09-28; report offers read no typed findings.)

## Typed form facts (generated)

<!-- BEGIN GENERATED: typed form facts (server/scripts/generate-visit-facts-doc.js) -->

Generated from the registry, which generates these facts from each form's
`findingsFields` (`project-types.js`) and `REQUIRED_FINDINGS_FIELDS`
(`activity-indicators.js`). Do not edit this block by hand: run
`node server/scripts/generate-visit-facts-doc.js`. Every fact not marked
internal also renders in the generic typed findings list. `applicability`
`companion` means the field is `companionOnly` in project-types.js — legal
ONLY when the form runs as a COMPANION section beside a different primary
type (a primary submission carrying it is rejected as unknown); `both`
means the field is legal on a primary OR a companion submission.

### `tree_shrub` — typed `tree_shrub` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `areas_treated` | Areas treated | multi_select | both | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `plant_groups` | Plant groups serviced | multi_select | both | required | Today's Result tree & shrub story (buildTodaysResult) (activity-indicators.js) |
| `landscape_condition` | Overall landscape condition | select | both | required | Today's Result tree & shrub story (buildTodaysResult) (activity-indicators.js) |
| `observed_conditions` | Observed plant conditions | multi_select | companion | hidden | — |
| `treatments_completed` | Treatment completed | multi_select | both | hidden (companion: required) | — |
| `palms_serviced` | Palms serviced | count | companion | hidden | — |
| `palm_condition` | Palm condition | select | companion | hidden | — |
| `palm_nutrient_stress` | Palm nutrient stress | select | companion | hidden | — |
| `spear_leaf_condition` | Spear leaf condition | select | companion | hidden | — |
| `canopy_density` | Canopy density | select | companion | hidden | — |
| `palm_trunk_concern` | Trunk concern | select | companion | hidden | — |
| `ganoderma_conk_observed` | Visible Ganoderma conk | select | companion | hidden | — |
| `injection_recommended` | Injection recommended | select | companion | hidden | — |
| `pest_pressure` | Pest pressure | select | companion | hidden | — |
| `disease_pressure` | Disease pressure | select | companion | hidden | — |
| `deficiency_symptoms` | Deficiency symptoms | select | companion | hidden | — |
| `new_growth_present` | New growth present | select | companion | hidden | — |
| `pruning_issue_observed` | Pruning issue observed | select | companion | hidden | — |
| `irrigation_issue_observed` | Irrigation issue observed | select | companion | hidden | — |
| `bed_weed_pressure` | Bed weeds present | select | companion | hidden | — |
| `pre_emergent_applied` | Pre-emergent applied | select | companion | hidden | — |
| `mulch_depth_concern` | Mulch depth concern | select | companion | hidden | — |
| `weed_breakthrough_areas` | Weed breakthrough areas | text | companion | hidden | — |
| `pollinator_status` | Flowering / pollinator status (internal) | select | both | hidden | Pesticide compliance gate (validateTreeShrubTypedCompliance) — required when an insect-family product (insecticide, miticide, IGR) is recorded (hasInsectProduct) (tree-shrub-closeout.js); Client pre-submit pesticide gate — shows and requires every pesticideOnly field once any pesticide product is recorded (broader than the server condition) (SchedulePage.jsx) |
| `irac_frac_logged` | IRAC / FRAC rotation checked & logged (internal) | select | both | hidden | Pesticide compliance gate (validateTreeShrubTypedCompliance) — required when any insecticide, fungicide or herbicide, or a product with an IRAC/FRAC/HRAC group, is recorded (needsIracFracLog) (tree-shrub-closeout.js); Client pre-submit pesticide gate — shows and requires every pesticideOnly field once any pesticide product is recorded (broader than the server condition) (SchedulePage.jsx) |
| `customer_recommendations` | Customer recommendations | multi_select | both | hidden | — |

### `cockroach` — typed `cockroach` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `species` | Species | select | both | required | Status + status summary; species label; How you can help (cockroach-report-v2.js) |
| `activity_level` | Activity level | select | both | required | "Activity today" metric + status (cockroach-report-v2.js) |
| `activity_locations` | Where activity was noted | chips | both | hidden | "Areas with activity" metric + status summary (cockroach-report-v2.js) |
| `evidence_observed` | Evidence observed | chips | both | hidden | Status reconciliation (resolveCockroachStatus) + status summary + evidence list (cockroach-report-v2.js) |
| `conducive_conditions` | Conducive conditions | chips | both | hidden | Conducive conditions list (dashboard conditions) (cockroach-report-v2.js) |
| `areas_treated` | Areas treated | chips | both | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `work_completed` | Work completed today | chips | both | hidden | "What we did" (buildWork) (cockroach-report-v2.js) |
| `customer_prep` | How the customer can help | chips | both | hidden | How you can help (buildHelp) (cockroach-report-v2.js) |

### `termite_bait` — typed `termite_bait_station` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `total_stations` | Total stations on property | count | both | hidden | Station summary + counts (reconciledSummary) (termite-report-v2.js) |
| `stations_checked` | Stations checked | count | both | required | Station summary + counts (reconciledSummary) (termite-report-v2.js) |
| `stations_inaccessible` | Stations inaccessible | count | both | hidden | Station summary + counts (reconciledSummary) (termite-report-v2.js) |
| `stations_with_activity` | Stations with termite activity | count | both | hidden | Activity summary + status resolution (termite-report-v2.js) |
| `termite_activity` | Termite activity | select | both | required | Status resolution (termite-report-v2.js) |
| `activity_signs` | Activity signs | chips | both | hidden | Status resolution (termite-report-v2.js) |
| `active_station_location` | Active station number / location | text | both | hidden | Status resolution (active location) (termite-report-v2.js) |
| `bait_consumption` | Bait consumption | select | both | required | Status resolution + "bait engaged" activity detail (termite-report-v2.js) |
| `bait_actions` | Bait service performed | chips | both | hidden | "Serviced today" claim (termite-report-v2.js) |
| `bait_issues` | Bait condition issues | chips | both | hidden | — |
| `station_issues` | Station condition issues | chips | both | hidden | — |
| `station_actions` | Station service performed | chips | both | hidden | "Serviced today" claim (termite-report-v2.js) |
| `conducive_conditions` | Conducive conditions | chips | both | hidden | Primary move (why) (termite-report-v2.js) |
| `customer_recommendations` | Customer recommendations | chips | both | hidden | Primary move (termite-report-v2.js) |

### `rodent_trapping` — typed `rodent_trapping` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `species` | Species | select | both | required | Species grounding for the narrative (rodent-report-narrative.js) |
| `evidence_observed` | Evidence observed | chips | both | hidden | — |
| `trap_visit_type` | This visit (internal) | select | both | required | Today's Result trap-setup wording (isInitialRodentTrapSetup) (activity-indicators.js); Narrative visitStage "initial_trap_setup" (rodent-report-narrative.js) |
| `traps_checked` | Traps checked | count | both | hidden | Trap counts (station summary) (report-data.js) |
| `captures` | Captures | count | both | hidden | Grounded capture sentence (rodent-report-narrative.js) |
| `trap_actions` | Trap actions | chips | both | hidden | — |
| `trap_activity_locations` | Locations with activity | text | both | hidden | — |
| `sanitation_recommendations` | Sanitation recommendations | chips | both | hidden | — |
| `exclusion_recommendation` | Exclusion | select | both | hidden | — |
| `entry_points_addressed` | Entry points sealed (combo) | chips | both | hidden | — |
| `exclusion_materials` | Materials used (combo) | chips | both | hidden | — |
| `remaining_concerns` | Remaining access concerns (combo) | chips | both | hidden | — |
| `exclusion_followup_needed` | Exclusion follow-up needed | select | both | hidden | — |
| `sanitation_areas` | Areas cleaned (combo) | chips | both | hidden | — |
| `contamination_level` | Contamination level (combo) | select | both | hidden | — |
| `evidence_cleaned` | Evidence removed (combo) | chips | both | hidden | — |
| `sanitation_limitations` | Sanitation limitations (combo) | chips | both | hidden | — |
| `additional_cleanup_needed` | Additional cleanup needed | select | both | hidden | — |

### `rodent_exclusion` — typed `rodent_exclusion` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `entry_points_addressed` | Entry points addressed | chips | both | required | — |
| `exclusion_work_completed` | Work completed | chips | both | required | Today's Result rodent exclusion story (buildTodaysResult) (activity-indicators.js) |
| `exclusion_materials` | Materials used | chips | both | required | — |
| `remaining_concerns` | Remaining concerns | chips | both | required | Today's Result rodent exclusion story (buildTodaysResult) (activity-indicators.js) |

### `rodent_bait_station` — typed `rodent_bait_station` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `stations_checked` | Stations checked | count | both | required | — |
| `stations_inaccessible` | Stations inaccessible | count | both | hidden | — |
| `station_actions` | Station service performed | chips | both | hidden | — |
| `bait_consumption` | Bait consumption level | select | both | required | — |
| `bait_replaced` | Bait replaced | select | both | hidden | — |
| `highest_activity_location` | Highest-activity station / location | text | both | hidden | — |
| `bait_issues` | Bait / station contents | chips | both | hidden | — |
| `evidence_observed` | Rodent evidence nearby | chips | both | hidden | — |
| `station_issues` | Station condition issues | chips | both | hidden | — |
| `conducive_conditions` | Attractants / harborage | chips | both | hidden | — |
| `sanitation_recommendations` | Customer recommendations | chips | both | hidden | — |

### `wildlife` — typed `wildlife_trapping` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `target_animal` | Suspected species | select | both | required | — |
| `evidence_observed` | Evidence observed | chips | both | hidden | — |
| `entry_points` | Entry / access points | chips | both | hidden | — |
| `traps_checked` | Traps checked | count | both | hidden | — |
| `captures` | Captures | count | both | hidden | — |
| `trap_actions` | Trap / device status | chips | both | hidden | — |
| `customer_recommendations` | Customer recommendations | chips | both | hidden | — |

### `flea` — typed `flea` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `evidence_level` | Evidence / activity level | select | both | required | Flea activity gauge + Today's Result flea story (buildTodaysResult) (activity-indicators.js) |
| `activity_areas` | Activity areas | chips | both | hidden | Today's Result flea story (buildTodaysResult) (activity-indicators.js) |
| `areas_treated` | Areas treated | chips | both | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `treatment_completed` | Treatment completed | chips | both | required | Today's Result flea story body (composedWorkSentence / WORK_PHRASE_FIELDS.flea) (activity-indicators.js) |
| `contributing_conditions` | Contributing conditions | chips | both | hidden | — |
| `customer_prep` | Customer prep / aftercare | chips | both | required | — |

### `palm` — typed `palm_injection` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `palm_species` | Palm species | text | both | hidden | — |
| `palms_serviced` | Palms serviced | count | both | hidden | — |
| `areas_treated` | Palms treated | chips | both | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `palm_condition` | Overall palm condition | select | both | required | — |
| `condition_observations` | Canopy & growth observations | chips | both | hidden | — |
| `deficiency_signs` | Nutrient observations | chips | both | hidden | — |
| `pest_disease_signs` | Pest & disease check | chips | both | hidden | — |
| `work_completed` | Work completed today | chips | both | hidden | — |
| `customer_recommendations` | Customer recommendations | chips | both | hidden | — |

### `termite_treatment` — typed `termite_treatment` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `target_termite` | Target termite / WDO | select | both | required | — |
| `termite_evidence` | Evidence observed | chips | both | hidden | — |
| `areas_treated` | Areas treated | chips | both | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `treatment_method` | Treatment method | select | both | required | — |
| `products_used` | Products used | textarea | both | required | — |
| `percent_solution` | % solution | text | both | hidden | — |
| `epa_registration` | EPA reg. no. | text | both | required | — |
| `linear_feet_or_stations` | Linear feet / stations | textarea | both | required | — |
| `gallons_or_amount` | Gallons / amount applied | textarea | both | required | — |
| `posted_notice` | Posted notice placed (exterior / perimeter applications) | select | both | required | — |
| `followup_plan` | Follow-up / warranty plan | textarea | both | hidden | — |

### `rodent_inspection` — typed `rodent_inspection` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `areas_inspected` | Areas inspected | chips | both | required | — |
| `activity_found` | Activity found | select | both | required | — |
| `evidence_observed` | Evidence type | chips | both | hidden | — |
| `species` | Suspected rodent type | select | both | hidden | — |
| `entry_points_found` | Entry points found | text | both | hidden | — |
| `conducive_conditions` | Conducive conditions | chips | both | hidden | — |
| `recommended_service` | Recommended service | select | both | required | — |
| `urgency` | Urgency | select | both | required | — |

### `rodent_sanitation` — typed `rodent_sanitation` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `sanitation_areas` | Areas serviced | chips | both | required | — |
| `contamination_level` | Contamination level | select | both | required | — |
| `sanitation_work_completed` | Work completed | chips | both | required | — |
| `sanitation_limitations` | Limitations | chips | both | required | — |

### `mosquito_event` — typed `mosquito_event` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `activity_level` | Mosquito activity level | select | both | required | — |
| `activity_locations` | Where activity was noted | chips | both | hidden | — |
| `treatment_completed` | Treatment completed | chips | both | hidden | — |
| `treatment_zones` | Treatment zones | chips | both | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `standing_water` | Standing water found | select | both | required | — |
| `breeding_sources` | Breeding sources noted | chips | both | hidden | — |
| `source_reduction` | Source reduction completed | chips | both | hidden | — |
| `sensitive_areas` | Sensitive areas present | chips | both | hidden | — |
| `sensitive_areas_avoided` | Sensitive-area handling | select | both | hidden | — |
| `weather_conditions` | Weather conditions | chips | both | hidden | — |
| `customer_recommendations` | Customer recommendations | chips | both | hidden | — |
| `customer_reported` | Customer reported | chips | both | hidden | — |
| `customer_discussed` | Discussed with customer | chips | both | hidden | — |

### `one_time_lawn_treatment` — typed `one_time_lawn_treatment` form

| fact | label | type | applicability | when missing | also read by name in |
|---|---|---|---|---|---|
| `turf_type` | Turf type | select | both | hidden | — |
| `lawn_condition` | Lawn condition | select | both | required | — |
| `turf_color` | Turf color | select | both | hidden | — |
| `weed_pressure` | Weed pressure | select | both | hidden | — |
| `insect_pressure` | Insect pressure | select | both | hidden | — |
| `disease_pressure` | Disease pressure | select | both | hidden | — |
| `turf_issues` | Issues observed | chips | both | hidden | — |
| `irrigation_mowing` | Irrigation & mowing notes | chips | both | hidden | — |
| `work_completed` | Work completed today | chips | both | hidden | — |
| `spot_treatment_areas` | Areas treated | chips | both | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `customer_recommendations` | Customer recommendations | chips | both | hidden | — |

<!-- END GENERATED: typed form facts -->
