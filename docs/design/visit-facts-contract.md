# Visit facts contract

Status: Step 1 of the owner's plan to sync the tech's Complete Service form
with the customer service report (owner rulings 2026-09-28). This step adds a
registry, this doc and a CI test. **It changes no runtime behavior.**

- Registry (source of truth): `server/config/visit-facts-contract.js`
- Guard: `server/tests/visit-facts-contract.test.js` (static, no DB)
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
5. The **office note never reaches the report writer**. Only
   `service_records.technician_notes` and the structured facts below are
   customer-facing inputs.
6. **WDO and pre-treat are out of scope** (see below).
7. **Per-product standard amounts are deferred** ("protocols later"). Voice
   fill must never guess an amount.

## Vocabulary

**Capture** (a fact can have several):

| capture | meaning |
|---|---|
| `tap` | the tech types or picks it on the Complete Service form (`client/src/pages/admin/SchedulePage.jsx` CompletionPanel) or the Fast Complete sheet |
| `voice` | voice fill must write it. Voice fill has **not shipped yet**, so today every `voice` fact is filled by `tap` |
| `prefill` | defaulted from the protocol, the product label or the service config; the tech confirms it |
| `derived` | computed by the server from other facts or photos |
| `photo` | an uploaded image, optionally captioned |

**When missing:** `hidden` means the section or line doesn't render.
`fallback` means a less specific source is used. `filler` means fixed
zero-state copy. `required` means the form will not submit without it.

## Shared fact sets

Most lines reuse these three sets. Each line section below lists only what
it adds or changes.

### Basic form facts (`genericCompletionFacts`)

Stored in `service_records.structured_notes` (built in
`complete-scheduled-service.js`), except `technician_notes`, which has its
own column.

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `areas_treated` ("Treated") | voice, tap | `structured_notes.areasTreated` | Areas treated / coverage (report-data.js) | fallback to the request's `areasServiced` |
| `observations` | voice, tap | `structured_notes.observations` | Findings (report-data.js) | hidden |
| `form_observations` | voice, tap | `structured_notes.formObservations` | Findings, form-sourced only | hidden |
| `finding_rows` | derived | `service_findings.title` | Findings list | hidden |
| `recommendations` | prefill, tap | `structured_notes.recommendations` | Recommendations | hidden |
| `form_recommendations` | prefill, tap | `structured_notes.formRecommendations` | Recommendations, form-sourced only | hidden |
| `tech_tips` | prefill, tap | `structured_notes.techTips` | Tips from your tech (`techNote`, `GATE_TECH_TIPS`) | hidden |
| `protocol_actions_completed` | prefill, tap | `structured_notes.protocolActionsCompleted` | What we did (protocol actions) | hidden |
| `technician_notes` | voice, tap | `service_records.technician_notes` | Technician report body, `[found]`/`[next]` lines | hidden |
| `customer_concern_text` | tap only | `structured_notes.customerConcernText` | Customer concern grounding | hidden |
| `customer_recap` | derived, voice, tap | `structured_notes.customerRecap` | Visit summary paragraph | fallback to the generated summary |
| `customer_interaction` | voice, tap | `structured_notes.customerInteraction` | Customer interaction line | hidden |
| `visit_outcome` | prefill, tap | `structured_notes.visitOutcome` | No-application copy branch | fallback `completed` |

`customer_concern_text` is the only fact marked tap-only (`tapOnly` +
`reason`). It holds the customer's own words. Customer texts and calls shape
voice-fill questions but never fill in findings.

### Product facts (`productFacts`), one set per `service_products` row

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `product_application_method` | prefill, voice, tap | `service_products.application_method` | What we did; premium primary move | hidden |
| `product_targets` | prefill, voice, tap | `service_products.targets` | What we did; bug files; lawn and T&S treatment cards | hidden |
| `product_application_area` | voice, tap | `service_products.application_area` | What we did; treated areas | hidden |
| `product_area_value` | voice, tap | `service_products.area_value` (unit: `area_unit`) | What we did | hidden; required for perimeter spray |
| `product_total_amount` | prefill, voice, tap | `service_products.total_amount` (unit: `amount_unit`) | What we did | hidden |

The dark pest "what to expect" section needs method, area and target on
each product. All three are here. **Targets on the full form are prefilled
from the product label. They describe the product mix, not pests found.**

### Photos (`photoFacts`)

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `completion_photos` | photo | `service_photos.caption` | Photos gallery (caption under each photo) | hidden (required on tree & shrub) |

### Typed findings (`typedFindingFact`)

A typed field is stored under `service_data.typedReportSnapshot.values.<key>`
(primary section) or `service_data.companionReportSnapshots[].values.<key>`
(companion section). Every non-internal typed field is shown in the generic
typed findings list (`activity-indicators.js` `buildTypedReportSnapshot`).
Field options, required rules and customer copy are covered in
[the specialty completion contract](specialty-service-completion-contract.md);
this doc does not repeat them. Below, the typed lines list only the fields
that a report section reads **by name**.

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
- Fast Complete sends products (method, targets, area, amount, linear ft),
  `areasServiced`, the rating and `technicianNotes`. It sends **no customer
  text and no photos**: `fast_complete_customer_text` is a **gap**.

### Lawn (`lawn`)
Catalog: `lawn_care_*`, `lawn_fertilization`, and the lawn half of
`lawn_tree_shrub_combo`. Uses the basic form facts, product facts and photos,
plus:

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `lawn_assessment_observations` | photo, derived | `lawn_assessments.observations` | Lawn diagnosis / insights card | fallback to the AI summary |
| `turf_height_reading` | tap, photo | `turf_height_readings.manual_height_in` | Mowing height card | hidden |

### Mosquito (`mosquito`)
Catalog: `mosquito_monthly`, `mosquito_seasonal`. Uses the basic form facts,
product facts and photos. `finding_rows` is also read by
`mosquito-report-v2.js`, which matches finding text for the habitat watch
(standing water, foliage, lanai). If the tech records no observation, the
habitat watch has nothing to show.

### Tree & shrub (`tree_shrub`)
Catalog: the companion section of `lawn_tree_shrub_combo`. Typed companion
fields `observed_conditions`, `treatments_completed` and
`customer_recommendations`; `tree_shrub_assessment_observations`
(`tree_shrub_assessments.observations`, read by the tree & shrub findings
summary); product facts; and `completion_photos`, which is **required** here
(`TREE_SHRUB_MIN_CLOSEOUT_PHOTOS`).

### Cockroach (`cockroach`)
Catalog: `cockroach_control`, `german_roach`, `german_roach_initial` (typed
`cockroach` form). Fields read by name in `cockroach-report-v2.js`:

| fact | report section |
|---|---|
| `species` | Status + status summary |
| `activity_level` | "Activity today"; also cross-sell V2 findings signal (companion only) |
| `activity_locations` | "Areas with activity" |
| `work_completed` | "What we did" (`buildWork`) |
| `customer_prep` | How you can help |

This line also has product facts and photos. `cockroach_work_from_products`
is a **gap**.

### Termite bait (`termite_bait`)
Catalog: `pest_termite_bait_quarterly`. The pest primary uses the basic form
facts, product facts and photos. The typed `termite_bait_station` companion
fields are read by `termite-report-v2.js`: `stations_checked`,
`total_stations`, `stations_inaccessible`, `stations_with_activity`,
`termite_activity`, `bait_consumption`, `active_station_location` and
`customer_recommendations`. `termite_activity` and `bait_consumption` also
feed the cross-sell V2 findings signal.

### Rodent (`rodent`)
Catalog: the `rodent_trapping_*` and `rodent_exclusion*` keys. Typed fields:
`species` (rodent narrative), `traps_checked` (trap counts), `captures`
(narrative + cross-sell V2), `entry_points_addressed`,
`exclusion_work_completed` and `sanitation_recommendations` (typed findings
list). Also product facts and photos.

### Wildlife (`wildlife`)
Catalog: `wildlife_trapping`. Typed fields `target_animal`,
`evidence_observed`, `entry_points`, `traps_checked` and
`customer_recommendations` (typed findings list), plus photos.

### Flea (`flea`)
Catalog: `flea_tick`. Typed fields: `evidence_level` (activity gauge),
`activity_areas` (required unless `evidence_level` is "None observed"),
`areas_treated` (`TYPED_AREA_FIELD_KEYS`) and `customer_prep`. Also product
facts and photos.

### Palm (`palm`)
Catalog: `palm_treatment`. Uses the basic form: the typed `palm_injection`
repoint is deferred (`completion-lane-registry.js` `CUTOVER_IN_FLIGHT_KEYS`).
Facts: basic form facts, product facts and photos.

Typed types not listed above (`pest_inspection`, `termite_inspection`,
`termite_treatment`, `one_time_lawn_treatment`, `mosquito_event`,
`palm_injection`, the rodent inspection and sanitation forms) render through
the generic typed findings list. Their field contract is in the specialty
doc.

## Excluded: WDO and pre-treat

`wdo_inspection` (FDACS-13645) and `termite_slab_pretreat` (typed pointer
`pre_treatment_termite_certificate`, the FBC certificate) stay on the
compliance Projects flow. They never produce a customer Service Report, and
voice fill does not cover them. The registry lists them in
`EXCLUDED_SERVICE_LINES`, and the test fails if either one appears as a line.

## How to add a fact

1. Add the fact to the right line in `server/config/visit-facts-contract.js`,
   or to a shared builder if every line using that builder records it. Give
   it `key`, `label`, `capture[]`, `storage` (one dotted path whose last
   segment is the real key), `writers` (the server writer plus the client
   surface that submits it), `readers` and `whenMissing`.
2. If a report reads it generically instead of by name, give that reader a
   `readerSymbol`: an identifier that appears in the reader file.
3. If nothing reads it yet, set `readers: []` and `status: 'gap'`, and add
   its key to **Known gaps** below. The test enforces both.
4. On a voice-fill line, a fact captured only by `tap` needs `tapOnly: true`
   and a `reason`.
5. Add a row to the matching table in this doc.
6. Run `cd server && npx jest tests/visit-facts-contract.test.js --runInBand`.

A report section must not render a claim unless a fact here supports it. To
add a new claim, add the fact first.

## Known gaps

Facts marked `status: 'gap'` in the registry. The test checks that each key
is listed here:

- `pests_found_where`: **recurring pest has no pests-found fact.** "Found"
  (pests, where) is supposed to be a voice-filled summary line, but nothing
  records it today. The observations vocabulary is species-neutral and was
  unused on 0 of 69 visits, and product targets are the label list, not
  finds. Voice fill has to add the storage.
- `cockroach_work_from_products`: **the cockroach "What we did" section has
  no product fallback.** `buildWork` in `cockroach-report-v2.js` reads only
  the `work_completed` chips. A visit that recorded products but no chips
  shows no work.
- `fast_complete_customer_text`: **Fast Complete sends no customer text.**
  `FastCompleteSheet.jsx` `completionBody` sends no `customerRecap` and sets
  `sendCompletionSms: false`.

Data-quality and writer gaps (not registry facts, so the test doesn't check
them):

- **Per-product area is missing on 100 of 240 pest product rows** (last 30
  days). `product_application_area` has readers, but the data is often empty.
- **The AI report writer sees only the photo count.** The writer route
  (`server/routes/admin-schedule.js`) gets `photoCount` and never the photos
  or `service_photos.caption`. The report gallery does show captions.
- The dark sections (pest "what to expect", cross-sell V2) must read only the
  facts above: method, area and targets per product for expectations, and
  typed findings fields for cross-sell, never free text.
