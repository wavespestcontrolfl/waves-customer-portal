/**
 * Pest Report V2 — customer-value "expectations" blocks (owner-approved
 * 2026-09-27, dark behind GATE_PEST_REPORT_EXPECTATIONS).
 *
 * Three deterministic, honest, non-guaranteeing blocks built from data the
 * visit already collected: (1) a rain + treatment line, (2) a spider
 * ("#1 callback") acknowledgment triggered ONLY by a recorded completed
 * eave/web/soffit protocol action (owner ruling 2026-09-28: a
 * spider-targeted product alone does NOT establish eaves were treated —
 * see buildSpiderExpectation), and (3) a short "what to expect" list keyed
 * to an EXPLICIT, closed product-name map (owner ruling 2026-09-28: never
 * inferred from active ingredient / moa_group / category — see
 * PRODUCT_EXPECTATION_CLASS). Pure — no I/O, no DB, no fetch — every fact
 * is handed in by the caller (report-data.js / report-copy-context.js
 * / reports-public.js), matching the existing pest-report-v2.js "thin
 * arranger" pattern. Every synthesized line runs through the shared
 * banned-copy guard (validateCustomerCopy) before it can render.
 *
 * Data-driven note: as of 2026-09-27 `products_catalog.rainfast_minutes` is
 * NULL for every currently-active pest product, so the rain-fast clause
 * below never fires against real data today — it renders ONLY when the
 * catalog has a sourced rainfast_minutes number for an applied product
 * (owner ruling 2026-09-28, revised: no generic fallback sentence either —
 * "rain-fast once it has dried" is itself an unsupported claim most labels
 * don't make, and some say to avoid rain within a window instead). The
 * branch is exercised by a synthetic-data test (pest-report-expectations.test.js)
 * rather than left as dead code.
 */

const { validateCustomerCopy } = require('./premium-experience');

function pestReportExpectationsGateOn() {
  return process.env.GATE_PEST_REPORT_EXPECTATIONS === 'true';
}

// Controlled treatment-area chip vocabulary (shared/treatment-area-scopes.json
// — the SAME source report-data.js's own interior/exterior classification
// reads, `AREA_SCOPE_BY_LABEL`). codex P1 2026-09-29 (pre-push audit round
// 3): an earlier unanchored substring regex here (`entry points?`) matched
// the controlled INTERIOR chip "Interior entry points" — a Demand CS
// application chipped there earned both the exterior barrier sentence and
// the ants "treated band" claim. Area evidence now resolves through this
// EXACT, by-key lookup against the controlled classification instead of any
// substring/regex match, matching the "explicit map, never guessed" posture
// classifyProductExpectation already uses. An unrecognized or free-text area
// never qualifies as exterior — fail closed, same as an unmapped product.
const AREA_SCOPES = require('../../../shared/treatment-area-scopes.json');

function normalizeAreaChipText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const EXTERIOR_AREA_CHIPS = new Set((AREA_SCOPES.exterior || []).map(normalizeAreaChipText));
// The eave/soffit chip(s) BY KEY — there is no "overhang" chip in the
// controlled vocabulary, so nothing else may stand in for it.
const EAVE_AREA_CHIPS = new Set(['Eaves / soffit', 'Eaves / soffits'].map(normalizeAreaChipText));

// application_area may be a comma-joined multi-area list (report-data.js's
// matchZoneIds handles the same shape) — split and normalize each part so a
// legitimate chip is recognized regardless of what else rides alongside it.
function applicationAreaChips(value) {
  return String(value || '')
    .split(',')
    .map((part) => normalizeAreaChipText(part))
    .filter(Boolean);
}

function isExteriorApplicationArea(value) {
  return applicationAreaChips(value).some((chip) => EXTERIOR_AREA_CHIPS.has(chip));
}

function isEaveApplicationArea(value) {
  return applicationAreaChips(value).some((chip) => EAVE_AREA_CHIPS.has(chip));
}

// SW Florida rainy season (owner framing: "ants spike when the rains come").
const RAINY_SEASON_MONTHS = new Set([6, 7, 8, 9, 10]); // Jun–Oct

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Number(null) and Number('') are 0 — a genuinely unknown rain/rainfast
// value must not silently become a real zero. Reject the nullish/empty
// cases before coercing (same guard application-conditions.js and
// report-copy-context.js use for the same reason).
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// "30 minutes" / "2 hr" — same shape report-copy-context.js already uses for
// rainfast minutes in the AI-grounding prompt, reused here for customer copy.
function formatRainfastMinutes(minutes) {
  const n = finiteOrNull(minutes);
  if (n == null || n <= 0) return null;
  if (n >= 60) {
    const hours = n / 60;
    return `${hours % 1 ? hours.toFixed(1) : hours.toFixed(0)} hr`;
  }
  return `${n} min`;
}

function formatInches(value) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  // Trim trailing zeros: 1.20 -> 1.2, 1.00 -> 1, 0.30 -> 0.3.
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

// Minimum rain (inches) required to add the ants-after-rain line, given a
// resolved rainConfidence and whether the service month is rainy season.
// Extracted from buildRainExpectation so the two independent decisions (the
// rain-fact sentence vs. the ants signal) don't compound into one function's
// branch count.
function antsRainThresholdInches(rainConfidence, rainySeason) {
  if (rainConfidence === 'low') return 1; // hedged number — always the higher bar
  return rainySeason ? 0.5 : 1;
}

// Rain-fast clause text — owner ruling 2026-09-28 (revised): the clause
// appears ONLY when the catalog actually has rainfast_minutes for an
// applied product. There is deliberately NO generic fallback sentence
// ("...once it has dried.") — that phrasing was itself an unsupported claim:
// most labels don't state rain-fastness at all, and some instead say to
// avoid rain within a window after application. With no sourced number,
// this returns '' — no rain-fast clause of any kind (today, since prod
// rainfast_minutes is NULL everywhere, that means never). Extracted from
// buildRainExpectation to keep the two independent decisions (the rain-fact
// sentence vs. the rain-fast clause) from compounding into one function's
// branch count.
//
// codex P2 2026-09-29 (round 2): when SEVERAL applied products each carry a
// positive rainfastMinutes, state the LONGEST one — the customer needs to
// know how long to wait for every applied product to be rain-fast, and a
// shorter interval from an earlier array entry would understate that
// (array order is incidental, never a safety ranking).
function rainfastClauseText(products) {
  const rainfastValues = products
    .map((p) => finiteOrNull(p?.rainfastMinutes))
    .filter((n) => n != null && n > 0);
  if (!rainfastValues.length) return '';
  const rainfastLabel = formatRainfastMinutes(Math.max(...rainfastValues));
  return rainfastLabel ? ` Your treatment is rain-fast about ${rainfastLabel} after it dries, per the label.` : '';
}

// Forward-looking heavy-rain caveat text — LIVE view only (see
// buildRainExpectation's forecastHeavyRain param doc). Shared between the
// "attached to the trailing-week fact" case and the "no settled trailing
// total to attach it to" case below (codex P2 deferred finding c, #5137) so
// the two can never drift into different wording for the same signal.
const HEAVY_RAIN_FORECAST_CAVEAT = 'Heavy rain right after a treatment can reduce it — if you\'re seeing activity after a downpour, let us know.';

// The opening rain line: the trailing-week fact (+ optional rainfast/forecast
// clauses) when a settled week is available, OR — when it is not — the live
// forecast caveat on its own (codex P2 deferred finding c, #5137: a same-day
// live report with an OPEN trailing-week window has no settled fact to
// attach the caveat to; settledWeekWeatherForRender, reports-public.js,
// withholds it from every render, live included). Returns null when there
// is nothing to say. Extracted so this "what opens the rain block" decision
// doesn't compound buildRainExpectation's own branch count.
function buildTrailingWeekRainLine({
  rainInches, rainConfidence, products, forecastHeavyRain,
}) {
  // The caveat is a treatment claim: an inspection- or sweep-only visit (no
  // recorded application) never gets it, attached or standalone (codex r2
  // on #5265).
  const treatmentCaveat = forecastHeavyRain && (products || []).length > 0;
  if (rainInches == null) return treatmentCaveat ? HEAVY_RAIN_FORECAST_CAVEAT : null;
  const inchesText = formatInches(rainInches);
  let sentence = rainConfidence === 'low'
    // Low-confidence (city-collective fallback) hedges the number rather
    // than stating it as an exact property read.
    ? `Rain gauges for your area suggest roughly ${inchesText}" over the past week — local totals can vary.`
    : `It's rained about ${inchesText}" at your property over the past week.`;
  sentence += rainfastClauseText(products);
  // Forward-looking heavy-rain caveat — LIVE view only (see param doc).
  // Never a claim that rain can't otherwise affect the treatment beyond the
  // label facts above.
  if (treatmentCaveat) sentence += ` ${HEAVY_RAIN_FORECAST_CAVEAT}`;
  return sentence;
}

// ── Rain and your treatment ──────────────────────────────────────────────
// weekWeather: { rainInches, rainConfidence } from application-conditions.js
//   fetchServiceWeekWeather (7-day trailing window ending on the service date).
// products: flat [{ rainfastMinutes }] — label rain-fast time, when the
//   catalog has it (see module header re: current NULL coverage).
// serviceMonth: 1–12, the visit's calendar month (SWFL rainy-season check).
// forecastHeavyRain: LIVE VIEW ONLY — true when the property's NWS forecast
//   (server/services/weather-forecast.js) shows a high chance of rain/storm
//   in roughly the next 24–72h. Callers must pass false/omit for any
//   non-live (PDF/static) render — this is the one input that must never
//   reach a permanent document.
function buildRainExpectation({
  weekWeather = null,
  products = [],
  serviceMonth = null,
  forecastHeavyRain = false,
} = {}) {
  const rainInches = finiteOrNull(weekWeather?.rainInches);
  const rainConfidence = weekWeather?.rainConfidence || null;
  const lines = [];

  const trailingWeekLine = buildTrailingWeekRainLine({
    rainInches, rainConfidence, products, forecastHeavyRain,
  });
  if (trailingWeekLine) lines.push(trailingWeekLine);

  // Ants-after-rain expectation — owner ruling 2026-09-28: NEVER on the
  // calendar month alone. Requires an actual rain signal: >= 0.5" during
  // rainy season (Jun–Oct), >= 1" otherwise — and a low-confidence
  // (city-collective fallback) reading always uses the higher 1" bar,
  // season or not, since that number is itself hedged. OR the LIVE-only
  // forecast heavy-rain signal. No rain data and no forecast signal =>
  // no ants line, regardless of month.
  const rainySeason = Number.isInteger(serviceMonth) && RAINY_SEASON_MONTHS.has(serviceMonth);
  const heavyWeek = rainInches != null && rainInches >= antsRainThresholdInches(rainConfidence, rainySeason);
  if (heavyWeek || forecastHeavyRain) {
    // codex P1 2026-09-29 (pre-push audit round 2): "moving through the
    // treated band" is a TREATMENT claim — it must never fire from rain
    // alone. A sweep-only or inspection-only visit (no applications at all)
    // and an interior-only application both previously got this exact
    // wording just because it rained. Require the SAME confirmed
    // exterior/perimeter application evidence the pyrethroid barrier
    // sentence requires (hasExteriorApplicationEvidence — explicit,
    // non-inferred perimeter_spray/broadcast_spray method, or an
    // applicationArea naming an exterior/perimeter chip) on a product whose
    // class actually forms a residual band (non_repellent or pyrethroid);
    // an ant BAIT, a roach gel, or an IGR is not a perimeter band either,
    // regardless of where it was placed. No such evidence (no applications
    // at all, interior-only, or unknown method/area) => treatment-neutral
    // wording — still an honest, useful fact (rain pushes ants indoors
    // regardless of what was applied), just no claim about a treated band.
    // report-copy-context.js's grounding path funnels through this same
    // function with the SAME toExpectationProduct-normalized products, and
    // structurally has no per-application method/area (deduped by catalog
    // product, not by application) — it always fails this check and gets
    // the neutral wording too, so generated copy can never claim more than
    // the customer-facing card does.
    // ...AND that band must have been applied FOR ANTS (codex P1 round 4:
    // `targets` is the tech's own structured tag list) — otherwise the
    // colony/trail claim is pest-neutral wording only.
    const perimeterTreatmentEvidence = (products || []).some((product) => {
      const cls = classifyProductExpectation(product);
      return (cls === 'non_repellent' || cls === 'pyrethroid')
        && hasExteriorApplicationEvidence(product)
        && hasAntTargetEvidence(product);
    });
    lines.push(perimeterTreatmentEvidence
      ? 'Heavy rain pushes ants indoors; trails over the next few days usually mean the colony is moving through the treated band.'
      : 'Heavy rain pushes ants indoors for a few days — if activity is still noticeable after about a week, text us and we\'ll take another look.');
  }

  if (!lines.length) return null;
  const safeLines = lines.filter((line) => validateCustomerCopy(line));
  return safeLines.length ? { lines: safeLines } : null;
}

// ── Spiders (#1 callback) ────────────────────────────────────────────────
// Owner ruling 2026-09-28 (P1 audit): a spider-TARGETED product does NOT
// establish that eaves were treated — the tech may have tagged a product
// for spiders while applying it somewhere else entirely (interior crack &
// crevice, a different zone). The ONLY evidence the eaves/webs were worked
// is a recorded completed eave/web/soffit protocol action (protocols.json —
// e.g. "Swept eaves, window frames, door frames, and lanai"), so that is
// now the SOLE entry point for this whole section. No action recorded =>
// no spider section, full stop — never inferred from a product target
// alone. actionLabels: raw completed-action label strings for the visit
// (server-internal only — see report-data.js's completedProtocolActionLabels;
// never rendered verbatim, only matched) — used ONLY for the section gate
// above. actionEntries: the same completed actions WITH treatmentApplied
// preserved (report-data.js's completedProtocolActionEntries,
// { label, treatmentApplied }[], server-internal only) — used for the
// residual-evidence check below, where a sweep (treatmentApplied: false)
// must not count as a treatment. applications: the same array pest-report-v2
// builds ({ product: {...}, targets: [...], applicationArea, ... }).
const SPIDER_ACTION_RE = /\b(eave|eaves|web|webs|webbing|soffit|cobweb)\b/i;
// The LOCATION claim ("around the eaves and entry points") needs an action
// that actually names the eaves/soffit — codex P2 2026-09-28 round 5: the
// canonical exterior action "Removed accessible webs from the recorded
// exterior areas." is a web action (opens the section) but says nothing
// about where, so it gets location-neutral wording.
const EAVE_ACTION_RE = /\b(eave|eaves|soffit|soffits)\b/i;
// Actual evidence webs were REMOVED, as opposed to merely an eave/soffit
// LOCATION being named (codex P2 deferred finding b, #5137): the
// completedActions "serviced-eaves" choice ("Completed the recorded eave and
// soffit service.", client/src/lib/service-completion-choices.js) matches
// SPIDER_ACTION_RE purely because it names the eaves — it records no web
// work of any kind and could just as easily be a residual application or an
// inspection. Every wording this module can produce opens with "We knocked
// down webs...", so that claim needs an action that actually says so: either
// it names web(s)/webbing/a cobweb directly (the completedActions
// "removed-webs" choice), or it explicitly SWEPT (protocols.json's "Swept
// eaves, window frames, door frames, and lanai" — sweeping IS the
// web-removal act). A location-only eave action with none of that wording
// gets no card at all rather than an invented "we knocked down webs" claim.
const WEB_REMOVAL_ACTION_RE = /\b(webs?|webbing|cobweb|swept|sweep(?:ing)?)\b/i;
const SPIDER_TARGET_RE = /spider/i;
// Ant-specific wording (colony, "ants may show up more", the treated-band
// trail claim) needs an application the tech actually TAGGED for ants —
// codex P1 2026-09-28 round 4: a non-repellent applied for roaches only, or
// the auto-seeded pest mix on a visit with no ant target, must not tell the
// customer to expect ants. Word-bounded so "pants"/"giant" never match.
const ANT_TARGET_RE = /\bants?\b/i;
function hasAntTargetEvidence(product) {
  return Array.isArray(product?.targets) && product.targets.some((t) => ANT_TARGET_RE.test(t));
}
// Structured application-area evidence that the eaves/soffit specifically
// were worked (owner ruling 2026-09-28, P1 audit round 2: a spider-targeted
// pyrethroid applied ANYWHERE previously earned the residual/treated
// wording even when the tech only SWEPT the eaves — treatmentApplied:
// false — while separately spraying somewhere unrelated). isEaveApplicationArea
// (above) matches the controlled application-area chip vocabulary BY KEY —
// "Eaves / soffit(s)" only, never free text like technician notes, and never
// a substring match (codex P1 2026-09-29 round 3: a substring regex here
// would have the same false-positive class the exterior-barrier regex did).

// Fixed customer wording only — a raw completed protocol-action label is
// NEVER rendered here; it is used only to decide the action gate above.
//   1. action recorded, NO spider-labeled pyrethroid residual applied
//      -> de-web only, no treatment claim
//   2. action recorded AND a spider-labeled pyrethroid residual (from the
//      explicit PRODUCT_EXPECTATION_CLASS map) was also applied
//      -> combined wording — the eaves claim still rests on the recorded
//         action, never on the product target alone
const WEB_ONLY_TEXT = 'We knocked down webs around the eaves and entry points.';
// Same de-web fact, location-neutral — no recorded action placed the work
// at the eaves (codex P2 round 5).
const WEB_ONLY_GENERIC_TEXT = 'We knocked down the webs we could reach on the exterior.';
const WEB_AND_RESIDUAL_TEXT = 'We knocked down webs and treated the eaves and entry points where spiders build.';

// De-web-only expectation (combo 1): no "the residual we applied" claim —
// there is no residual to point to. New webs regrowing is just biology, not
// evidence the sweep "isn't working" (there is no residual to work).
const WEB_ONLY_EXPECTATION = 'New webs can appear within days as new spiders arrive from outside — that\'s normal.';
const WEB_ONLY_NEXT_STEP = 'If webbing keeps coming back over the next two weeks, text us and we\'ll take another look.';

// Residual-backed expectation (combo 2) — the only case where we can
// honestly credit a residual for thinning webs out over time.
const RESIDUAL_EXPECTATION = 'New webs can appear within days as new spiders arrive from outside — that\'s normal. '
  + 'The residual we applied kills spiders that land on treated eaves and entry points, so webbing should '
  + 'noticeably thin out over about two weeks.';
const RESIDUAL_NEXT_STEP = 'If it hasn\'t thinned out by then, text us and we\'ll come take another look.';

function buildSpiderExpectation({ actionLabels = [], actionEntries = [], applications = [] } = {}) {
  const actionHit = (actionLabels || []).some(
    (label) => SPIDER_ACTION_RE.test(cleanText(label)),
  );
  // No recorded eave/web/soffit action => no section, regardless of any
  // spider-targeted product (see module note above).
  if (!actionHit) return null;

  // Web-removal evidence, specifically — not just an eave/soffit-NAMED
  // action (codex P2 deferred finding b, #5137; see WEB_REMOVAL_ACTION_RE
  // above). Every wording below claims webs were knocked down; a
  // location-only "Completed the recorded eave and soffit service." with no
  // web-removal/sweep evidence anywhere on the visit earns no card, gate on
  // or off, residual or not — an unproven "we knocked down webs" claim is
  // never invented just because a treatment happened to reach the eaves.
  const webRemovalNamed = (actionLabels || []).some((label) => WEB_REMOVAL_ACTION_RE.test(cleanText(label)))
    || (actionEntries || []).some((entry) => WEB_REMOVAL_ACTION_RE.test(cleanText(entry?.label)));
  if (!webRemovalNamed) return null;

  // A genuine eave TREATMENT recorded for the visit — not just a sweep
  // (protocol marks a sweep treatmentApplied: false, and that alone is not
  // application evidence the eaves were treated; see the module note above
  // and the P1-C fix this closes). Visit-wide, not tied to one product.
  const eaveActionTreated = (actionEntries || []).some(
    (entry) => entry?.treatmentApplied === true && EAVE_ACTION_RE.test(cleanText(entry?.label)),
  );
  // Did any recorded action place the work AT the eaves/soffit? Without one
  // the de-web sentence stays location-neutral (codex P2 round 5).
  const eaveNamed = (actionLabels || []).some((label) => EAVE_ACTION_RE.test(cleanText(label)))
    || (actionEntries || []).some((entry) => EAVE_ACTION_RE.test(cleanText(entry?.label)));

  // A spider-labeled residual actually applied: tech-tagged for spiders,
  // classified pyrethroid by the explicit product-name map (never a target
  // tag alone — that was the FIRST P1 this replaced), AND now also tied to
  // the eaves/soffit area (owner ruling 2026-09-28, P1 audit round 2): the
  // application's OWN recorded area names eaves/soffit/overhang, OR the
  // visit separately recorded a genuine (treatmentApplied: true) eave
  // action above. A product applied somewhere else entirely — the eaves
  // only ever SWEPT — no longer earns the residual/treated wording.
  const residualApplied = (applications || []).some((app) => {
    const targeted = Array.isArray(app?.targets) && app.targets.some((t) => SPIDER_TARGET_RE.test(cleanText(t)));
    if (!targeted || classifyProductExpectation(toExpectationProduct(app)) !== 'pyrethroid') return false;
    const areaEvidence = isEaveApplicationArea(app?.applicationArea);
    return areaEvidence || eaveActionTreated;
  });

  const whatWeDid = residualApplied ? WEB_AND_RESIDUAL_TEXT : (eaveNamed ? WEB_ONLY_TEXT : WEB_ONLY_GENERIC_TEXT);
  const expectation = residualApplied ? RESIDUAL_EXPECTATION : WEB_ONLY_EXPECTATION;
  const nextStep = residualApplied ? RESIDUAL_NEXT_STEP : WEB_ONLY_NEXT_STEP;

  return {
    headline: 'Spiders',
    whatWeDid,
    expectation,
    nextStep,
  };
}

// ── What to expect (by treatment) ────────────────────────────────────────
// Owner ruling 2026-09-28 (P1 audit, 2 rounds of misclassification from the
// prior heuristic — a spider-targeted product read as an eave treatment,
// and a category/name-regex classifier would have called an Advion ANT
// Bait Gel a roach product): classification is now an EXPLICIT, CLOSED map
// keyed by the exact catalog product name (normalized: cleanText + lower),
// never inferred from active ingredient, moa_group, or category alone. A
// product NOT in this map gets NO what-to-expect line — fail closed, never
// guess. Extend this map (with an owner-verified product name) rather than
// reintroducing inference.
function normalizeProductName(name) {
  return cleanText(name).toLowerCase();
}

const PRODUCT_EXPECTATION_CLASS = new Map([
  ['taurus sc', 'non_repellent'],
  ['alpine wsg', 'non_repellent'],
  // codex P2 2026-09-29 (round 2): the CATALOG's canonical products_catalog.name
  // is "Atticus Talak" (migration 20260712100000_catalog_label_rate_backfill.js,
  // and every other seed/backfill migration that touches this row) —
  // client/src/lib/pest-default-mix.js's house-mix matcher also resolves
  // against that exact catalog row name. "Atticus Talak 7.9 F" is kept too:
  // several purchase-receipt / Amazon-parser / completion-default-products
  // fixtures use the longer display string, and this map fails closed on
  // ANY spelling it doesn't carry — a name mismatch here silently drops a
  // product's classification with no error, so both spellings stay mapped.
  ['atticus talak', 'pyrethroid'],
  ['atticus talak 7.9 f', 'pyrethroid'],
  ['demand cs', 'pyrethroid'],
  ['onslaught fastcap', 'pyrethroid'],
  // Delta Dust is its own class, NOT 'pyrethroid' (owner ruling 2026-09-28,
  // P1 audit round 2): it is a DUST formulation applied into cracks/voids,
  // never a surface barrier — the old shared mapping told a customer whose
  // dust went into an interior void that "the barrier treatment... near
  // doors and windows" was working. See the 'dust' class copy below.
  ['delta dust', 'dust'],
  ['advion evolution cockroach gel bait', 'roach_gel_bait'],
  ['advion cockroach gel bait', 'roach_gel_bait'],
  ['advion ant bait gel', 'ant_bait'],
  ['advion wdg granular', 'ant_bait'],
  ['gentrol igr', 'igr'],
  ['tekko pro igr', 'igr'],
  // Surfactant/adjuvant — deliberately maps to no class (documented here so
  // it reads as a decision, not an omission).
  ['lesco 90/10 nonionic surfactant', null],
].map(([name, cls]) => [normalizeProductName(name), cls]));

function classifyProductExpectation(product = {}) {
  const name = normalizeProductName(product?.name);
  if (!name) return null;
  return PRODUCT_EXPECTATION_CLASS.get(name) ?? null;
}

const EXPECTATION_TEXT = {
  non_repellent: 'Non-repellent products (like what we used) work by transfer — ants may show up more for a '
    + 'few days as they carry it back to the colony, then drop off over about 1–2 weeks.',
  // Same class, but no application on this visit was tagged for ants
  // (codex P1 2026-09-28 round 4) — pest-neutral transfer wording.
  non_repellent_general: 'Non-repellent products (like what we used) work by transfer — insects that cross the '
    + 'treated area carry it back to where they nest, so activity can pick up for a few days before dropping '
    + 'off over about 1–2 weeks.',
  ant_bait: 'Ants that find the bait carry it back to the colony, so you may see a few more ants near the '
    + 'placements for a few days before they drop off.',
  roach_gel_bait: 'With gel bait, dead roaches may show up out in the open for a week or two as the colony '
    + 'feeds and dies off — that\'s the bait working, not a sign it isn\'t.',
  // Barrier wording — ONLY when the application evidence confirms an
  // exterior/perimeter method or area (see hasExteriorApplicationEvidence).
  pyrethroid: 'The barrier treatment keeps working after it\'s applied, but a few insects can still wander in '
    + 'and die near doors and windows for about 10–14 days.',
  // Same product class, but the application's method/area is unknown or not
  // confirmed exterior (owner ruling 2026-09-28, P1 audit round 2): never
  // claim a barrier is protecting doors/windows without evidence it was
  // applied there. Still honest about how the product itself works.
  pyrethroid_unconfirmed: 'This treatment keeps working after it\'s applied, so you may still see a few insects '
    + 'die off over the next 10–14 days as they come into contact with it.',
  // Dust formulations (Delta Dust and any other dust in the product map,
  // owner ruling 2026-09-28, P1 audit round 2) go into cracks, voids, and
  // gaps — never a surface barrier, so this never uses "barrier" or
  // "near doors and windows" language.
  dust: 'Dust products work down inside cracks, voids, and gaps rather than as a visible surface treatment, so '
    + 'it can take a little longer to notice fewer bugs — it\'s working out of sight.',
  igr: 'IGR products work on the next generation, so results build gradually over several weeks rather than '
    + 'overnight.',
};

// Fixed priority when more than 3 classes triggered — cap to ~3 lines.
const EXPECTATION_PRIORITY = ['non_repellent', 'ant_bait', 'roach_gel_bait', 'pyrethroid', 'dust', 'igr'];

// Application evidence that a product was applied via an EXTERIOR/PERIMETER
// method or area — required before the "barrier" wording claims it is
// protecting doors/windows (owner ruling 2026-09-28, P1 audit round 2: the
// prior heuristic gave every pyrethroid-classed product the barrier
// sentence regardless of method or area, which would have told a customer
// an INTERIOR crack-and-crevice pyrethroid application was a barrier
// working near their doors and windows). Structured fields only
// (report-data.js's own method / methodInferred / applicationArea, never
// free text). methodInferred === true means no EXPLICIT method was
// recorded — methodFromProduct's pest-line fallback silently defaults an
// unspecified method to 'perimeter_spray', which is a GUESS, not
// application evidence, so an inferred method is treated the same as
// unknown (fail closed, same "explicit map, never guessed" posture as
// classifyProductExpectation itself). The area side reads
// isExteriorApplicationArea (module top) — the controlled chip
// classification BY KEY, never a substring regex (codex P1 2026-09-29
// round 3: an earlier unanchored "entry points?" alternative matched the
// controlled INTERIOR chip "Interior entry points").
const EXTERIOR_METHODS = new Set(['perimeter_spray', 'broadcast_spray']);

function hasExteriorApplicationEvidence(product = {}) {
  if (product.methodInferred !== true && EXTERIOR_METHODS.has(String(product.method || ''))) return true;
  return isExteriorApplicationArea(product.applicationArea);
}

function buildWhatToExpect({ products = [] } = {}) {
  const classes = new Set();
  // Confirmed exterior evidence for ANY qualifying pyrethroid application —
  // one confirmed application is enough to earn the barrier line even if
  // another pyrethroid application this visit has unknown method/area.
  let pyrethroidExteriorConfirmed = false;
  // Ant-specific non-repellent wording needs an ant-TAGGED non-repellent
  // application (codex P1 round 4); otherwise the pest-neutral variant.
  let nonRepellentAntTagged = false;
  for (const product of products) {
    const cls = classifyProductExpectation(product);
    if (!cls) continue;
    classes.add(cls);
    if (cls === 'pyrethroid' && hasExteriorApplicationEvidence(product)) {
      pyrethroidExteriorConfirmed = true;
    }
    if (cls === 'non_repellent' && hasAntTargetEvidence(product)) {
      nonRepellentAntTagged = true;
    }
  }
  if (!classes.size) return null;
  const lines = EXPECTATION_PRIORITY
    .filter((cls) => classes.has(cls))
    .slice(0, 3)
    .map((cls) => {
      if (cls === 'pyrethroid' && !pyrethroidExteriorConfirmed) return EXPECTATION_TEXT.pyrethroid_unconfirmed;
      if (cls === 'non_repellent' && !nonRepellentAntTagged) return EXPECTATION_TEXT.non_repellent_general;
      return EXPECTATION_TEXT[cls];
    })
    .filter((line) => validateCustomerCopy(line));
  return lines.length ? { lines } : null;
}

// Canonical product shape for expectations classification
// ({ name, activeIngredient, category, moaGroup, rainfastMinutes }) — the
// ONE normalizer SHARED by every caller (owner-flagged P1 2026-09-28: the
// AI-grounding path in report-copy-context.js was building its own product
// list without `name`, so a name-dependent classification — e.g. roach gel
// bait, which needs the name to tell it apart from other bait — could come
// out different for the grounded AI copy than for the customer-facing
// block). Accepts either the pest-report-v2.js applications shape
// (`{ product: { name, active_ingredient, category, moa_group,
// rainfast_minutes } }`, snake_case DB-ish keys) or an already-flat/camelCase
// object (report-copy-context.js's `productSafety` entries) — reads
// whichever keys are present so both call sites funnel through the exact
// same fields the classifier reads, and can't silently drift apart again.
function isPlainObject(value) {
  return !!value && typeof value === 'object';
}

// camelCase key, else its snake_case twin, else null.
function pickEither(source, camelKey, snakeKey) {
  if (!isPlainObject(source)) return null;
  return source[camelKey] ?? source[snakeKey] ?? null;
}

function toExpectationProduct(raw = {}) {
  const product = isPlainObject(raw?.product) ? raw.product : raw;
  return {
    name: isPlainObject(product) ? (product.name ?? null) : null,
    activeIngredient: pickEither(product, 'activeIngredient', 'active_ingredient'),
    category: isPlainObject(product) ? (product.category ?? null) : null,
    moaGroup: pickEither(product, 'moaGroup', 'moa_group'),
    rainfastMinutes: pickEither(product, 'rainfastMinutes', 'rainfast_minutes'),
    // APPLICATION-level (not product-level) structured fields — report-data.js
    // carries these as siblings of `product` on each application, so they
    // are read off `raw`, never `product`. Present only when `raw` IS an
    // application (pest-report-v2.js's own caller); absent/null for
    // report-copy-context.js's `productSafety` entries, which are deduped
    // by CATALOG PRODUCT and carry no per-application method/area — that
    // caller's barrier-vs-unconfirmed choice fails closed the same way an
    // explicitly unknown value would (never assumes a barrier without
    // evidence; see hasExteriorApplicationEvidence).
    method: isPlainObject(raw) ? (raw.method ?? null) : null,
    methodInferred: isPlainObject(raw) && typeof raw.methodInferred === 'boolean' ? raw.methodInferred : null,
    applicationArea: pickEither(raw, 'applicationArea', 'application_area'),
    // The tech's structured target tags for THIS application (codex P1
    // round 4) — null when the caller has no per-application data.
    targets: Array.isArray(raw?.targets) ? raw.targets.map((t) => cleanText(t)).filter(Boolean) : null,
  };
}

// ── Compose all three blocks ─────────────────────────────────────────────
function buildPestExpectations({
  weekWeather = null,
  applications = [],
  actionLabels = [],
  actionEntries = [],
  serviceMonth = null,
  forecastHeavyRain = false,
} = {}) {
  const flatProducts = (applications || []).map(toExpectationProduct);
  const rain = buildRainExpectation({
    weekWeather, products: flatProducts, serviceMonth, forecastHeavyRain,
  });
  const spiders = buildSpiderExpectation({ actionLabels, actionEntries, applications });
  const whatToExpect = buildWhatToExpect({ products: flatProducts });
  if (!rain && !spiders && !whatToExpect) return null;
  // Each child key is present only when that block has something to say
  // (codex P0 #5137 r6 — the public contract; never a serialized null).
  return {
    ...(rain ? { rain } : {}),
    ...(spiders ? { spiders } : {}),
    ...(whatToExpect ? { whatToExpect } : {}),
  };
}

module.exports = {
  pestReportExpectationsGateOn,
  RAINY_SEASON_MONTHS,
  classifyProductExpectation,
  buildRainExpectation,
  buildSpiderExpectation,
  buildWhatToExpect,
  buildPestExpectations,
  toExpectationProduct,
  isExteriorApplicationArea,
  formatRainfastMinutes,
  formatInches,
};
