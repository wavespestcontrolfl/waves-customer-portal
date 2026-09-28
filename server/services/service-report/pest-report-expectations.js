/**
 * Pest Report V2 — customer-value "expectations" blocks (owner-approved
 * 2026-09-27, dark behind GATE_PEST_REPORT_EXPECTATIONS).
 *
 * Three deterministic, honest, non-guaranteeing blocks built from data the
 * visit already collected: (1) a rain + treatment line, (2) a spider
 * ("#1 callback") acknowledgment when eave/web work or spider-targeted
 * products were part of the visit, and (3) a short "what to expect" list
 * keyed to the product classes applied. Pure — no I/O, no DB, no fetch —
 * every fact is handed in by the caller (report-data.js / report-copy-context.js
 * / reports-public.js), matching the existing pest-report-v2.js "thin
 * arranger" pattern. Every synthesized line runs through the shared
 * banned-copy guard (validateCustomerCopy) before it can render.
 *
 * Data-driven note: as of 2026-09-27 `products_catalog.rainfast_minutes` is
 * NULL for every currently-active pest product, so the "rain-fast once dry"
 * clause below almost never fires against real data today — it stays in the
 * SAME function (rather than a separate helper) because it is a natural
 * extension of the one rain sentence, and it is exercised by a synthetic-data
 * test (pest-report-expectations.test.js) rather than left as dead code.
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

    // Rain-fast clause — only when a rainfast time actually exists for an
    // applied product (see module header). Never invents a number.
    const rainfastMinutes = products
      .map((p) => finiteOrNull(p?.rainfastMinutes))
      .find((n) => n != null && n > 0);
    const rainfastLabel = rainfastMinutes != null ? formatRainfastMinutes(rainfastMinutes) : null;
    if (rainfastLabel) {
      sentence += ` Your treatment is rain-fast once dry (about ${rainfastLabel}, per the label).`;
    }

    // Forward-looking heavy-rain caveat — LIVE view only (see param doc).
    // Never a claim that rain can't otherwise affect the treatment beyond
    // the label facts above.
    if (forecastHeavyRain) {
      sentence += ' Heavy rain right after a treatment can reduce it — if you\'re seeing activity after a downpour, let us know.';
    }
    lines.push(sentence);
  }

  // Ants-after-rain expectation — rainy season (Jun–Oct) or a genuinely wet
  // week (>= 1"), per owner ruling. Calendar-based, so it can stand even
  // without a resolved rain reading.
  const rainySeason = Number.isInteger(serviceMonth) && RAINY_SEASON_MONTHS.has(serviceMonth);
  const heavyWeek = rainInches != null && rainInches >= 1;
  if (rainySeason || heavyWeek) {
    lines.push('Heavy rain pushes ants indoors; trails over the next few days usually mean the colony is moving through the treated band.');
  }

  if (!lines.length) return null;
  const safeLines = lines.filter((line) => validateCustomerCopy(line));
  return safeLines.length ? { lines: safeLines } : null;
}

// ── Spiders (#1 callback) ────────────────────────────────────────────────
// Eave/web/soffit work, tech-completed action labels (protocols.json —
// e.g. "Swept eaves, window frames, door frames, and lanai"), regardless of
// whether the label itself carries treatmentApplied (a sweep is still
// spider-relevant work). actionLabels: raw completed-action label strings
// for the visit. products: the same applications array pest-report-v2 already
// builds ({ targets: [...] }) — a spider-targeted product also triggers.
const SPIDER_ACTION_RE = /\b(eave|eaves|web|webs|webbing|soffit|cobweb)\b/i;
const SPIDER_TARGET_RE = /spider/i;

function buildSpiderExpectation({ actionLabels = [], applications = [] } = {}) {
  const matchedLabels = [...new Set(
    (actionLabels || []).map(cleanText).filter((label) => label && SPIDER_ACTION_RE.test(label)),
  )];
  const targetHit = (applications || []).some(
    (app) => Array.isArray(app?.targets) && app.targets.some((t) => SPIDER_TARGET_RE.test(cleanText(t))),
  );
  if (!matchedLabels.length && !targetHit) return null;

  const whatWeDidCandidate = matchedLabels.length
    ? `This visit: ${matchedLabels.join('; ')}.`
    : 'We applied a residual treatment labeled for spiders during this visit.';
  const whatWeDid = validateCustomerCopy(whatWeDidCandidate)
    ? whatWeDidCandidate
    : 'We applied a residual treatment labeled for spiders during this visit.';

  const expectation = 'New webs can appear within days as new spiders arrive from outside — that\'s normal. '
    + 'The residual we applied kills spiders that land on treated eaves and entry points, so webbing should '
    + 'noticeably thin out over about two weeks.';
  const nextStep = 'If it hasn\'t thinned out by then, text us and we\'ll come take another look.';

  return {
    headline: 'Spiders',
    whatWeDid,
    expectation,
    nextStep,
  };
}

// ── What to expect (by treatment) ────────────────────────────────────────
// Keyed off product class (moa_group / active ingredient / category), never
// the product's marketing name. One line per class, de-duplicated, capped
// at 3 — fixed priority order when more than 3 classes are present.
const NON_REPELLENT_ACTIVE_RE = /\b(fipronil|dinotefuran|imidacloprid|indoxacarb)\b/i;
const NON_REPELLENT_MOA_RE = /\b(2b|4a|22a)\b/i;
const PYRETHROID_ACTIVE_RE = /\b(bifenthrin|cyfluthrin|lambda[-\s]?cyhalothrin|deltamethrin|permethrin|esfenvalerate|cypermethrin)\b/i;
const PYRETHROID_MOA_RE = /\b3a\b/i;
const IGR_ACTIVE_RE = /\b(hydroprene|pyriproxyfen|novaluron|methoprene|fenoxycarb)\b/i;
const IGR_CATEGORY_RE = /\bigr\b|growth regulator/i;
const IGR_MOA_RE = /\b7[ac]\b/i;
const ROACH_GEL_CATEGORY_RE = /\bgel\b/i;
const ROACH_BAIT_CATEGORY_RE = /\bbait\b/i;
const ROACH_NAME_RE = /roach/i;

function classifyProductExpectation(product = {}) {
  const activeIngredient = cleanText(product.activeIngredient);
  const category = cleanText(product.category);
  const moaGroup = cleanText(product.moaGroup);
  const name = cleanText(product.name);

  if (IGR_CATEGORY_RE.test(category) || IGR_CATEGORY_RE.test(name)
    || IGR_ACTIVE_RE.test(activeIngredient) || IGR_MOA_RE.test(moaGroup)) {
    return 'igr';
  }
  if (ROACH_GEL_CATEGORY_RE.test(category)
    || (ROACH_BAIT_CATEGORY_RE.test(category) && ROACH_NAME_RE.test(name))) {
    return 'roach_gel_bait';
  }
  if (NON_REPELLENT_ACTIVE_RE.test(activeIngredient) || NON_REPELLENT_MOA_RE.test(moaGroup)) {
    return 'non_repellent';
  }
  if (PYRETHROID_ACTIVE_RE.test(activeIngredient) || PYRETHROID_MOA_RE.test(moaGroup)) {
    return 'pyrethroid';
  }
  return null;
}

const EXPECTATION_TEXT = {
  non_repellent: 'Non-repellent products (like what we used) work by transfer — ants may show up more for a '
    + 'few days as they carry it back to the colony, then drop off over about 1–2 weeks.',
  roach_gel_bait: 'With gel bait, dead roaches may show up out in the open for a week or two as the colony '
    + 'feeds and dies off — that\'s the bait working, not a sign it isn\'t.',
  pyrethroid: 'The barrier treatment keeps working after it\'s applied, but a few insects can still wander in '
    + 'and die near doors and windows for about 10–14 days.',
  igr: 'IGR products work on the next generation, so results build gradually over several weeks rather than '
    + 'overnight.',
};

// Fixed priority when more than 3 classes triggered — cap to ~3 lines.
const EXPECTATION_PRIORITY = ['non_repellent', 'roach_gel_bait', 'pyrethroid', 'igr'];

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

// ── Compose all three blocks ─────────────────────────────────────────────
function buildPestExpectations({
  weekWeather = null,
  applications = [],
  actionLabels = [],
  serviceMonth = null,
  forecastHeavyRain = false,
} = {}) {
  const flatProducts = (applications || []).map((app) => ({
    name: app?.product?.name,
    activeIngredient: app?.product?.active_ingredient,
    category: app?.product?.category,
    moaGroup: app?.product?.moa_group,
    rainfastMinutes: app?.product?.rainfast_minutes,
  }));
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
  formatRainfastMinutes,
  formatInches,
};
