/**
 * Visit facts contract — Step 1 of the owner's plan to sync the tech's
 * Complete Service form with the customer service report (owner rulings
 * 2026-09-28, see docs/design/DECISIONS.md "Visit facts contract").
 *
 * This is a REGISTRY, not a behavior change. It pins, per service line: which
 * facts a completed visit records, who/what captures each one (tech tap /
 * voice fill / protocol prefill / derived / photo), where it is stored,
 * which file(s) write it, which report section reads it (when a section
 * exists), and what the customer report shows when the fact is missing.
 * Later PRs (voice fill, the merged Recommendations list, the dark report
 * sections) write and read these SAME facts — this file is the thing they
 * must keep in sync with.
 *
 * Companion doc: docs/design/visit-facts-contract.md (per-line tables, "how
 * to add a fact", and the "Known gaps" list every `status: 'gap'` fact here
 * must be named in).
 *
 * Enforcement: server/tests/visit-facts-contract.test.js — static, no DB —
 * checks registry shape, that every writer/reader path exists on disk, that
 * a fact's storage key string (or the declared writerSymbol / readerSymbol)
 * actually appears in EVERY declared writer and reader file, for every
 * storage family (so a rename, a removal or a stale writer entry fails CI
 * instead of silently going stale), that registry gaps and the doc's Known
 * gaps list match in both directions, that every product measurement has its
 * unit fact, that each typed line carries exactly its form's fields with
 * REQUIRED_FINDINGS_FIELDS requiredness, that each TYPED_REPORT_BUILDERS
 * file reads exactly its registered keys (dot, optional-chaining, bracket
 * access and destructuring off `values`), that the doc's generated typed
 * tables are current, that no line lists a retired catalog key, that no
 * voice-fill line carries an undeclared tap-only fact, and that every key
 * complete-scheduled-service.js's structuredNotes object literal writes
 * (including one merged in through a `...(cond ? { key } : {})` spread) is
 * either a registered fact's storage key or named with a reason in
 * UNREGISTERED_INTERNAL_KEYS below.
 *
 * Sibling pattern: server/config/completion-lane-registry.js (routing
 * decisions — which catalog key completes through which form) +
 * server/tests/completion-lane-coverage-contract.test.js. This registry pins
 * FACTS, not lane routing, and does not replace that registry: `catalogKeys`
 * below is a cross-reference only.
 *
 * Scope note (owner ruling 2026-09-28): WDO inspection (`wdo_inspection`) and
 * termite slab pre-treat (`termite_slab_pretreat` / typed pointer
 * `pre_treatment_termite_certificate`) are OUT of scope — they stay on the
 * compliance Projects flow (FDACS-13645 / FBC certificate machinery), never
 * a customer Service Report. See EXCLUDED_SERVICE_LINES below.
 *
 * Typed lines are GENERATED, not hand-listed (typedFormFacts below): each
 * typed line's facts are its PROJECT_TYPES form's findingsFields
 * (project-types.js — key, label, field type), `whenMissing: 'required'`
 * exactly for the keys REQUIRED_FINDINGS_FIELDS (activity-indicators.js)
 * lists, and named report readers taken from the builders' own key lists
 * (cockroach-report-v2.js COCKROACH_V2_DASHBOARD_FIELD_KEYS, report-data.js
 * TYPED_AREA_FIELD_KEYS, the termite-report-v2.js `values.<key>` reads).
 * Hand-written entries remain only for untyped facts (basic form, products,
 * photos, assessments) and per-key section labels / notes. The field
 * options, tiers and copy templates stay owned by
 * docs/design/specialty-service-completion-contract.md.
 */

'use strict';

const { PROJECT_TYPES } = require('../services/project-types');
const {
  REQUIRED_FINDINGS_FIELDS,
  ACTIVITY_INDICATORS: ACTIVITY_INDICATOR_DEFS,
  requiredFindingsFieldsFor,
} = require('../services/service-report/activity-indicators');
const { COCKROACH_V2_DASHBOARD_FIELD_KEYS } = require('../services/service-report/cockroach-report-v2');

/**
 * @typedef {'tap'|'voice'|'prefill'|'derived'|'photo'} FactCapture
 * - tap: the technician types or selects the value on the Complete Service
 *   form (SchedulePage.jsx CompletionPanel) or Fast Complete sheet.
 * - voice: voice fill writes the value (owner ruling 2026-09-27: voice fill
 *   covers every completion except WDO + pre-treat; 2026-09-28: "Found" and
 *   "Treated" are read-only summary lines filled from voice). Voice fill is
 *   a follow-up PR — no fact is voice-written TODAY; 'voice' marks the fact
 *   voice fill must write into (the tap path stays behind "Show all fields").
 * - prefill: defaulted from the protocol / product label / service config;
 *   the tech confirms or adjusts rather than starting from blank.
 * - derived: computed by the server from other recorded facts or photos
 *   (never itself a form field).
 * - photo: an uploaded image (optionally captioned).
 *
 * @typedef {'hidden'|'fallback'|'filler'|'required'} WhenMissing
 * - hidden: the report section (or line) that would show this fact does not
 *   render when it is absent.
 * - fallback: the report substitutes a less specific source or a default.
 * - filler: the report renders fixed zero-state template copy.
 * - required: Complete Service refuses to submit without it.
 *
 * @typedef {Object} VisitFactWriter
 * @property {string} file - repo-relative path, verified to exist on disk.
 * @property {string} writerSymbol - identifier that appears in `file` when
 *   that writer submits the fact under a different name than the storage key
 *   (e.g. the client's camelCase `applicationMethod` for
 *   `service_products.application_method`, or a typed form that submits
 *   every findings field generically). A writer given as a plain path string
 *   must name the storage key itself.
 *
 * @typedef {Object} VisitFactReader
 * @property {string} file - repo-relative path, verified to exist on disk.
 * @property {string} section - the report section/behavior this reader
 *   produces from the fact (human label, not a file path).
 * @property {string} [readerSymbol] - identifier that appears in `file` when
 *   the reader consumes the fact generically (e.g. by iterating every typed
 *   field) instead of naming the storage key. The contract test accepts the
 *   storage key OR this symbol.
 *
 * @typedef {Object} VisitFact
 * @property {string} key - unique within its service line's `facts` array.
 * @property {string} label - human name (used in the doc tables).
 * @property {FactCapture[]} capture - every way the fact gets filled.
 * @property {string|null} storage - '<table>.<column>' or a dotted JSON path
 *   ('structured_notes.<key>', 'service_data.<snapshot>.values.<key>'); the
 *   LAST dotted segment is the key the contract test searches for. null only
 *   for a `status: 'gap'` fact that has no storage yet.
 * @property {Array<string|VisitFactWriter>} writers - every file that
 *   writes or submits the value (the server writer plus the client surface
 *   that submits it). EACH one is checked: a plain path must contain the
 *   storage key, a VisitFactWriter its writerSymbol.
 * @property {VisitFactReader[]} readers - empty array = no report section
 *   reads this fact yet (must pair with `status: 'gap'`).
 * @property {WhenMissing} whenMissing - requiredness in the fact's PRIMARY
 *   context (or its only context, for a `companion`-applicability fact).
 * @property {string} [companionStorage] - generated typed facts only, `both`
 *   applicability: the SECOND path complete-scheduled-service.js can freeze
 *   this same field into when the form runs as a COMPANION section instead
 *   of primary ('service_data.companionReportSnapshots[].values.<key>') —
 *   same last-segment key as `storage`, not a second fact. Absent for a
 *   `companion`-applicability fact (its single `storage` already IS this
 *   path) and for every hand-written fact.
 * @property {WhenMissing} [companionWhenMissing] - generated typed facts
 *   only, `both` applicability: requiredness when the SAME field is
 *   submitted as a companion, present ONLY when it differs from `whenMissing`
 *   (activity-indicators.js COMPANION_REQUIRED_FINDINGS_FIELDS names a field
 *   the companion validator requires beyond the base
 *   REQUIRED_FINDINGS_FIELDS).
 * @property {string} [notes]
 * @property {string} [qualifiedBy] - on a measurement fact, the key of the
 *   fact on the same line that holds its unit (a value without its unit is
 *   not interpretable).
 * @property {string} [typedForm] - generated typed facts only: the
 *   PROJECT_TYPES key the field comes from.
 * @property {string} [fieldType] - generated typed facts only: the
 *   findingsFields `type` (select / chips / count / …).
 * @property {'primary'|'companion'|'both'} [applicability] - generated typed
 *   facts only: 'companion' when the field is `companionOnly` in
 *   project-types.js (legal ONLY on a companion submission — a primary
 *   submission carrying it is rejected as unknown, activity-indicators.js
 *   `validateTypedFindings`); 'both' otherwise (every non-companionOnly field
 *   is legal on a primary OR a companion submission of the same form).
 * @property {'gap'} [status] - the fact is needed but no report section
 *   reads it (or nothing records it); MUST have `readers: []` and MUST be
 *   named in docs/design/visit-facts-contract.md's "Known gaps" section.
 * @property {boolean} [tapOnly] - true when a fact on a voice-fill line is
 *   deliberately tap-only (capture exactly ['tap']); requires `reason`.
 * @property {string} [reason] - required when `tapOnly` is true.
 *
 * @typedef {Object} ServiceLineFacts
 * @property {string} label
 * @property {string[]} catalogKeys - the ACTIVE `services.service_key`
 *   values completing through this line's form (cross-reference to
 *   completion-lane-registry.js and the typed cutover migrations, not a
 *   second routing source of truth). A retired key never appears here — see
 *   RETIRED_CATALOG_KEYS.
 * @property {boolean} voiceFill - voice fill applies to this line (owner
 *   ruling 2026-09-27: every in-scope line).
 * @property {string} [typedForm] - the PROJECT_TYPES form this line completes
 *   through; its typed facts are generated from that form (typedFormFacts).
 * @property {VisitFact[]} facts
 */

// ---------------------------------------------------------------------------
// Verified file paths (writers / readers). Centralized so a rename touches
// one line; the contract test independently re-verifies every one exists.
// ---------------------------------------------------------------------------

const COMPLETE_SERVICE = 'server/services/complete-scheduled-service.js';
const SCHEDULE_PAGE = 'client/src/pages/admin/SchedulePage.jsx'; // full Complete Service form (CompletionPanel)
const FAST_COMPLETE_SHEET = 'client/src/components/tech/FastCompleteSheet.jsx';
const SERVICE_PHOTOS = 'server/services/service-photos.js';
const TURF_HEIGHT_SERVICE = 'server/services/turf-height-service.js';
const LAWN_ASSESSMENT_ROUTE = 'server/routes/admin-lawn-assessment.js';
const TREE_SHRUB_ASSESSMENT = 'server/services/tree-shrub-assessment.js';
const PROJECT_TYPES_FILE = 'server/services/project-types.js';
const TIP_LIBRARY = 'server/services/service-report/tip-library.js';
const SERVICE_COMPLETION_CHOICES = 'client/src/lib/service-completion-choices.js';
const ADMIN_SCHEDULE_ROUTE = 'server/routes/admin-schedule.js'; // generate-report (the AI report writer)

const REPORT_DATA = 'server/services/service-report/report-data.js';
const REPORT_VIEW_PAGE = 'client/src/pages/ReportViewPage.jsx';
const PREMIUM_EXPERIENCE = 'server/services/service-report/premium-experience.js';
const ACTIVITY_INDICATORS = 'server/services/service-report/activity-indicators.js';
const RESERVICE_REPORT = 'server/services/service-report/reservice-report.js';
const LAWN_REPORT_V2 = 'server/services/service-report/lawn-report-v2.js';
const MOSQUITO_REPORT_V2 = 'server/services/service-report/mosquito-report-v2.js';
const TREE_SHRUB_REPORT_V2 = 'server/services/service-report/tree-shrub-report-v2.js';
const COCKROACH_REPORT_V2 = 'server/services/service-report/cockroach-report-v2.js';
const TERMITE_REPORT_V2 = 'server/services/service-report/termite-report-v2.js';
const RODENT_REPORT_NARRATIVE = 'server/services/service-report/rodent-report-narrative.js';
const KNOWLEDGE_BRIDGE = 'server/services/knowledge-bridge.js';
const REENTRY = 'server/services/service-report/reentry.js';
const ACTIVITY_SCORES_STORE = 'server/services/service-report/activity-scores-store.js';
const METRICS_BAND = 'server/services/service-report/metrics-band.js';
const TREE_SHRUB_CLOSEOUT = 'server/services/tree-shrub-closeout.js';
const ADMIN_DISPATCH = 'server/routes/admin-dispatch.js';
const INTERIOR_REENTRY_BACKFILL = 'server/scripts/backfill-interior-reentry-advisory.js';
const TRACE_ELIGIBILITY = 'server/services/service-report/trace-eligibility.js';
const VISIT_TIMELINE = 'server/services/service-report/visit-timeline.js';
const COMPANION_COMPLETIONS = 'server/services/service-report/companion-completions.js';

/** A writer that submits the fact under `writerSymbol` instead of the storage key. */
const via = (file, writerSymbol) => Object.freeze({ file, writerSymbol });

/** Every non-internal typed field renders here (generic typed findings list). */
const TYPED_FINDINGS_LIST = Object.freeze({
  file: ACTIVITY_INDICATORS,
  section: 'Typed findings list (every non-internal findingsFields key)',
  readerSymbol: 'buildTypedReportSnapshot',
});

// ---------------------------------------------------------------------------
// Shared fact builders — reused across lines so a shared wiring change
// (e.g. a new service_products column) is edited in one place.
// ---------------------------------------------------------------------------

/**
 * Per-product facts every product row carries (complete-scheduled-service.js
 * service_products insert ~7000-7022; report-data.js ~3784-3789 and
 * premium-experience.js read them back for every line). These are also the
 * facts the dark pest "what to expect" section needs: method + area +
 * targets per product.
 *
 * `opts.extraReaders` scopes a lawn- or tree-&-shrub-specific reader edge to
 * the ONE line that actually runs that builder — `productFacts()` is reused
 * by every service line (recurring pest, termite, rodent, …) and
 * lawn-report-v2.js / tree-shrub-report-v2.js never run for those lines, so a
 * universal reader edge would advertise a dependency that doesn't exist.
 * @param {{ extraReaders?: Record<string, VisitFactReader[]> }} [opts]
 * @returns {VisitFact[]}
 */
function productFacts(opts = {}) {
  const extra = opts.extraReaders || {};
  const withExtra = (key, base) => base.concat(extra[key] || []);
  return [
    {
      key: 'product_application_method',
      label: 'Product application method',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.application_method',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'applicationMethod'), via(FAST_COMPLETE_SHEET, 'applicationMethod')],
      readers: [
        { file: REPORT_DATA, section: 'What we did / products applied' },
        { file: PREMIUM_EXPERIENCE, section: 'Property defense status / primary move' },
      ],
      whenMissing: 'hidden',
      notes: 'Fast Complete derives each row\'s method from the visit-level method picker (rowMethod) unless the tech overrides it per row.',
    },
    {
      key: 'product_targets',
      label: 'Product targets (pests / turf issues the product was aimed at)',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.targets',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: withExtra('product_targets', [
        { file: REPORT_DATA, section: 'What we did / products applied' },
        { file: PREMIUM_EXPERIENCE, section: 'Bug files / pressure receipt' },
      ]),
      whenMissing: 'hidden',
      notes: 'On the full form targets are prefilled from the product label list — they describe the product mix, NOT pests found. Fast Complete writes the tech\'s picked pests into every row\'s targets.',
    },
    {
      key: 'product_application_area',
      label: 'Product application area (where it went)',
      capture: ['voice', 'tap'],
      storage: 'service_products.application_area',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'applicationArea'), via(FAST_COMPLETE_SHEET, 'applicationArea')],
      readers: [
        { file: REPORT_DATA, section: 'What we did / products applied' },
        { file: PREMIUM_EXPERIENCE, section: 'Property defense status (treated areas)' },
      ],
      whenMissing: 'hidden',
      notes: 'Prod, last 30 days: 100 of 240 pest product rows have no area (owner audit 2026-09-28) — see Known gaps (data quality).',
    },
    {
      key: 'product_area_value',
      label: 'Product measured area (value)',
      capture: ['voice', 'tap'],
      storage: 'service_products.area_value',
      qualifiedBy: 'product_area_unit',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'areaValue'), via(FAST_COMPLETE_SHEET, 'areaValue')],
      readers: withExtra('product_area_value', [
        { file: REPORT_DATA, section: 'What we did / products applied' },
      ]),
      whenMissing: 'hidden',
      notes: 'Required (blocks submit) for perimeter_spray (linear ft) and for methods whose report application needs square feet — see the linear_ft / sqft checks in complete-scheduled-service.js. Fast Complete sends it only for perimeter_spray.',
    },
    {
      key: 'product_area_unit',
      label: 'Product measured area unit (sq ft / linear ft …)',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.area_unit',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'areaUnit'), via(FAST_COMPLETE_SHEET, 'areaUnit')],
      readers: withExtra('product_area_unit', [
        { file: REPORT_DATA, section: 'What we did / products applied' },
      ]),
      whenMissing: 'hidden',
      notes: 'Validated with area_value on completion; lawn-report-v2.js and tree-shrub-report-v2.js show an area only when both are present. Fast Complete sends \'linear_ft\' with its perimeter_spray area.',
    },
    {
      key: 'product_total_amount',
      label: 'Product total amount applied',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.total_amount',
      qualifiedBy: 'product_amount_unit',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'totalAmount'), via(FAST_COMPLETE_SHEET, 'totalAmount')],
      readers: [{ file: REPORT_DATA, section: 'What we did / products applied' }],
      whenMissing: 'hidden',
      notes: 'Per-product standard amounts are deferred ("protocols later", owner 2026-09-28); voice fill must never guess an amount.',
    },
    {
      key: 'product_amount_unit',
      label: 'Product total amount unit (oz / fl oz / lb …)',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.amount_unit',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'amountUnit'), via(FAST_COMPLETE_SHEET, 'amountUnit')],
      readers: [{ file: REPORT_DATA, section: 'What we did / products applied' }],
      whenMissing: 'hidden',
      notes: 'The full form prefills it with the rate through resolveRatePrefill (client/src/lib/product-rate-prefill.js); the tech can change it.',
    },
    {
      key: 'product_application_rate',
      label: 'Product application rate',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.application_rate',
      qualifiedBy: 'product_rate_unit',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'rate:'), via(FAST_COMPLETE_SHEET, 'rate:')],
      readers: [{ file: REPORT_DATA, section: 'What we did / products applied (rate)' }],
      whenMissing: 'hidden',
      notes: 'The client submits it as `rate`; complete-scheduled-service.js stores it as application_rate. Fast Complete sends it only with a rate unit.',
    },
    {
      key: 'product_rate_unit',
      label: 'Product application rate unit',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.rate_unit',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'rateUnit'), via(FAST_COMPLETE_SHEET, 'rateUnit')],
      readers: [{ file: REPORT_DATA, section: 'What we did / products applied (rate)' }],
      whenMissing: 'hidden',
    },
    // Identity + regulatory fields, resolved server-side from the catalog
    // row the tech picked (completionCatalogRowsById) — the client submits
    // only the product's id, never these values, so there is no client
    // writer edge. report-data.js's public application card renders them
    // (product.name/epa_reg/active_ingredient/category ~L3755-3761).
    {
      key: 'product_name',
      label: 'Product name (identity)',
      capture: ['prefill'],
      storage: 'service_products.product_name',
      writers: [COMPLETE_SERVICE],
      readers: [{ file: REPORT_DATA, section: 'Product identity card (name)' }],
      whenMissing: 'hidden',
      notes: 'Resolved from the catalog row at completion (product.name); the client never types a product name.',
    },
    {
      key: 'product_category',
      label: 'Product category (herbicide / insecticide / …)',
      capture: ['prefill'],
      storage: 'service_products.product_category',
      writers: [COMPLETE_SERVICE],
      readers: [{ file: REPORT_DATA, section: 'Product identity card (category)' }],
      whenMissing: 'hidden',
    },
    {
      key: 'product_active_ingredient',
      label: 'Product active ingredient',
      capture: ['prefill'],
      storage: 'service_products.active_ingredient',
      writers: [COMPLETE_SERVICE],
      readers: [{ file: REPORT_DATA, section: 'Product identity card (active ingredient)' }],
      whenMissing: 'hidden',
    },
    {
      key: 'product_epa_reg_number',
      label: 'Product EPA registration number',
      capture: ['prefill'],
      storage: 'service_products.epa_reg_number',
      writers: [COMPLETE_SERVICE],
      readers: [{ file: REPORT_DATA, section: 'Product identity card (EPA registration)' }],
      whenMissing: 'hidden',
    },
  ];
}

/**
 * The structured facts the basic (untyped) Complete Service form records —
 * recurring pest, one-time pest, pest re-service, recurring lawn, mosquito,
 * termite-bait primary and palm. All land in service_records.structured_notes
 * (the object built ~5755 in complete-scheduled-service.js) except
 * technician_notes, a service_records column.
 * @param {{ extraReaders?: Record<string, VisitFactReader[]> }} [opts]
 * @returns {VisitFact[]}
 */
function genericCompletionFacts(opts = {}) {
  const extra = opts.extraReaders || {};
  const withExtra = (key, base) => base.concat(extra[key] || []);
  return [
    {
      key: 'areas_treated',
      label: 'Areas treated ("Treated" summary line)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.areasTreated',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('areas_treated', [{ file: REPORT_DATA, section: 'Areas treated / coverage' }]),
      whenMissing: 'fallback',
      notes: 'Falls back to the request\'s areasServiced when areasTreated is absent (completionAreas in complete-scheduled-service.js) — Fast Complete sends only areasServiced.',
    },
    {
      key: 'observations',
      label: 'Observations (tech picks + protocol defaults, merged)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.observations',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('observations', [{ file: REPORT_DATA, section: 'Findings / what we found' }]),
      whenMissing: 'hidden',
      notes: 'Prod, last 30 days: 0/69 recurring pest visits recorded an observation (owner audit 2026-09-28). The recurring-pest vocabulary (shared/service-completion-observations.json) is species-neutral.',
    },
    {
      key: 'form_observations',
      label: 'Observations — form provenance only (no protocol defaults)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.formObservations',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'structuredObservations')],
      readers: withExtra('form_observations', [{ file: REPORT_DATA, section: 'Findings (form-sourced, structuredObservations)' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'finding_rows',
      label: 'Finding rows (one per submitted observation)',
      capture: ['derived'],
      storage: 'service_findings.title',
      writers: [COMPLETE_SERVICE],
      readers: withExtra('finding_rows', [{ file: REPORT_DATA, section: 'Findings list' }]),
      whenMissing: 'hidden',
      notes: 'Written from the submitted observations on untyped Service Report V1 completions (skipped for internal-only consultations).',
    },
    {
      key: 'recommendations',
      label: 'Recommendations (tech picks + protocol defaults, merged)',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.recommendations',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, SERVICE_COMPLETION_CHOICES],
      readers: withExtra('recommendations', [{ file: REPORT_DATA, section: 'Recommendations' }]),
      whenMissing: 'hidden',
      notes: 'Prod, last 30 days: 2/69 recurring pest visits recorded one. Owner ruling 2026-09-28: this vocabulary (service-completion-choices.js, GATE_SERVICE_REPORT_COMPLETION_CHOICES) and tip-library.js merge into ONE searchable prefilled Recommendations list.',
    },
    {
      key: 'form_recommendations',
      label: 'Recommendations — form provenance only',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.formRecommendations',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('form_recommendations', [{ file: REPORT_DATA, section: 'Recommendations (form-sourced, structuredRecommendations)' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'tech_tips',
      label: 'Tips from your tech (up to 3 from the owner-approved library)',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.techTips',
      writers: [COMPLETE_SERVICE, TIP_LIBRARY, SCHEDULE_PAGE],
      readers: withExtra('tech_tips', [
        { file: REPORT_DATA, section: 'Tips from your tech (payload.techNote, GATE_TECH_TIPS)' },
        { file: REPORT_VIEW_PAGE, section: 'Tips from your tech note', readerSymbol: 'techNote' },
      ]),
      whenMissing: 'hidden',
      notes: 'The tech picks tip ids; the server resolves and freezes the copy (freezeTechTips). Merges into the Recommendations list per the 2026-09-28 ruling.',
    },
    {
      key: 'protocol_actions_completed',
      label: 'Protocol actions completed',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.protocolActionsCompleted',
      writers: [COMPLETE_SERVICE],
      readers: withExtra('protocol_actions_completed', [{ file: REPORT_DATA, section: 'What we did (protocol action list)' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'protocol_action_scopes_completed',
      label: 'Protocol action scopes completed (interior/exterior/treatment metadata per action)',
      capture: ['derived'],
      storage: 'structured_notes.protocolActionScopesCompleted',
      // The interior re-entry backfill (--apply) also rebuilds this array on
      // historical records it repairs.
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, INTERIOR_REENTRY_BACKFILL],
      readers: withExtra('protocol_action_scopes_completed', [
        { file: REPORT_DATA, section: 'Treatment scope (interior/exterior) + re-entry countdown retained/zeroed decision (structuredActionScope / treatmentScope / normalizeAdvisoryForTreatmentScope)' },
        { file: TRACE_ELIGIBILITY, section: 'Satellite trace / photo-mark eligibility: exterior-treatment evidence for a conditionally eligible visit' },
      ]),
      whenMissing: 'fallback',
      notes: 'Derived companion to protocol_actions_completed: each entry pairs a completed action\'s label with its scope (interior/exterior)/treatmentApplied/dryDown metadata (from the protocol definition, mirrored client-side). Never itself a rendered report line — report-data.js\'s structuredActionScope/treatmentScope is the authoritative signal that decides whether interior/exterior treatment occurred and whether the re-entry countdown is retained or zeroed. Falls back to area-text and product-based scope classification when absent.',
    },
    {
      key: 'technician_notes',
      label: 'Technician notes box (INTERNAL column; holds the AI report draft after Generate)',
      capture: ['voice', 'tap', 'derived'],
      storage: 'service_records.technician_notes',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'technicianNotes'), via(FAST_COMPLETE_SHEET, 'technicianNotes')],
      readers: withExtra('technician_notes', [
        {
          file: ADMIN_SCHEDULE_ROUTE,
          section: 'AI report writer prompt "Service Notes" (the notes box before Generate, chip tag lines stripped, redactAccessCodes)',
          readerSymbol: 'promptNotes',
        },
        {
          file: REPORT_DATA,
          section: 'Visit summary / Today\'s Result body — ONLY the screened WHAT WE DID / WHAT WE FOUND parse; the raw column never egresses',
          readerSymbol: 'technicianReportCustomerCopy',
        },
      ]),
      whenMissing: 'fallback',
      notes: 'The raw column is INTERNAL (it can hold access or billing notes; AGENTS.md: raw technician_notes never egress on any report path) and is never a customer-facing fact. Customer exposure is only via the AI writer, with redaction: generate-report reads the tech\'s notes box through redactAccessCodes, its two-section draft is written back into the box, and the report shows only technicianReportCustomerCopy\'s re-screened parse of that draft (any extra line, banned copy or access code rejects it and the report falls back to its deterministic summary). Tagged [found]/[next] lines feed the internal merged protocol lists, which the report document never renders. Parked [Next] lines travel as internalRecommendations, not in the writer\'s Service Notes, and the planned voice-fill OFFICE note is a different field that must never reach the report writer (owner ruling 2026-09-28).',
    },
    {
      key: 'customer_concern_text',
      label: 'Customer\'s stated concern',
      capture: ['tap'],
      tapOnly: true,
      reason: 'The customer\'s own words about why they called; customer texts and calls shape voice-fill questions but never fill findings (owner 2026-09-27).',
      storage: 'structured_notes.customerConcernText',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('customer_concern_text', [{ file: REPORT_DATA, section: 'Customer concern grounding' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'customer_recap',
      label: 'Customer recap (server-generated from the facts)',
      capture: ['derived'],
      storage: 'structured_notes.customerRecap',
      // The full form deliberately does NOT post customerRecap (SchedulePage.jsx
      // "customerRecap is intentionally NOT sent"); its client state is
      // draft/preview only, so the server is the sole writer until a client
      // posts a tech-edited recap again (Codex #5190 r6).
      writers: [COMPLETE_SERVICE],
      readers: withExtra('customer_recap', [{ file: REPORT_DATA, section: 'Visit summary paragraph' }]),
      whenMissing: 'fallback',
      notes: 'Server-generated at completion; no client posts it today. report-data.js falls back to a generated visitSummary when customerRecap is empty.',
    },
    {
      key: 'visit_time_on_site',
      label: 'Visit time on site (minutes, "Time on site")',
      capture: ['derived', 'tap'],
      storage: 'structured_notes.timeOnSite',
      // PATCH /api/admin/dispatch/:serviceId/time-on-site rewrites it on a
      // completed visit; the report reads the corrected value.
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, ADMIN_DISPATCH],
      readers: withExtra('visit_time_on_site', [
        { file: METRICS_BAND, section: 'computeOnSiteMin (customer-visible on-site duration, primary source)' },
        { file: REPORT_DATA, section: 'visitTiming.onSiteMinutes' },
        { file: REPORT_VIEW_PAGE, section: '"Time on site" line (non-WaveGuard reports with duration display enabled)', readerSymbol: 'onSiteMinutes' },
        { file: VISIT_TIMELINE, section: 'Visit timeline: whether a backfilled "Service completed" event shows an exact time or stays day-only' },
      ]),
      whenMissing: 'fallback',
      notes: 'Customer-visible on a non-WaveGuard report when the admin "Show duration when reliable" setting is on (ReportViewPage.jsx suppresses it entirely for WaveGuard members). SchedulePage.jsx sends the running-timer/admin-typed minutes; complete-scheduled-service.js otherwise sets it from the packet duration allocation. computeOnSiteMin (metrics-band.js) prefers this value, then visit_duration_allocation, then the raw started_at/ended_at span.',
    },
    {
      key: 'visit_duration_allocation',
      label: 'Visit duration allocation (packet-derived minutes, fallback source for time on site)',
      capture: ['derived'],
      storage: 'structured_notes.visitDurationAllocation',
      writers: [COMPLETE_SERVICE],
      readers: withExtra('visit_duration_allocation', [
        { file: METRICS_BAND, section: 'computeOnSiteMin (fallback source when visit_time_on_site is absent)' },
        { file: REPORT_DATA, section: 'visitTiming.onSiteMinutes (fallback source)' },
        { file: REPORT_VIEW_PAGE, section: '"Time on site" line, when this fallback supplied the minutes', readerSymbol: 'onSiteMinutes' },
      ]),
      whenMissing: 'fallback',
      notes: 'Server-computed multi-visit-packet duration allocation ({ version: 1, allocatedMinutes, ... }); feeds the SAME customer-visible "Time on site" line as visit_time_on_site (never rendered on its own) only when that fact is absent.',
    },
    {
      key: 'customer_interaction',
      label: 'Customer interaction (met / not home / discussed …)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.customerInteraction',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('customer_interaction', [{ file: REPORT_DATA, section: 'Customer interaction line' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'visit_outcome',
      label: 'Visit outcome (completed / inspection_only / customer_declined …)',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.visitOutcome',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: withExtra('visit_outcome', [{ file: REPORT_DATA, section: 'No-application copy branch' }]),
      whenMissing: 'fallback',
      notes: 'Defaults to \'completed\' when the form sends nothing.',
    },
    {
      key: 'reentry_exterior_minutes',
      label: 'Re-entry timing — exterior (technician-confirmed dry-down minutes)',
      capture: ['prefill', 'tap'],
      storage: 'service_records.advisory.exterior_reentry_min',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'reentryExteriorMinutes')],
      readers: withExtra('reentry_exterior_minutes', [
        { file: REENTRY, section: 'Re-entry ready-time summary (exterior dry-down), read by the report and delivery paths' },
      ]),
      whenMissing: 'fallback',
      notes: 'Prefilled from the product label REI / service-line default (productReentryFloor, getAdvisoryDefaults); the tech\'s stepper only raises or lowers it, and a lowering override is dropped when the applied product\'s REI is unverifiable (the computed default stands unmarked). Absent a tech adjustment, the computed default is what persists here — never a missing value.',
    },
    {
      key: 'reentry_interior_minutes',
      label: 'Re-entry timing — interior (technician-confirmed dry-down minutes)',
      capture: ['prefill', 'tap'],
      storage: 'service_records.advisory.interior_reentry_min',
      writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'reentryInteriorMinutes')],
      readers: withExtra('reentry_interior_minutes', [
        { file: REENTRY, section: 'Re-entry ready-time summary (interior dry-down), read by the report and delivery paths' },
      ]),
      whenMissing: 'fallback',
      notes: 'Prefilled from the service-line default (getAdvisoryDefaults) and normalized by treatment scope (buildCompletionAdvisory); the tech\'s stepper overrides it directly.',
    },
  ];
}

/**
 * Basic-form facts a TYPED completion also writes and the report reads,
 * regardless of findings type. The Complete Service form (SchedulePage.jsx
 * CompletionPanel) is the SAME form either way — a typed submission layers
 * `structuredFindings` on top of it, never replaces it — and
 * complete-scheduled-service.js freezes these into structured_notes
 * unconditionally (~5755-5801, ~5854-5874): customerRecap, customerInteraction,
 * protocolActionsCompleted, protocolActionScopesCompleted, customerConcernText,
 * timeOnSite, visitDurationAllocation, recommendations, formRecommendations,
 * techTips and technician_notes. report-data.js reads them the same way for a
 * typed report: buildProtocolPayload (~1791-1848, actions/recommendations/techTips)
 * and the visit-summary resolution (~5411-5416, customerRecap falling back to the
 * screened technicianReportCustomerCopy parse of technician_notes);
 * report-data.js's provenance-guaranteed formRecommendations read (~1824-1832)
 * is the copy the customer report's "What we recommend" section actually uses
 * (`recommendations` can carry raw `[Next]` technician-note lines, which never
 * egress — codex P2, round 5). structuredCustomerConcern (customerConcernText)
 * feeds the pest/lawn/tree-&-shrub V2 builders' "what you flagged" card the
 * same way on a typed completion (codex follow-up on #5190). The re-entry
 * timing pair (reentry_exterior_minutes / reentry_interior_minutes) is frozen
 * onto `service_records.advisory` the same unconditional way (~6396-6589) — a
 * typed closeout runs the SAME re-entry block as a basic one, and the SAME
 * on-site duration facts (timeOnSite / visitDurationAllocation) feed the
 * customer-visible "Time on site" line (metrics-band.js computeOnSiteMin)
 * regardless of typed vs. untyped. Sourced from genericCompletionFacts so a
 * shared wiring change is never hand-copied onto a typed line.
 * @returns {VisitFact[]}
 */
const TYPED_SHARED_FACT_KEYS = Object.freeze([
  'customer_recap',
  'customer_interaction',
  'protocol_actions_completed',
  'protocol_action_scopes_completed',
  'recommendations',
  'form_recommendations',
  'tech_tips',
  'technician_notes',
  'visit_outcome',
  'reentry_exterior_minutes',
  'reentry_interior_minutes',
  'customer_concern_text',
  'visit_time_on_site',
  'visit_duration_allocation',
]);

function typedSharedCompletionFacts() {
  return genericCompletionFacts().filter((fact) => TYPED_SHARED_FACT_KEYS.includes(fact.key));
}

/**
 * The pest activity rating (the one activity gauge on untyped pest lines).
 * @returns {VisitFact}
 */
function pestActivityRatingFact() {
  return {
    key: 'pest_activity_rating',
    label: 'Pest activity seen (rating)',
    capture: ['prefill', 'voice', 'tap'],
    storage: 'service_records.client_pest_rating',
    writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'clientPestRating'), via(FAST_COMPLETE_SHEET, 'clientPestRating')],
    readers: [{ file: REPORT_DATA, section: 'Activity rating / pest pressure' }],
    whenMissing: 'hidden',
    notes: 'First visits prefill 5 unless the tech clears the picker (clientPestRatingPrefilled / clientPestRatingCleared).',
  };
}

/**
 * Completion photos, as TWO facts: the photo itself (a service_photos row
 * with its s3_key, or the legacy s3_url on ancient rows) and its optional
 * caption. An uncaptioned photo is still a photo: report-data.js photoUrl()
 * resolves and renders it from the key alone, and the tree & shrub closeout
 * gate counts successful uploads, never captions.
 * @param {{ whenMissing?: WhenMissing, notes?: string }} [opts] - apply to
 *   the photo fact (the caption is always optional).
 * @returns {VisitFact[]}
 */
function photoFacts(opts = {}) {
  return [
    {
      key: 'completion_photos',
      label: 'Completion photos (the uploaded image row)',
      capture: ['photo'],
      storage: 'service_photos.s3_key',
      writers: [SERVICE_PHOTOS, COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'completionPhotos')],
      readers: [
        { file: REPORT_DATA, section: 'Photos gallery (photoUrl presigns s3_key; legacy s3_url fallback)' },
        { file: REPORT_VIEW_PAGE, section: 'Photos section', readerSymbol: 'data.photos' },
      ],
      whenMissing: opts.whenMissing || 'hidden',
      notes: opts.notes || 'Prod, last 30 days: photos on 2/100 visits (owner audit 2026-09-28). Fast Complete sends no photos.',
    },
    {
      key: 'completion_photo_caption',
      label: 'Completion photo caption (optional, per photo)',
      capture: ['derived', 'tap'],
      storage: 'service_photos.caption',
      writers: [SERVICE_PHOTOS, COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: [
        { file: REPORT_DATA, section: 'Photos gallery (caption, else state badge, under each photo)' },
        { file: REPORT_VIEW_PAGE, section: 'Photos section caption line' },
        {
          file: ADMIN_SCHEDULE_ROUTE,
          section: 'AI report writer grounding "TECHNICIAN PHOTO OBSERVATIONS" (GATE_REPORT_PHOTO_CONTENT; at most 5 captions, redactAccessCodes, 200 chars each)',
          readerSymbol: 'photoCaptions',
        },
      ],
      whenMissing: 'fallback',
      notes: 'Nullable. The form can suggest an AI caption (captionSource \'ai\') the tech keeps or edits; banned customer copy is refused at upload. With no caption the gallery shows the photo\'s state badge or a generic line, and the AI writer gets no photo text (only the photo count while GATE_REPORT_PHOTO_CONTENT is off). The writer reads the captions on the form\'s current photo list — the same text that is stored in this column.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Typed facts — GENERATED from the code that defines the typed forms.
// ---------------------------------------------------------------------------

/**
 * report-data.js TYPED_AREA_FIELD_KEYS (not importable here: report-data.js
 * loads the DB). The contract test parses that literal and fails when this
 * copy differs.
 */
const REPORT_DATA_TYPED_AREA_FIELD_KEYS = Object.freeze(['areas_treated', 'spot_treatment_areas', 'treatment_zones']);

/**
 * Type-specific report builders that read typed values by key
 * (`values.<key>`). The contract test scans each file's `values.<key>` reads
 * and requires them to equal `keys` exactly, and every key to be a field of
 * `typedForm` — so a builder that starts reading a new field (or stops
 * reading one) fails CI until this table and the generated facts follow.
 * `sections` labels the report section per key; a key without a label falls
 * back to `defaultSection`.
 */
const TYPED_REPORT_BUILDERS = Object.freeze({
  cockroach: Object.freeze({
    typedForm: 'cockroach',
    file: COCKROACH_REPORT_V2,
    // The builder's own exported list (the typed tiles skip these keys),
    // minus the retired key below, which the form no longer defines.
    keys: Object.freeze([...COCKROACH_V2_DASHBOARD_FIELD_KEYS].filter((key) => key !== 'work_completed')),
    // Keys the builder still reads off STORED snapshots although the form no
    // longer defines them (retired fields). `work_completed` chips were
    // retired from the cockroach form 2026-09-26; every record completed
    // before then keeps them in its frozen snapshot and the "What we did"
    // section renders them (chips win over the product-derived work). The
    // contract test requires the builder's reads to equal keys + retiredKeys.
    retiredKeys: Object.freeze(['work_completed']),
    defaultSection: 'Cockroach report dashboard',
    sections: Object.freeze({
      species: 'Status + status summary; species label; How you can help',
      activity_level: '"Activity today" metric + status',
      activity_locations: '"Areas with activity" metric + status summary',
      evidence_observed: 'Status reconciliation (resolveCockroachStatus) + status summary + evidence list',
      conducive_conditions: 'Conducive conditions list (dashboard conditions)',
      customer_prep: 'How you can help (buildHelp)',
    }),
  }),
  termite_bait_station: Object.freeze({
    typedForm: 'termite_bait_station',
    file: TERMITE_REPORT_V2,
    // termite-report-v2.js has no exported key list; `keys` is exactly its
    // `values.<key>` reads, which the contract test re-derives from source.
    keys: Object.freeze([
      'stations_checked', 'total_stations', 'stations_inaccessible', 'stations_with_activity',
      'termite_activity', 'activity_signs', 'bait_consumption', 'active_station_location',
      'bait_actions', 'station_actions', 'conducive_conditions', 'customer_recommendations',
    ]),
    defaultSection: 'Termite bait report',
    sections: Object.freeze({
      stations_checked: 'Station summary + counts (reconciledSummary)',
      total_stations: 'Station summary + counts (reconciledSummary)',
      stations_inaccessible: 'Station summary + counts (reconciledSummary)',
      stations_with_activity: 'Activity summary + status resolution',
      termite_activity: 'Status resolution',
      activity_signs: 'Status resolution',
      bait_consumption: 'Status resolution + "bait engaged" activity detail',
      active_station_location: 'Status resolution (active location)',
      bait_actions: '"Serviced today" claim',
      station_actions: '"Serviced today" claim',
      conducive_conditions: 'Primary move (why)',
      customer_recommendations: 'Primary move',
    }),
  }),
});

/**
 * The completion validator's own required list for a typed form
 * (activity-indicators.js REQUIRED_FINDINGS_FIELDS).
 * @param {string} typedForm
 * @returns {Set<string>}
 */
function requiredTypedKeys(typedForm) {
  return new Set(REQUIRED_FINDINGS_FIELDS[typedForm] || []);
}

/**
 * The findingsFields of a typed form that are visit facts: every
 * non-internal field (the report shows it), plus an internal field the
 * completion validator unconditionally requires (voice fill must still write
 * it), plus an internal `pesticideOnly` field — CONDITIONALLY required
 * whenever the visit's products include an insecticide/other pesticide
 * (validateTreeShrubTypedCompliance in tree-shrub-closeout.js, mirrored
 * pre-submit by the client's own `f.pesticideOnly` gate), which
 * REQUIRED_FINDINGS_FIELDS has no way to express since it names only
 * unconditionally-required keys (codex follow-up on #5190: pollinator_status
 * / irac_frac_logged were silently dropped here, losing their real
 * writer/reader edges entirely). Internal, optional, non-pesticideOnly
 * fields are office-only data, not report facts.
 * @param {string} typedForm
 * @returns {Array<Object>} PROJECT_TYPES findingsFields entries
 */
function typedFactFields(typedForm) {
  const cfg = PROJECT_TYPES[typedForm];
  if (!cfg || !Array.isArray(cfg.findingsFields)) {
    throw new Error(`visit-facts-contract: unknown typed form ${typedForm}`);
  }
  const required = requiredTypedKeys(typedForm);
  return cfg.findingsFields.filter((field) => !field.internal || required.has(field.key) || field.pesticideOnly);
}

/**
 * Every typed fact of one form, generated from project-types.js. One fact per
 * typedFactFields entry: its key, label and field type come from the field;
 * `whenMissing` is 'required' exactly when REQUIRED_FINDINGS_FIELDS lists it;
 * readers are the generic typed findings list (non-internal fields), the
 * report-data.js areas reader for TYPED_AREA_FIELD_KEYS, the form's
 * TYPED_REPORT_BUILDERS entry, and any per-key `readers` override.
 *
 * Each value is frozen into service_data.typedReportSnapshot
 * (complete-scheduled-service.js). Residual pre-retirement combined visits
 * (20260831000070) carry the same keys under
 * service_data.companionReportSnapshots[], which report-data.js and
 * termite-report-v2.js keep reading for those frozen reports.
 *
 * Writers: project-types.js declares the key; the form and the server
 * submit/freeze every findings field generically, so they are pinned by
 * their generic symbols.
 * @param {string} typedForm - a PROJECT_TYPES key
 * @param {{ readers?: Record<string, VisitFactReader[]>, notes?: Record<string, string> }} [overrides]
 * @returns {VisitFact[]}
 */
function typedFormFacts(typedForm, overrides = {}) {
  const required = requiredTypedKeys(typedForm);
  // The full companion-context required set (base REQUIRED_FINDINGS_FIELDS
  // plus this form's COMPANION_REQUIRED_FINDINGS_FIELDS extras, e.g.
  // tree_shrub's treatments_completed — activity-indicators.js
  // requiredFindingsFieldsFor(typedForm, { companion: true })). A `both`
  // field's companion-context requiredness can differ from its primary one;
  // a `companionOnly` field has NO primary context at all, so this set alone
  // decides its (single) whenMissing.
  const requiredCompanion = new Set(requiredFindingsFieldsFor(typedForm, { companion: true }));
  const extraReaders = overrides.readers || {};
  const extraNotes = overrides.notes || {};
  const builder = Object.values(TYPED_REPORT_BUILDERS).find((b) => b.typedForm === typedForm) || null;
  for (const key of [...Object.keys(extraReaders), ...Object.keys(extraNotes)]) {
    if (!PROJECT_TYPES[typedForm].findingsFields.some((f) => f.key === key)) {
      throw new Error(`visit-facts-contract: override for ${typedForm}.${key}, which project-types.js does not define`);
    }
  }
  return typedFactFields(typedForm).map((field) => {
    const readers = typedFieldReaders(field, builder, extraReaders);
    const notes = typedFieldNotes(field, extraNotes, required);
    const placement = typedFieldPlacement(field, required, requiredCompanion);
    return {
      key: field.key,
      label: field.label,
      typedForm,
      fieldType: field.type,
      // companionOnly fields are legal ONLY on a companion submission
      // (activity-indicators.js validateTypedFindings rejects one on a
      // primary submission as unknown); every other field is legal on
      // either, since a companion submission accepts the whole form
      // (fields.filter((f) => companion || !f.companionOnly)).
      applicability: field.companionOnly ? 'companion' : 'both',
      capture: ['voice', 'tap'],
      readers,
      ...placement,
      ...(notes.length ? { notes: notes.join(' ') } : {}),
    };
  });
}

/** When tree-shrub-closeout.js requires each pesticideOnly field. The
 * client's pre-submit gate is broader: it requires every pesticideOnly field
 * once any pesticide product is recorded. */
const PESTICIDE_COMPLIANCE_CONDITIONS = Object.freeze({
  pollinator_status: 'required when an insect-family product (insecticide, miticide, IGR) is recorded (hasInsectProduct)',
  irac_frac_logged: 'required when any insecticide, fungicide or herbicide, or a product with an IRAC/FRAC/HRAC group, is recorded (needsIracFracLog)',
});

/** Every reader edge for one typed field: the generic findings list, the
 * areas-treated reader, its TYPED_REPORT_BUILDERS entry (if any), the
 * pesticide compliance gate (pesticideOnly fields only — internal, so
 * TYPED_FINDINGS_LIST is skipped above; these are the fields' ONLY real
 * readers) and any per-key override. Split out of typedFormFacts() to keep
 * that function's complexity down. */
function typedFieldReaders(field, builder, extraReaders) {
  const readers = [];
  if (!field.internal) readers.push(TYPED_FINDINGS_LIST);
  if (REPORT_DATA_TYPED_AREA_FIELD_KEYS.includes(field.key)) {
    readers.push({ file: REPORT_DATA, section: 'Areas treated (TYPED_AREA_FIELD_KEYS)' });
  }
  if (builder && builder.keys.includes(field.key)) {
    readers.push({ file: builder.file, section: builder.sections[field.key] || builder.defaultSection });
  }
  if (field.pesticideOnly) {
    readers.push({
      file: TREE_SHRUB_CLOSEOUT,
      section: `Pesticide compliance gate (validateTreeShrubTypedCompliance) — ${PESTICIDE_COMPLIANCE_CONDITIONS[field.key] || 'conditionally required'}`,
    });
    readers.push({
      file: SCHEDULE_PAGE,
      section: 'Client pre-submit pesticide gate — shows and requires every pesticideOnly field once any pesticide product is recorded (broader than the server condition)',
      readerSymbol: 'pesticideOnly',
    });
  }
  readers.push(...(extraReaders[field.key] || []));
  return readers;
}

/** Every note for one typed field (internal / conditionally-required
 * pesticideOnly / companionOnly / requiredUnless / per-key override). Split
 * out of typedFormFacts() to keep that function's complexity down.
 * @param {Set<string>} required - this form's REQUIRED_FINDINGS_FIELDS set,
 *   distinguishing an unconditionally-required internal field from a
 *   conditionally-required (pesticideOnly) one for the note text. */
function typedFieldNotes(field, extraNotes, required) {
  const notes = [];
  if (field.internal) {
    if (required.has(field.key)) {
      notes.push('Internal field (never shown on the report); registered because REQUIRED_FINDINGS_FIELDS requires it.');
    } else if (field.pesticideOnly) {
      notes.push(`Internal field (never shown on the report); CONDITIONALLY required: the server ${PESTICIDE_COMPLIANCE_CONDITIONS[field.key] || 'requires it for pesticide applications'} (validateTreeShrubTypedCompliance), while the client pre-submit gate requires it once any pesticide product is recorded. Not in REQUIRED_FINDINGS_FIELDS (which names only unconditional requirements), so whenMissing below reflects only the unconditional (never-required) case.`);
    }
  }
  if (field.companionOnly) notes.push('companionOnly: this value is only ever recorded when the form runs as a COMPANION section (service_data.companionReportSnapshots[]) beside a different primary type; a primary submission of this form carrying it is rejected as an unknown field.');
  if (field.requiredUnless) {
    notes.push(`Required unless ${field.requiredUnless.field} = '${field.requiredUnless.value}' (project-types.js requiredUnless); not in REQUIRED_FINDINGS_FIELDS.`);
  }
  if (extraNotes[field.key]) notes.push(extraNotes[field.key]);
  return notes;
}

/**
 * storage / companionStorage / writers / whenMissing / companionWhenMissing
 * for one typed field. Split out of typedFormFacts() to keep that function's
 * complexity down.
 *
 * companionOnly fields are NEVER recorded on a primary submission
 * (activity-indicators.js validateTypedFindings rejects one as unknown) —
 * complete-scheduled-service.js freezes them ONLY into
 * service_data.companionReportSnapshots[] (~L6271-6306, buildTypedReportSnapshot
 * called per companion, companion.values sourced from the client's
 * companionFindings array), never into the primary typedReportSnapshot. A
 * storage-driven consumer that looked in typedReportSnapshot for one of these
 * would look in a path where the fact can never exist.
 *
 * A `both` field is the opposite case: complete-scheduled-service.js writes
 * it into typedReportSnapshot.values when the form runs primary AND into
 * companionReportSnapshots[].values when the SAME form runs as a companion
 * (residual pre-retirement combined visits, 20260831000070, still freeze it
 * this way too) — codex P2 round 5: advertising only the primary path here
 * means a storage-driven consumer misses the field whenever the visit is a
 * companion. Both paths and both writer pairs are recorded; `companionStorage`
 * is the second path (same key, per storageKey()'s last-segment rule), not a
 * second independent fact.
 *
 * Requiredness can differ by context the same way: activity-indicators.js
 * COMPANION_REQUIRED_FINDINGS_FIELDS adds fields the companion validator
 * requires beyond the base REQUIRED_FINDINGS_FIELDS (codex P2 round 5 — e.g.
 * tree_shrub's treatments_completed, hidden on a primary submission but
 * rejected as missing on a companion one). A companionOnly field has only the
 * companion context, so `requiredCompanion` alone decides its (single)
 * whenMissing; a `both` field gets a separate `companionWhenMissing` ONLY
 * when it actually differs from the primary value, so the common case (same
 * requiredness either way) stays a single field.
 */
function typedFieldPlacement(field, required, requiredCompanion) {
  const isCompanionOnly = field.companionOnly;
  const companionPath = `service_data.companionReportSnapshots[].values.${field.key}`;
  const storage = isCompanionOnly ? companionPath : `service_data.typedReportSnapshot.values.${field.key}`;
  const writers = isCompanionOnly
    ? [PROJECT_TYPES_FILE, via(COMPLETE_SERVICE, 'companionReportSnapshots'), via(SCHEDULE_PAGE, 'companionFindings')]
    : [
      PROJECT_TYPES_FILE,
      via(COMPLETE_SERVICE, 'typedReportSnapshot'),
      via(SCHEDULE_PAGE, 'typedFindings'),
      via(COMPLETE_SERVICE, 'companionReportSnapshots'),
      via(SCHEDULE_PAGE, 'companionFindings'),
    ];
  const primaryRequired = !isCompanionOnly && required.has(field.key);
  const companionRequired = requiredCompanion.has(field.key);
  const whenMissing = (isCompanionOnly ? companionRequired : primaryRequired) ? 'required' : 'hidden';
  const companionWhenMissingValue = companionRequired ? 'required' : 'hidden';
  const companionWhenMissing = (!isCompanionOnly && companionWhenMissingValue !== whenMissing)
    ? companionWhenMissingValue
    : undefined;
  return {
    storage,
    ...(isCompanionOnly ? {} : { companionStorage: companionPath }),
    writers,
    whenMissing,
    ...(companionWhenMissing !== undefined ? { companionWhenMissing } : {}),
  };
}

/**
 * The technician-reviewed AI photo summary a typed completion can freeze
 * onto its snapshot (`typedPhotoSummary` on the client, `photoSummaryText`
 * server-side) — a top-level `typedReportSnapshot.photoSummary` string, NOT
 * a findingsFields entry, so `typedFormFacts()` never generates it. Shared
 * across every typed line the same way `typedSharedCompletionFacts()` is.
 * @param {{ readers?: VisitFactReader[], notes?: string }} [opts] - extra
 *   per-line readers (e.g. the rodent narrative) beyond report-data.js.
 * @returns {VisitFact}
 */
function typedPhotoSummaryFact(opts = {}) {
  return {
    key: 'typed_photo_summary',
    label: 'Photo summary (technician-reviewed AI photo analysis)',
    capture: ['derived', 'tap'],
    storage: 'service_data.typedReportSnapshot.photoSummary',
    writers: [COMPLETE_SERVICE, via(SCHEDULE_PAGE, 'typedPhotoSummary')],
    readers: [
      { file: REPORT_DATA, section: 'Typed report photo summary card' },
      ...(opts.readers || []),
    ],
    whenMissing: 'hidden',
    notes: opts.notes || 'The AI suggests a summary from the visit\'s uploaded photos; the tech reviews/edits it, and completion freezes the final text onto the typed snapshot (never a findingsFields entry — the field is generated from project-types.js, this is not).',
  };
}

/**
 * The activity-gauge score for a typed form that has an ACTIVITY_INDICATORS
 * entry (codex P2 round 5) — manually-scored types (rodent trapping,
 * exclusion, inspection, wildlife: `derive: null`) have NO findingsFields
 * source for it at all, and even a derived score (cockroach, flea, termite
 * bait station, termite treatment, rodent bait station) is tech-touchable and
 * frozen as its OWN value, never re-derivable from the findings field alone.
 * Returns `[]` for a typedForm with no gauge (tree_shrub, palm_injection,
 * rodent_sanitation, mosquito_event, one_time_lawn_treatment) so every typed
 * line can call this the same way instead of hand-listing which ones qualify.
 *
 * Not a findingsFields entry (no `typedForm` on the returned fact, same as
 * `typedPhotoSummaryFact`) — `complete-scheduled-service.js` freezes it onto
 * `service_data.typedReportSnapshot.activity.{score,source,derivedFrom}`
 * (~L6176-6231) AND inserts it as its own `service_activity_scores` row in
 * the SAME transaction (~L6740-6756), which is what the customer ActivityCard
 * gauge and cross-visit trend chart actually read (`activity-scores-store.js`
 * `loadActivityCustomerView`).
 * @param {string} typedForm
 * @returns {VisitFact[]}
 */
function typedActivityScoreFacts(typedForm) {
  const indicator = ACTIVITY_INDICATOR_DEFS[typedForm];
  if (!indicator) return [];
  return [{
    key: 'typed_activity_score',
    label: `${indicator.label} (0-5 activity score for the gauge + trend chart)`,
    capture: indicator.derive ? ['prefill', 'voice', 'tap'] : ['voice', 'tap'],
    storage: 'service_activity_scores.score',
    // On a COMBINED visit where this form runs as a companion,
    // SchedulePage.jsx sends the score inside companionFindings[].activityScore
    // and complete-scheduled-service.js freezes it onto
    // service_data.companionReportSnapshots[].activity.score BEFORE inserting
    // this SAME service_activity_scores trend row (codex follow-up on #5190;
    // buildTypedReportSnapshot's `activity` param, ~L4072-4082). Same
    // last-segment key as storage (score), not a second fact.
    companionStorage: 'service_data.companionReportSnapshots[].activity.score',
    writers: [
      via(COMPLETE_SERVICE, 'service_activity_scores'),
      via(SCHEDULE_PAGE, 'activityScore'),
      via(COMPLETE_SERVICE, 'companionReportSnapshots'),
      via(SCHEDULE_PAGE, 'companionFindings'),
      // A derive-mapped companion (ACTIVITY_INDICATORS.derive, e.g. flea,
      // cockroach): SchedulePage omits activityScore and the server derives
      // finalScore from the findings field instead.
      via(COMPANION_COMPLETIONS, 'finalScore'),
    ],
    readers: [{
      file: ACTIVITY_SCORES_STORE,
      section: 'Customer ActivityCard gauge + cross-visit trend chart',
      readerSymbol: 'loadActivityCustomerView',
    }],
    whenMissing: 'hidden',
    notes: (indicator.derive
      ? `Prefills from the ${indicator.derive.field} findings field (deriveActivityScore); the tech can still touch/override it (activityScoreSource records which).`
      : 'Manually tech-set (no ACTIVITY_INDICATORS.derive for this form) — no other registered findings field can reconstruct it.')
      + ' On a companion submission the same score also freezes onto the companion\'s own typed snapshot (service_data.companionReportSnapshots[].activity.score) before the service_activity_scores row inserts.',
  }];
}

// ---------------------------------------------------------------------------
// structured_notes keys complete-scheduled-service.js writes that are NOT
// customer-report facts — internal completion bookkeeping (billing/backfill
// provenance, review-ask scheduling, delivery posture, WaveGuard equipment
// compliance, duration/costing, telemetry). server/tests/visit-facts-contract.test.js
// extracts every key the `structuredNotes` object literal writes and requires
// each one to be either a registered fact's storage key OR listed here with a
// reason — so a NEW key that quietly becomes a customer-facing report input
// can't land without either a registry entry or an explicit "this is
// internal-only" decision.
// ---------------------------------------------------------------------------

const UNREGISTERED_INTERNAL_KEYS = Object.freeze({
  requestReview: 'Review-ask scheduling bookkeeping (whether/when to request a review) — not itself rendered on the report.',
  oneTimeRecapOnly: 'Review-ask scheduling bookkeeping (one-time recap-only posture).',
  reviewSuppression: 'Review-ask scheduling bookkeeping (suppression reason).',
  reviewTiming: 'Review-ask scheduling bookkeeping (timing strategy).',
  reviewDelayMinutes: 'Review-ask scheduling bookkeeping (delay before the review request sends).',
  reviewScheduledFor: 'Review-ask scheduling bookkeeping (the computed send time).',
  customerRequestedReview: 'Review-ask scheduling bookkeeping (who asked, when, where) — carried through paid-invoice deferral, never itself a report claim.',
  incompleteReason: 'Internal completion-state bookkeeping (why a visit is marked incomplete), not a customer-facing fact.',
  visitDriveCostAllocation: 'Drive-cost costing bookkeeping, not a customer report fact.',
  timeOnSiteAdjusted: 'Audit marker for an admin-typed duration override; no reader keys off it (see the field\'s own comment in complete-scheduled-service.js).',
  invoiceAlreadySent: 'Billing bookkeeping flag, not a customer report fact.',
  backfill: 'Backfill-completion audit marker (quiet/backdated closeout posture).',
  backfillMintRequired: 'Backfill invoice-mint bookkeeping (required-mint posture frozen at commit).',
  backfillMintAmountCents: 'Backfill invoice-mint bookkeeping (frozen amount).',
  backfillMintTaxRate: 'Backfill invoice-mint bookkeeping (frozen tax rate).',
  backfillMintPayerId: 'Backfill invoice-mint bookkeeping (frozen Bill-To identity).',
  issuedInvoiceCloseout: 'Provenance of an invoice-issued auto-closeout (which invoice, sent or paid) — internal audit trail, not a report claim.',
  completionPricing: 'Reviewed-price witness/amount bookkeeping (pricing audit trail).',
  waveguardEquipmentSystemId: 'WaveGuard mosquito equipment/compliance bookkeeping (system of record), not a report fact.',
  waveguardCalibrationId: 'WaveGuard equipment/compliance bookkeeping.',
  waveguardBlackoutApproval: 'WaveGuard equipment/compliance bookkeeping.',
  waveguardNLimitApproval: 'WaveGuard equipment/compliance bookkeeping.',
  waveguardManagerApproval: 'WaveGuard equipment/compliance bookkeeping.',
  waveguardCalibrationAdvisory: 'WaveGuard equipment/compliance bookkeeping.',
  waveguardInventoryAdvisory: 'WaveGuard equipment/compliance bookkeeping.',
  waveguardTankCleanout: 'WaveGuard equipment/compliance bookkeeping.',
  treeShrubCloseout: 'Tree & shrub required-photos gate audit summary; the photos/captions themselves are the registered facts (completion_photos / completion_photo_caption).',
  treeShrubCloseoutWarnings: 'Tree & shrub required-photos gate audit warnings, paired with treeShrubCloseout.',
  inventoryDeductions: 'Inventory ledger bookkeeping, not a customer report fact.',
  completionTelemetry: 'Opaque client-side completion-form timing, persisted for budget analysis only.',
  typedReportDelivery: 'Delivery-posture bookkeeping (auto_send vs disabled), frozen so a later profile graduation can\'t retroactively expose a report that was never sent — not itself a report claim.',
  companionReportDelivery: 'Delivery-posture bookkeeping for companion sections, same rule as typedReportDelivery.',
  typedFollowupVerdict: 'Follow-up-required bookkeeping frozen at completion (billing/scheduling), not a report fact.',
  closeoutRequirements: 'Frozen closeout-requirements snapshot (internal audit so a later catalog edit can\'t retroactively change a closed visit\'s status), not a report fact.',
  internalOnlyCompletion: 'Internal consultation-mode flag (billing rider / assessment-experience posture), not a report fact.',
});

// ---------------------------------------------------------------------------
// Excluded service lines (owner ruling — never a customer Service Report
// line; they stay on the compliance Projects flow).
// ---------------------------------------------------------------------------

const EXCLUDED_SERVICE_LINES = Object.freeze({
  wdo_inspection: 'FDACS-13645 WDO inspection stays on the compliance project flow (completion-lane-registry.js COMPLIANCE_PROJECT_KEYS.wdo_inspection) — never a customer Service Report.',
  termite_slab_pretreat: 'Pre-treatment termite certificate (FBC) stays on the compliance project flow (COMPLIANCE_PROJECT_KEYS.termite_slab_pretreat -> pre_treatment_termite_certificate) — never a customer Service Report.',
});

// ---------------------------------------------------------------------------
// Retired catalog keys — archived (is_active=false) rows no new visit books.
// Mapped to the migration that retired each; the test verifies the file
// names the key and that no line lists it in catalogKeys. Their residual
// frozen reports still render through the SAME facts as the active keys
// that replaced them (see typedFormFacts).
// ---------------------------------------------------------------------------

const RETIRED_CATALOG_KEYS = Object.freeze({
  pest_termite_bait_quarterly: 'server/models/migrations/20260831000070_retire_two_program_combined_services.js',
  lawn_tree_shrub_combo: 'server/models/migrations/20260831000070_retire_two_program_combined_services.js',
  lawn_fertilization: 'server/models/migrations/20260519000003_service_library_cleanup.js',
  palm_treatment: 'server/models/migrations/20260519000003_service_library_cleanup.js',
});

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

/** @type {Record<string, ServiceLineFacts>} */
const VISIT_FACTS_CONTRACT = {
  recurring_pest: {
    label: 'Recurring pest control',
    catalogKeys: ['pest_general_bimonthly', 'pest_general_monthly', 'pest_general_quarterly', 'pest_general_semiannual', 'waveguard_membership'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      pestActivityRatingFact(),
      ...productFacts(),
      ...photoFacts(),
      {
        key: 'pests_found_where',
        label: 'Pests found + where ("Found" summary line)',
        capture: ['voice'],
        storage: null,
        writers: [],
        readers: [],
        whenMissing: 'hidden',
        status: 'gap',
        notes: 'Owner ruling 2026-09-28: "Found" (pests, where) is a read-only summary line filled from voice. Nothing records it today: observations are species-neutral and unused (0/69), and product targets are the label list, not finds.',
      },
    ],
  },

  one_time_pest: {
    label: 'One-time pest (basic form: one-time pest, fire ant, tick, bee/wasp, mud dauber, cleanout, bed bug)',
    catalogKeys: ['one_time_pest_control', 'fire_ant', 'tick_control', 'bee_wasp_removal', 'mud_dauber_removal', 'pest_initial_cleanout', 'bed_bug_treatment'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      pestActivityRatingFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  reservice_pest: {
    label: 'Pest re-service (callback; full form or Fast Complete)',
    catalogKeys: ['pest_re_service'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts({
        extraReaders: {
          visit_outcome: [{ file: RESERVICE_REPORT, section: 'Re-service hero copy (inspect-only vs re-treated, GATE_RESERVICE_REPORT_COPY)' }],
        },
      }),
      pestActivityRatingFact(),
      ...productFacts(),
      ...photoFacts(),
      {
        key: 'fast_complete_customer_text',
        label: 'Customer recap text from Fast Complete',
        capture: ['voice', 'tap'],
        storage: null,
        writers: [],
        readers: [],
        whenMissing: 'hidden',
        status: 'gap',
        notes: 'FastCompleteSheet.jsx completionBody sends no customerRecap (and sendCompletionSms:false, requestReview:false): a re-service closed through Fast Complete carries no customer-facing text.',
      },
    ],
  },

  lawn: {
    label: 'Lawn care (recurring programs + basic-form one-time lawn add-ons)',
    catalogKeys: ['lawn_care_6week', 'lawn_care_monthly', 'lawn_care_quarterly', 'lawn_care_recurring', 'dethatching', 'plugging', 'top_dressing'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      ...productFacts({
        extraReaders: {
          product_targets: [{ file: LAWN_REPORT_V2, section: 'Treatment card (lawn)' }],
          product_area_value: [{ file: LAWN_REPORT_V2, section: 'Treatment card area line (value + unit)' }],
          product_area_unit: [{ file: LAWN_REPORT_V2, section: 'Treatment card area line (value + unit)' }],
        },
      }),
      ...photoFacts(),
      {
        key: 'lawn_assessment_observations',
        label: 'Lawn assessment observations (photo diagnosis narrative)',
        capture: ['photo', 'derived'],
        storage: 'lawn_assessments.observations',
        writers: [LAWN_ASSESSMENT_ROUTE],
        readers: [{ file: LAWN_REPORT_V2, section: 'Diagnosis / insights card' }],
        whenMissing: 'fallback',
        notes: 'lawn-report-v2.js falls back through observations || aiSummary || customerSummary.',
      },
      {
        key: 'lawn_assessment_ai_summary',
        label: 'Lawn assessment AI summary (fallback source)',
        capture: ['derived'],
        storage: 'lawn_assessments.ai_summary',
        writers: [KNOWLEDGE_BRIDGE],
        readers: [{ file: LAWN_REPORT_V2, section: 'Diagnosis / insights card (fallback when observations is empty)', readerSymbol: 'aiSummary' }],
        whenMissing: 'fallback',
        notes: 'lawn-report-v2.js reads observations || aiSummary || customerSummary; lawn_assessments has no customer_summary column, so aiSummary is the real second source. knowledge-bridge.js is the writer that keeps this one-liner in sync with applied products after the assessment is created.',
      },
      {
        key: 'turf_height_reading',
        label: 'Turf height-of-cut gauge reading (numeric)',
        capture: ['voice', 'tap'],
        storage: 'turf_height_readings.manual_height_in',
        writers: [COMPLETE_SERVICE, TURF_HEIGHT_SERVICE],
        readers: [{ file: REPORT_DATA, section: 'Mowing height card' }],
        whenMissing: 'hidden',
        notes: 'Optional manualHeightIn on the completion body; one row per service record, shared with turf_height_gauge_photo. Either can be present without the other — a photo-only row stores a null reading.',
      },
      {
        key: 'turf_height_gauge_photo',
        label: 'Turf height-of-cut gauge photo',
        capture: ['photo'],
        storage: 'turf_height_readings.gauge_photo_id',
        writers: [COMPLETE_SERVICE, TURF_HEIGHT_SERVICE],
        readers: [{ file: REPORT_DATA, section: 'Mowing height card (gauge photo)' }],
        whenMissing: 'hidden',
        notes: 'The on-site lawn-length documentation photo (a service_photos id), separate from the numeric reading: complete-scheduled-service.js persists a row whenever EITHER is present, and report-data.js resolves this id onto mowingHeight.photoUrl and drops it from the gallery once surfaced there. Not sent by SchedulePage.jsx today (SchedulePage.lawn-closeout.test.jsx asserts the body carries no gaugePhoto) — registered because complete-scheduled-service.js and turf-height-service.js both persist/read the column.',
      },
    ],
  },

  mosquito: {
    label: 'Mosquito control (recurring)',
    catalogKeys: ['mosquito_monthly', 'mosquito_seasonal'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts({
        extraReaders: {
          finding_rows: [{ file: MOSQUITO_REPORT_V2, section: 'Habitat watch card (standing water / foliage / lanai)' }],
        },
      }),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  // -------------------------------------------------------------------------
  // Typed lines — one per PROJECT_TYPES form. Their typed facts are
  // GENERATED (typedFormFacts); only per-key extra readers / notes and the
  // untyped facts (assessments, products, photos, gaps) are written here.
  // -------------------------------------------------------------------------

  tree_shrub: {
    label: 'Tree & shrub (typed tree_shrub form)',
    typedForm: 'tree_shrub',
    catalogKeys: ['tree_shrub_program', 'tree_shrub_6week', 'tree_shrub_quarterly'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('tree_shrub', {
        readers: {
          landscape_condition: [{ file: ACTIVITY_INDICATORS, section: 'Today\'s Result tree & shrub story (buildTodaysResult)' }],
          plant_groups: [{ file: ACTIVITY_INDICATORS, section: 'Today\'s Result tree & shrub story (buildTodaysResult)' }],
        },
      }),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('tree_shrub'),
      typedPhotoSummaryFact(),
      {
        key: 'tree_shrub_assessment_observations',
        label: 'Tree & shrub assessment observations (photo scoring narrative)',
        capture: ['photo', 'derived'],
        storage: 'tree_shrub_assessments.observations',
        writers: [TREE_SHRUB_ASSESSMENT],
        readers: [{ file: TREE_SHRUB_REPORT_V2, section: 'Findings summary + hero photo caption' }],
        whenMissing: 'fallback',
        notes: 'tree-shrub-report-v2.js falls back through observations || aiSummary.',
      },
      {
        key: 'tree_shrub_assessment_ai_summary',
        label: 'Tree & shrub assessment AI summary (fallback source)',
        capture: ['derived'],
        storage: 'tree_shrub_assessments.ai_summary',
        writers: [TREE_SHRUB_ASSESSMENT],
        readers: [{ file: TREE_SHRUB_REPORT_V2, section: 'Findings summary + hero photo caption (fallback when observations is empty)', readerSymbol: 'aiSummary' }],
        whenMissing: 'fallback',
        notes: 'tree-shrub-report-v2.js reads observations || aiSummary || customerSummary; tree_shrub_assessments has no customer_summary column, so aiSummary is the real second source.',
      },
      ...productFacts({
        extraReaders: {
          product_targets: [{ file: TREE_SHRUB_REPORT_V2, section: 'Treatment card (tree & shrub)' }],
          product_area_value: [{ file: TREE_SHRUB_REPORT_V2, section: 'Treatment card area line (value + unit)' }],
          product_area_unit: [{ file: TREE_SHRUB_REPORT_V2, section: 'Treatment card area line (value + unit)' }],
        },
      }),
      ...photoFacts({
        whenMissing: 'required',
        notes: 'Tree & shrub closeout requires TREE_SHRUB_MIN_CLOSEOUT_PHOTOS uploaded photos (treeShrubPhotoGateRequired); the upload tally lands in structured_notes.completionPhotos.',
      }),
    ],
  },

  cockroach: {
    label: 'Cockroach (typed cockroach form: control + German roach packages)',
    typedForm: 'cockroach',
    catalogKeys: ['cockroach_control', 'german_roach', 'german_roach_initial'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('cockroach', {
        notes: {
          evidence_observed: 'Evidence can reconcile the status away from the activity select ("Signs found").',
        },
      }),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('cockroach'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
      {
        key: 'cockroach_work_from_products',
        label: 'Products applied, as a source for the cockroach "What we did" section',
        capture: ['voice', 'tap'],
        storage: 'service_products.product_name',
        writers: [COMPLETE_SERVICE],
        readers: [
          {
            file: COCKROACH_REPORT_V2,
            section: '"What we did" + "Treatments applied" metric + the bait / IGR-aware next-visit and prep copy (workChipsFromApplications, from the report payload\'s applications[])',
            readerSymbol: 'workChipsFromApplications',
          },
        ],
        whenMissing: 'hidden',
        notes: 'Owner ruling 2026-09-26: the "Work completed today" chips were retired from the cockroach form (project-types.js) and "What we did" derives from the product rows instead. Classified by the row\'s catalog category / recorded method / active ingredient, with name fallbacks for Advion gel (bait), Gentrol / Tekko (IGR) and Alpine (crack & crevice); an exterior application area adds the perimeter line. An unrecognised product yields no line. Records completed before the retirement keep their stored work_completed chips, which win over the products. A chip-less record\'s PDF cache key carries a product-row signature (cockroachWorkSourceSignature).',
      },
    ],
  },

  termite_bait: {
    label: 'Termite bait stations (typed termite_bait_station form)',
    typedForm: 'termite_bait_station',
    catalogKeys: ['termite_bait', 'termite_active_annual', 'termite_active_bait_quarterly', 'termite_monitoring', 'termite_cartridge_replacement', 'termite_installation_setup'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('termite_bait_station'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('termite_bait_station'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  rodent_trapping: {
    label: 'Rodent trapping (typed rodent_trapping form, incl. exclusion / sanitation combos)',
    typedForm: 'rodent_trapping',
    catalogKeys: [
      'rodent_trapping', 'rodent_trapping_exclusion', 'rodent_trapping_sanitation', 'rodent_trapping_exclusion_sanitation',
      'rodent_trapping_followup', 'rodent_trap_check_additional',
      'trap_only_retainer_monthly', 'trap_only_retainer_standard', 'trap_only_retainer_plus',
    ],
    voiceFill: true,
    facts: [
      ...typedFormFacts('rodent_trapping', {
        readers: {
          species: [{ file: RODENT_REPORT_NARRATIVE, section: 'Species grounding for the narrative' }],
          trap_visit_type: [
            { file: ACTIVITY_INDICATORS, section: 'Today\'s Result trap-setup wording (isInitialRodentTrapSetup)' },
            { file: RODENT_REPORT_NARRATIVE, section: 'Narrative visitStage "initial_trap_setup"', readerSymbol: 'isInitialRodentTrapSetup' },
          ],
          traps_checked: [{ file: REPORT_DATA, section: 'Trap counts (station summary)' }],
          captures: [
            { file: RODENT_REPORT_NARRATIVE, section: 'Grounded capture sentence' },
          ],
        },
      }),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('rodent_trapping'),
      typedPhotoSummaryFact({
        readers: [{ file: RODENT_REPORT_NARRATIVE, section: 'Narrative photo summary line' }],
      }),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  rodent_exclusion: {
    label: 'Rodent exclusion (typed rodent_exclusion form)',
    typedForm: 'rodent_exclusion',
    catalogKeys: ['rodent_exclusion', 'rodent_exclusion_only', 'rodent_bird_box', 'rodent_wire_mesh'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('rodent_exclusion', {
        readers: {
          exclusion_work_completed: [{ file: ACTIVITY_INDICATORS, section: 'Today\'s Result rodent exclusion story (buildTodaysResult)' }],
          remaining_concerns: [{ file: ACTIVITY_INDICATORS, section: 'Today\'s Result rodent exclusion story (buildTodaysResult)' }],
        },
      }),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('rodent_exclusion'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  rodent_bait_station: {
    label: 'Rodent bait stations (typed rodent_bait_station form)',
    typedForm: 'rodent_bait_station',
    catalogKeys: ['rodent_bait_quarterly', 'rodent_bait_setup'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('rodent_bait_station'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('rodent_bait_station'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  wildlife: {
    label: 'Wildlife trapping (typed wildlife_trapping form)',
    typedForm: 'wildlife_trapping',
    catalogKeys: ['wildlife_trapping'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('wildlife_trapping'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('wildlife_trapping'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  flea: {
    label: 'Flea & tick (typed flea form)',
    typedForm: 'flea',
    catalogKeys: ['flea_tick'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('flea', {
        readers: {
          evidence_level: [{ file: ACTIVITY_INDICATORS, section: 'Flea activity gauge + Today\'s Result flea story (buildTodaysResult)' }],
          activity_areas: [{ file: ACTIVITY_INDICATORS, section: 'Today\'s Result flea story (buildTodaysResult)' }],
          // buildTodaysResult's flea branch composes its "what we did" body
          // through composedWorkSentence(), which reads this field via
          // WORK_PHRASE_FIELDS.flea (field: 'treatment_completed') — a real
          // reader edge the generic typed findings list alone doesn't name
          // (codex follow-up on #5190).
          treatment_completed: [{ file: ACTIVITY_INDICATORS, section: 'Today\'s Result flea story body (composedWorkSentence / WORK_PHRASE_FIELDS.flea)' }],
        },
        notes: {
          customer_prep: 'Owner spec: cooperation must be unmistakable.',
        },
      }),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('flea'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  palm: {
    label: 'Palm injection (typed palm_injection form)',
    typedForm: 'palm_injection',
    catalogKeys: ['palm_injection', 'palm_injection_semiannual'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('palm_injection'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('palm_injection'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  termite_treatment: {
    label: 'Termite treatment (typed termite_treatment form: spot, liquid, trenching, cartridge, setup)',
    typedForm: 'termite_treatment',
    catalogKeys: ['termite_liquid', 'termite_trenching', 'termite_spot_treatment', 'termite_pretreatment', 'foam_drill', 'foam_recurring'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('termite_treatment'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('termite_treatment'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  rodent_inspection: {
    label: 'Rodent inspection (typed rodent_inspection form: diagnostic, one-time)',
    typedForm: 'rodent_inspection',
    catalogKeys: ['rodent_inspection', 'rodent_general_one_time'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('rodent_inspection'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('rodent_inspection'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  rodent_sanitation: {
    label: 'Rodent sanitation (typed rodent_sanitation form)',
    typedForm: 'rodent_sanitation',
    catalogKeys: ['rodent_sanitation_light', 'rodent_sanitation_standard', 'rodent_sanitation_heavy'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('rodent_sanitation'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('rodent_sanitation'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  mosquito_event: {
    label: 'Mosquito event spray (typed mosquito_event form, one-time)',
    typedForm: 'mosquito_event',
    catalogKeys: ['mosquito_one_time'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('mosquito_event'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('mosquito_event'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  one_time_lawn_treatment: {
    label: 'One-time lawn treatment (typed one_time_lawn_treatment form, outside the recurring WaveGuard flow)',
    typedForm: 'one_time_lawn_treatment',
    catalogKeys: ['lawn_care_one_time', 'lawn_pest_knockdown', 'lawn_re_service'],
    voiceFill: true,
    facts: [
      ...typedFormFacts('one_time_lawn_treatment'),
      ...typedSharedCompletionFacts(),
      ...typedActivityScoreFacts('one_time_lawn_treatment'),
      typedPhotoSummaryFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  // Bora-Care wood treatment (basic form, one-time termite-adjacent):
  // completes through the SAME basic Complete Service form as one_time_pest
  // (completion-lane-registry.js ONE_TIME_GENERIC_BY_DESIGN), including the
  // pest activity rating picker every one_time_pest job shows — the form
  // does not branch UI by catalog key. Its beetle/wood-decay-fungi targets
  // don't exist in termite_treatment's option list, so it stays its own
  // basic-form line rather than joining one_time_pest's or lawn's vocabulary
  // (codex follow-up on #5190).
  bora_care: {
    label: 'Bora-Care wood treatment (basic form: one-time termite-adjacent wood treatment)',
    catalogKeys: ['bora_care'],
    voiceFill: true,
    // No pestActivityRatingFact: detectServiceLine reads "bora" as termite
    // (service-line-configs.js), and the Pest Pressure rating is enabled
    // only for its configured service lines (default pest + mosquito), so a
    // Bora-Care completion never captures one.
    facts: [
      ...genericCompletionFacts(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },
};

// ---------------------------------------------------------------------------
// Frozen exports.
// ---------------------------------------------------------------------------

Object.values(VISIT_FACTS_CONTRACT).forEach((line) => {
  Object.freeze(line.catalogKeys);
  line.facts.forEach((fact) => {
    Object.freeze(fact.capture);
    Object.freeze(fact.writers);
    Object.freeze(fact.readers);
    Object.freeze(fact);
  });
  Object.freeze(line.facts);
  Object.freeze(line);
});
Object.freeze(VISIT_FACTS_CONTRACT);

module.exports = {
  VISIT_FACTS_CONTRACT,
  EXCLUDED_SERVICE_LINES,
  RETIRED_CATALOG_KEYS,
  UNREGISTERED_INTERNAL_KEYS,
  TYPED_REPORT_BUILDERS,
  REPORT_DATA_TYPED_AREA_FIELD_KEYS,
  typedFactFields,
};
