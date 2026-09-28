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
| `voice` | voice fill must write it. Voice fill has **not shipped yet**, so today every `voice` fact is filled by `tap` |
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
| `technician_notes` (internal) | voice, tap, derived | `service_records.technician_notes` | AI report writer prompt ("Service Notes", `redactAccessCodes`); Visit summary / Today's Result body **only** through `technicianReportCustomerCopy`'s screened parse | fallback to the deterministic summary |
| `customer_concern_text` | tap only | `structured_notes.customerConcernText` | Customer concern grounding | hidden |
| `customer_recap` | derived, voice, tap | `structured_notes.customerRecap` | Visit summary paragraph | fallback to the generated summary |
| `customer_interaction` | voice, tap | `structured_notes.customerInteraction` | Customer interaction line | hidden |
| `visit_outcome` | prefill, tap | `structured_notes.visitOutcome` | No-application copy branch | fallback `completed` |

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

### Product facts (`productFacts`), one set per `service_products` row

| fact | capture | storage | report section | when missing |
|---|---|---|---|---|
| `product_application_method` | prefill, voice, tap | `service_products.application_method` | What we did; premium primary move | hidden |
| `product_targets` | prefill, voice, tap | `service_products.targets` | What we did; bug files; lawn and T&S treatment cards | hidden |
| `product_application_area` | voice, tap | `service_products.application_area` | What we did; treated areas | hidden |
| `product_area_value` | voice, tap | `service_products.area_value` | What we did; lawn treatment card area | hidden; required for perimeter spray |
| `product_area_unit` | prefill, voice, tap | `service_products.area_unit` | What we did; lawn treatment card area | hidden |
| `product_total_amount` | prefill, voice, tap | `service_products.total_amount` | What we did | hidden |
| `product_amount_unit` | prefill, voice, tap | `service_products.amount_unit` | What we did | hidden |
| `product_application_rate` | prefill, voice, tap | `service_products.application_rate` (the client sends `rate`) | What we did (rate) | hidden |
| `product_rate_unit` | prefill, voice, tap | `service_products.rate_unit` | What we did (rate) | hidden |

Each measurement names its unit fact (`qualifiedBy`): a value without its
unit is not interpretable, and the test fails if a measurement is registered
without one. The dark pest "what to expect" section needs method, area and target on
each product. All three are here. **Targets on the full form are prefilled
from the product label. They describe the product mix, not pests found.**

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
- **when missing** is `required` exactly when `REQUIRED_FINDINGS_FIELDS`
  (`activity-indicators.js`) lists the key, and `hidden` otherwise. A
  `requiredUnless` field (flea `activity_areas`) stays `hidden` with a note,
  because the validator enforces it only conditionally.
- **Readers**: every non-internal field renders in the generic typed
  findings list (`activity-indicators.js` `buildTypedReportSnapshot`). Named
  readers come from the builders' own key lists: `report-data.js`
  `TYPED_AREA_FIELD_KEYS` (areas treated), `cockroach-report-v2.js`
  `COCKROACH_V2_DASHBOARD_FIELD_KEYS`, and the `values.<key>` reads in
  `termite-report-v2.js` (`TYPED_REPORT_BUILDERS` in the registry). A few
  per-key readers (Today's Result stories, the rodent narrative, cross-sell
  V2) are registered by hand, and the test checks that the key appears in
  each reader file.
- **Storage** is `service_data.typedReportSnapshot.values.<key>`. The
  two-program combos retired on 2026-08-31 (`20260831000070`); their residual
  visits keep the same keys under
  `service_data.companionReportSnapshots[].values.<key>`, which
  `report-data.js` and `termite-report-v2.js` still read for those frozen
  reports.
- **Writers** are `project-types.js` (declares the key), the form
  (`typedFindings`) and the completion service (`typedReportSnapshot`).

The test re-derives all of this on its own. A typed line must carry exactly
its form's fields, with requiredness matching `REQUIRED_FINDINGS_FIELDS`. A
builder in `TYPED_REPORT_BUILDERS` must read exactly its registered keys, and
every one must be a field of its form. A typed fact written by hand fails.
Field options, tiers and customer copy are covered in
[the specialty completion contract](specialty-service-completion-contract.md).

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
  spray), `areasServiced`, the rating and `technicianNotes`. It sends **no
  customer text and no photos**, so `fast_complete_customer_text` is a
  **gap** with no writer.

### Lawn (`lawn`)
Catalog: `lawn_care_6week`, `lawn_care_monthly`, `lawn_care_quarterly`,
`lawn_care_recurring`, and the basic-form one-time add-ons `dethatching`,
`plugging` and `top_dressing`. Uses the basic form facts, product facts and
photos, plus:

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

### Typed lines

Each typed line below is one typed form. Its typed facts are listed in the
generated [Typed form facts](#typed-form-facts-generated) tables; only the
facts each line adds by hand are named here.

- **Tree & shrub** (`tree_shrub`, form `tree_shrub`): `tree_shrub_program`,
  `tree_shrub_6week`, `tree_shrub_quarterly`. Adds
  `tree_shrub_assessment_observations` (`tree_shrub_assessments.observations`,
  read by the tree & shrub findings summary), product facts and photos.
  `completion_photos` is **required** here (`TREE_SHRUB_MIN_CLOSEOUT_PHOTOS`
  uploads); the caption stays optional.
- **Cockroach** (`cockroach`, form `cockroach`): `cockroach_control`,
  `german_roach`, `german_roach_initial`. Adds product facts, photos and the
  `cockroach_work_from_products` **gap**. The cross-sell V2 roach signal
  reads `activity_level` only from a **companion** cockroach snapshot under
  a non-cockroach primary, so it is not a reader on this line.
- **Termite bait** (`termite_bait`, form `termite_bait_station`,
  `20260612000001`): `termite_bait`, `termite_active_annual`,
  `termite_active_bait_quarterly`, `termite_monitoring`,
  `termite_cartridge_replacement`, `termite_installation_setup`. Adds product
  facts and photos. The cross-sell V2 termite signal reads `termite_activity`
  only; `cross-sell.js` reads `bait_consumption` for rodent bait stations,
  never for termite.
- **Rodent trapping** (`rodent_trapping`, form `rodent_trapping`):
  `rodent_trapping`, `rodent_trapping_exclusion`,
  `rodent_trapping_sanitation`, `rodent_trapping_exclusion_sanitation`,
  `rodent_trapping_followup`, `rodent_trap_check_additional`,
  `trap_only_retainer_monthly`, `trap_only_retainer_standard`,
  `trap_only_retainer_plus`. The combo keys record exclusion and sanitation
  on this same form (its "(combo)" fields). Adds product facts and photos.
- **Rodent exclusion** (`rodent_exclusion`, form `rodent_exclusion`):
  `rodent_exclusion`, `rodent_exclusion_only`, `rodent_bird_box`,
  `rodent_wire_mesh`. No species field; all four fields are required. Adds
  product facts and photos.
- **Rodent bait stations** (`rodent_bait_station`, form
  `rodent_bait_station`, `20260612000001`): `rodent_bait_quarterly`,
  `rodent_bait_setup`. Adds product facts and photos.
- **Wildlife** (`wildlife`, form `wildlife_trapping`): `wildlife_trapping`.
  Adds photos.
- **Flea** (`flea`, form `flea`): `flea_tick`. Adds product facts and
  photos.
- **Palm** (`palm`, form `palm_injection`): `palm_injection`,
  `palm_injection_semiannual`. Adds product facts and photos. The basic-form
  `palm_treatment` row is archived (see Retired catalog keys).

### Active services not on a line yet

These complete today, but no line in the registry covers them yet. Their
typed fields render through the generic typed findings list, and their field
contract is in the specialty doc. A typed one becomes a line by adding it
with its `typedForm`; its facts then generate:

- typed `termite_treatment`: `termite_liquid`, `termite_trenching`,
  `termite_spot_treatment`, `termite_pretreatment`, `foam_drill`,
  `foam_recurring`
- typed `rodent_inspection`: `rodent_inspection`, `rodent_general_one_time`
- typed `rodent_sanitation`: `rodent_sanitation_light`,
  `rodent_sanitation_standard`, `rodent_sanitation_heavy`
- typed `mosquito_event`: `mosquito_one_time`
- typed `one_time_lawn_treatment`: `lawn_care_one_time`,
  `lawn_pest_knockdown`, `lawn_re_service`
- basic form: `bora_care`

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
`EXCLUDED_SERVICE_LINES`, and the test fails if either one appears as a line.

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
- `cockroach.cockroach_work_from_products`: **the cockroach "What we did"
  section has no product fallback.** `buildWork` in `cockroach-report-v2.js`
  reads only the `work_completed` chips. A visit that recorded products but
  no chips shows no work.
- `reservice_pest.fast_complete_customer_text`: **Fast Complete sends no
  customer text.** `FastCompleteSheet.jsx` `completionBody` sends no
  `customerRecap` and sets `sendCompletionSms: false`, so the fact has no
  writer.

## Data-quality and writer gaps

These are not registry facts, so the test doesn't check them:

- **Per-product area is missing on 100 of 240 pest product rows** (last 30
  days). `product_application_area` has readers, but the data is often empty.
- **The AI report writer never sees the photos themselves.** With
  `GATE_REPORT_PHOTO_CONTENT` on (#5145) it gets up to 5 tech-reviewed
  captions and a photo summary; with it off, only `photoCount`. An
  uncaptioned photo gives the writer nothing to ground on.
- The dark sections (pest "what to expect", cross-sell V2) must read only the
  facts above: method, area and targets per product for expectations, and
  typed findings fields for cross-sell, never free text.

## Typed form facts (generated)

<!-- BEGIN GENERATED: typed form facts (server/scripts/generate-visit-facts-doc.js) -->

Generated from the registry, which generates these facts from each form's
`findingsFields` (`project-types.js`) and `REQUIRED_FINDINGS_FIELDS`
(`activity-indicators.js`). Do not edit this block by hand: run
`node server/scripts/generate-visit-facts-doc.js`. Every fact not marked
internal also renders in the generic typed findings list.

### `tree_shrub` — typed `tree_shrub` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `areas_treated` | Areas treated | multi_select | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `plant_groups` | Plant groups serviced | multi_select | required | Today's Result tree & shrub story (buildTodaysResult) (activity-indicators.js) |
| `landscape_condition` | Overall landscape condition | select | required | Today's Result tree & shrub story (buildTodaysResult) (activity-indicators.js) |
| `observed_conditions` | Observed plant conditions | multi_select | hidden | — |
| `treatments_completed` | Treatment completed | multi_select | hidden | — |
| `palms_serviced` | Palms serviced | count | hidden | — |
| `palm_condition` | Palm condition | select | hidden | — |
| `palm_nutrient_stress` | Palm nutrient stress | select | hidden | — |
| `spear_leaf_condition` | Spear leaf condition | select | hidden | — |
| `canopy_density` | Canopy density | select | hidden | — |
| `palm_trunk_concern` | Trunk concern | select | hidden | — |
| `ganoderma_conk_observed` | Visible Ganoderma conk | select | hidden | — |
| `injection_recommended` | Injection recommended | select | hidden | — |
| `pest_pressure` | Pest pressure | select | hidden | — |
| `disease_pressure` | Disease pressure | select | hidden | — |
| `deficiency_symptoms` | Deficiency symptoms | select | hidden | — |
| `new_growth_present` | New growth present | select | hidden | — |
| `pruning_issue_observed` | Pruning issue observed | select | hidden | — |
| `irrigation_issue_observed` | Irrigation issue observed | select | hidden | — |
| `bed_weed_pressure` | Bed weeds present | select | hidden | — |
| `pre_emergent_applied` | Pre-emergent applied | select | hidden | — |
| `mulch_depth_concern` | Mulch depth concern | select | hidden | — |
| `weed_breakthrough_areas` | Weed breakthrough areas | text | hidden | — |
| `customer_recommendations` | Customer recommendations | multi_select | hidden | — |

### `cockroach` — typed `cockroach` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `species` | Species | select | required | Status + status summary; species label; How you can help (cockroach-report-v2.js) |
| `activity_level` | Activity level | select | required | "Activity today" metric + status (cockroach-report-v2.js) |
| `activity_locations` | Where activity was noted | chips | hidden | "Areas with activity" metric + status summary (cockroach-report-v2.js) |
| `evidence_observed` | Evidence observed | chips | hidden | Status reconciliation (resolveCockroachStatus) + status summary + evidence list (cockroach-report-v2.js) |
| `conducive_conditions` | Conducive conditions | chips | hidden | Conducive conditions list (dashboard conditions) (cockroach-report-v2.js) |
| `areas_treated` | Areas treated | chips | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `work_completed` | Work completed today | chips | hidden | "What we did" (buildWork) (cockroach-report-v2.js) |
| `customer_prep` | How the customer can help | chips | hidden | How you can help (buildHelp) (cockroach-report-v2.js) |

### `termite_bait` — typed `termite_bait_station` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `total_stations` | Total stations on property | count | hidden | Station summary + counts (reconciledSummary) (termite-report-v2.js) |
| `stations_checked` | Stations checked | count | required | Station summary + counts (reconciledSummary) (termite-report-v2.js) |
| `stations_inaccessible` | Stations inaccessible | count | hidden | Station summary + counts (reconciledSummary) (termite-report-v2.js) |
| `stations_with_activity` | Stations with termite activity | count | hidden | Activity summary + status resolution (termite-report-v2.js) |
| `termite_activity` | Termite activity | select | required | Status resolution (termite-report-v2.js); Cross-sell V2 findings signal (termite) (cross-sell.js) |
| `activity_signs` | Activity signs | chips | hidden | Status resolution (termite-report-v2.js) |
| `active_station_location` | Active station number / location | text | hidden | Status resolution (active location) (termite-report-v2.js) |
| `bait_consumption` | Bait consumption | select | required | Status resolution + "bait engaged" activity detail (termite-report-v2.js) |
| `bait_actions` | Bait service performed | chips | hidden | "Serviced today" claim (termite-report-v2.js) |
| `bait_issues` | Bait condition issues | chips | hidden | — |
| `station_issues` | Station condition issues | chips | hidden | — |
| `station_actions` | Station service performed | chips | hidden | "Serviced today" claim (termite-report-v2.js) |
| `conducive_conditions` | Conducive conditions | chips | hidden | Primary move (why) (termite-report-v2.js) |
| `customer_recommendations` | Customer recommendations | chips | hidden | Primary move (termite-report-v2.js) |

### `rodent_trapping` — typed `rodent_trapping` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `species` | Species | select | required | Species grounding for the narrative (rodent-report-narrative.js) |
| `evidence_observed` | Evidence observed | chips | hidden | — |
| `trap_visit_type` | This visit (internal) | select | required | Today's Result trap-setup wording (isInitialRodentTrapSetup) (activity-indicators.js); Narrative visitStage "initial_trap_setup" (rodent-report-narrative.js) |
| `traps_checked` | Traps checked | count | hidden | Trap counts (station summary) (report-data.js) |
| `captures` | Captures | count | hidden | Grounded capture sentence (rodent-report-narrative.js); Cross-sell V2 findings signal (rodent trapping) (cross-sell.js) |
| `trap_actions` | Trap actions | chips | hidden | — |
| `trap_activity_locations` | Locations with activity | text | hidden | — |
| `sanitation_recommendations` | Sanitation recommendations | chips | hidden | — |
| `exclusion_recommendation` | Exclusion | select | hidden | — |
| `entry_points_addressed` | Entry points sealed (combo) | chips | hidden | — |
| `exclusion_materials` | Materials used (combo) | chips | hidden | — |
| `remaining_concerns` | Remaining access concerns (combo) | chips | hidden | — |
| `exclusion_followup_needed` | Exclusion follow-up needed | select | hidden | — |
| `sanitation_areas` | Areas cleaned (combo) | chips | hidden | — |
| `contamination_level` | Contamination level (combo) | select | hidden | — |
| `evidence_cleaned` | Evidence removed (combo) | chips | hidden | — |
| `sanitation_limitations` | Sanitation limitations (combo) | chips | hidden | — |
| `additional_cleanup_needed` | Additional cleanup needed | select | hidden | — |

### `rodent_exclusion` — typed `rodent_exclusion` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `entry_points_addressed` | Entry points addressed | chips | required | — |
| `exclusion_work_completed` | Work completed | chips | required | Today's Result rodent exclusion story (buildTodaysResult) (activity-indicators.js) |
| `exclusion_materials` | Materials used | chips | required | — |
| `remaining_concerns` | Remaining concerns | chips | required | Today's Result rodent exclusion story (buildTodaysResult) (activity-indicators.js) |

### `rodent_bait_station` — typed `rodent_bait_station` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `stations_checked` | Stations checked | count | required | — |
| `stations_inaccessible` | Stations inaccessible | count | hidden | — |
| `station_actions` | Station service performed | chips | hidden | — |
| `bait_consumption` | Bait consumption level | select | required | Cross-sell V2 findings signal (rodent bait stations) (cross-sell.js) |
| `bait_replaced` | Bait replaced | select | hidden | — |
| `highest_activity_location` | Highest-activity station / location | text | hidden | — |
| `bait_issues` | Bait / station contents | chips | hidden | — |
| `evidence_observed` | Rodent evidence nearby | chips | hidden | — |
| `station_issues` | Station condition issues | chips | hidden | — |
| `conducive_conditions` | Attractants / harborage | chips | hidden | — |
| `sanitation_recommendations` | Customer recommendations | chips | hidden | — |

### `wildlife` — typed `wildlife_trapping` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `target_animal` | Suspected species | select | required | — |
| `evidence_observed` | Evidence observed | chips | hidden | — |
| `entry_points` | Entry / access points | chips | hidden | — |
| `traps_checked` | Traps checked | count | hidden | — |
| `captures` | Captures | count | hidden | — |
| `trap_actions` | Trap / device status | chips | hidden | — |
| `customer_recommendations` | Customer recommendations | chips | hidden | — |

### `flea` — typed `flea` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `evidence_level` | Evidence / activity level | select | required | Flea activity gauge + Today's Result flea story (buildTodaysResult) (activity-indicators.js) |
| `activity_areas` | Activity areas | chips | hidden | Today's Result flea story (buildTodaysResult) (activity-indicators.js) |
| `areas_treated` | Areas treated | chips | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `treatment_completed` | Treatment completed | chips | required | — |
| `contributing_conditions` | Contributing conditions | chips | hidden | — |
| `customer_prep` | Customer prep / aftercare | chips | required | — |

### `palm` — typed `palm_injection` form

| fact | label | type | when missing | also read by name in |
|---|---|---|---|---|
| `palm_species` | Palm species | text | hidden | — |
| `palms_serviced` | Palms serviced | count | hidden | — |
| `areas_treated` | Palms treated | chips | hidden | Areas treated (TYPED_AREA_FIELD_KEYS) (report-data.js) |
| `palm_condition` | Overall palm condition | select | required | — |
| `condition_observations` | Canopy & growth observations | chips | hidden | — |
| `deficiency_signs` | Nutrient observations | chips | hidden | — |
| `pest_disease_signs` | Pest & disease check | chips | hidden | — |
| `work_completed` | Work completed today | chips | hidden | — |
| `customer_recommendations` | Customer recommendations | chips | hidden | — |

<!-- END GENERATED: typed form facts -->
