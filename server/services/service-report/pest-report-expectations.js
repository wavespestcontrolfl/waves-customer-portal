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
function rainfastClauseText(products) {
  const rainfastMinutes = products
    .map((p) => finiteOrNull(p?.rainfastMinutes))
    .find((n) => n != null && n > 0);
  const rainfastLabel = rainfastMinutes != null ? formatRainfastMinutes(rainfastMinutes) : null;
  return rainfastLabel ? ` Your treatment is rain-fast about ${rainfastLabel} after it dries, per the label.` : '';
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

  if (rainInches != null) {
    const inchesText = formatInches(rainInches);
    let sentence = rainConfidence === 'low'
      // Low-confidence (city-collective fallback) hedges the number rather
      // than stating it as an exact property read.
      ? `Rain gauges for your area suggest roughly ${inchesText}" over the past week — local totals can vary.`
      : `It's rained about ${inchesText}" at your property over the past week.`;

    sentence += rainfastClauseText(products);

    // Forward-looking heavy-rain caveat — LIVE view only (see param doc).
    // Never a claim that rain can't otherwise affect the treatment beyond
    // the label facts above.
    if (forecastHeavyRain) {
      sentence += ' Heavy rain right after a treatment can reduce it — if you\'re seeing activity after a downpour, let us know.';
    }
    lines.push(sentence);
  }

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
    lines.push('Heavy rain pushes ants indoors; trails over the next few days usually mean the colony is moving through the treated band.');
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
// never rendered verbatim, only matched). applications: the same array
// pest-report-v2 builds ({ product: {...}, targets: [...] }).
const SPIDER_ACTION_RE = /\b(eave|eaves|web|webs|webbing|soffit|cobweb)\b/i;
const SPIDER_TARGET_RE = /spider/i;

// Fixed customer wording only — a raw completed protocol-action label is
// NEVER rendered here; it is used only to decide the action gate above.
//   1. action recorded, NO spider-labeled pyrethroid residual applied
//      -> de-web only, no treatment claim
//   2. action recorded AND a spider-labeled pyrethroid residual (from the
//      explicit PRODUCT_EXPECTATION_CLASS map) was also applied
//      -> combined wording — the eaves claim still rests on the recorded
//         action, never on the product target alone
const WEB_ONLY_TEXT = 'We knocked down webs around the eaves and entry points.';
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

function buildSpiderExpectation({ actionLabels = [], applications = [] } = {}) {
  const actionHit = (actionLabels || []).some(
    (label) => SPIDER_ACTION_RE.test(cleanText(label)),
  );
  // No recorded eave/web/soffit action => no section, regardless of any
  // spider-targeted product (see module note above).
  if (!actionHit) return null;

  // A spider-labeled residual actually applied: tech-tagged for spiders
  // AND classified pyrethroid by the explicit product-name map — never a
  // target tag alone (that was the P1 this replaces).
  const residualApplied = (applications || []).some((app) => {
    const targeted = Array.isArray(app?.targets) && app.targets.some((t) => SPIDER_TARGET_RE.test(cleanText(t)));
    return targeted && classifyProductExpectation(toExpectationProduct(app)) === 'pyrethroid';
  });

  const whatWeDid = residualApplied ? WEB_AND_RESIDUAL_TEXT : WEB_ONLY_TEXT;
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
  ['atticus talak 7.9 f', 'pyrethroid'],
  ['demand cs', 'pyrethroid'],
  ['onslaught fastcap', 'pyrethroid'],
  ['delta dust', 'pyrethroid'],
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
  ant_bait: 'Ants that find the bait carry it back to the colony, so you may see a few more ants near the '
    + 'placements for a few days before they drop off.',
  roach_gel_bait: 'With gel bait, dead roaches may show up out in the open for a week or two as the colony '
    + 'feeds and dies off — that\'s the bait working, not a sign it isn\'t.',
  pyrethroid: 'The barrier treatment keeps working after it\'s applied, but a few insects can still wander in '
    + 'and die near doors and windows for about 10–14 days.',
  igr: 'IGR products work on the next generation, so results build gradually over several weeks rather than '
    + 'overnight.',
};

// Fixed priority when more than 3 classes triggered — cap to ~3 lines.
const EXPECTATION_PRIORITY = ['non_repellent', 'ant_bait', 'roach_gel_bait', 'pyrethroid', 'igr'];

function buildWhatToExpect({ products = [] } = {}) {
  const classes = new Set();
  for (const product of products) {
    const cls = classifyProductExpectation(product);
    if (cls) classes.add(cls);
  }
  if (!classes.size) return null;
  const lines = EXPECTATION_PRIORITY
    .filter((cls) => classes.has(cls))
    .slice(0, 3)
    .map((cls) => EXPECTATION_TEXT[cls])
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
  };
}

// ── Compose all three blocks ─────────────────────────────────────────────
function buildPestExpectations({
  weekWeather = null,
  applications = [],
  actionLabels = [],
  serviceMonth = null,
  forecastHeavyRain = false,
} = {}) {
  const flatProducts = (applications || []).map(toExpectationProduct);
  const rain = buildRainExpectation({
    weekWeather, products: flatProducts, serviceMonth, forecastHeavyRain,
  });
  const spiders = buildSpiderExpectation({ actionLabels, applications });
  const whatToExpect = buildWhatToExpect({ products: flatProducts });
  if (!rain && !spiders && !whatToExpect) return null;
  return { rain, spiders, whatToExpect };
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
  formatRainfastMinutes,
  formatInches,
};
