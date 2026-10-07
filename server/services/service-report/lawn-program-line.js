/**
 * Lawn monthly program line (lawn report rebuild P9, GATE_LAWN_EXPECTATIONS).
 *
 * One calendar-based, tier-neutral sentence about what the lawn program v13
 * focuses on in this month (one universal program for every grass, owner
 * 2026-09-30 / 2026-10-05). It describes the program, not what one visit
 * applied: a step the v13 recipe makes conditional is only ever stated with a
 * qualifier. It replaces the generic peak/shoulder/dormant season note in
 * snapshot.seasonalNote while the gate is live, and ONLY for a visit whose plan
 * resolved the staged v13 version with GATE_LAWN_V13 on. Every other visit
 * (completed before v13, pinned to an older version, or with no recorded
 * version) gets no line and keeps the season note: the old per-grass sentences
 * described the retired grass-track programs (and steps such as soil tests that
 * Waves does not run), so they are gone, and a past report is never rewritten
 * with a program the visit did not run.
 *
 * Rules the copy keeps (pinned by server/tests/lawn-v13-copy.test.js):
 *   - program-level: "in <month> the program focuses on ...", never a promise
 *     about one product, a tier, a visit count, a rate, a date or a clock time;
 *   - no product or brand name, no ordinance / county / blackout / law wording;
 *   - no watering, rain, irrigation or mowing instruction (the banner and the
 *     water card own those);
 *   - every claim has a `claims` entry whose phrase the test proves against the
 *     lawn-protocol-v13.json visit for that month, including its conditions,
 *     so no treatment is invented and no skipped step is stated plainly.
 *
 * Jun-Sep: the program carries no nitrogen in those months, so a line that
 * describes them would be wrong for a visit that applied a nitrogen product
 * (analysis_n > 0). buildProgramLine returns null for that visit and the caller
 * keeps the old season note.
 */

const featureGates = require('../../config/feature-gates');
const { LAWN_V13_VERSION } = require('../lawn-program');

// Months in which the program applies no nitrogen. A visit that did apply some
// does not match the line, so the line steps aside.
const NO_NITROGEN_MONTHS = new Set([6, 7, 8, 9]);

// Wording that marks a step as conditional. A claim whose v13 recipe step is
// conditional (not a plain primary line, or worded if / only / hold / skip / no)
// must carry one of these inside its own phrase; the test derives which claims
// are conditional from the recipe itself. None of them names irrigation,
// watering, a tier, a visit count, a product or a soil test (owner 2026-10-05:
// Waves runs no soil tests).
const QUALIFIERS = [
  'where the lawn needs it',
  'where needed',
  'when conditions allow',
  'where it fits the property',
  'as needed',
  'on request',
  'where helpful',
];

// month number (1-12) -> { line, claims }. `line` describes what the program
// focuses on this time of year (never what one visit applied); `claims` maps
// each recipe fact the sentence relies on to the exact phrase that states it,
// so the test can prove the phrase against lawn-protocol-v13.json.
// L(line, { tag: phrase }): every tag's phrase appears verbatim in the line.
const L = (line, claims) => ({ line, claims });

const FALL_FEED = 'the fall feeding';

// GATE_LAWN_V13: one universal program for every grass, so one table for all
// of them. The claims are proven against server/config/lawn-protocol-v13.json
// by server/tests/lawn-v13-copy.test.js.
const SPOT_DISEASE = 'spot treatment for disease and weeds where needed';
const V13_BARRIER = 'a pre-emergent weed-barrier application where it fits the property';
const V13_FALL_BARRIER = 'a pre-emergent weed barrier where it fits the property';
const PROGRAM_LINES_V13 = {
  1: L(`In January the program focuses on ${V13_BARRIER} and a micronutrient feeding, plus ${SPOT_DISEASE}.`, { pre_emergent: V13_BARRIER, micros: 'a micronutrient feeding', fungicide: SPOT_DISEASE, broadleaf: SPOT_DISEASE }),
  2: L('In February the program focuses on a feeding as the lawn greens up, plus spot weed control where needed.', { feed: 'a feeding as the lawn greens up', broadleaf: 'spot weed control where needed' }),
  3: L(`In March the program focuses on ${V13_BARRIER} and a micronutrient feeding, plus spot treatment for root disease and weeds where needed.`, { pre_emergent: V13_BARRIER, micros: 'a micronutrient feeding', fungicide: 'spot treatment for root disease and weeds where needed', broadleaf: 'spot treatment for root disease and weeds where needed' }),
  4: L('In April the program focuses on a light feeding, plus spot treatment for root disease and chinch bugs where needed.', { feed: 'a light feeding', fungicide: 'spot treatment for root disease and chinch bugs where needed', insect_spot: 'spot treatment for root disease and chinch bugs where needed' }),
  5: L('In May the program focuses on an insect treatment where it fits the property, plus spot treatment for chinch bugs, weeds and dry spots where needed.', { insect_treatment: 'an insect treatment where it fits the property', insect_spot: 'spot treatment for chinch bugs, weeds and dry spots where needed', broadleaf: 'spot treatment for chinch bugs, weeds and dry spots where needed', dry_spots: 'spot treatment for chinch bugs, weeds and dry spots where needed' }),
  6: L(`In June the program focuses on a micronutrient feeding and ${V13_BARRIER}, plus spot treatment for disease and chinch bugs where needed.`, { micros: 'a micronutrient feeding', pre_emergent: V13_BARRIER, fungicide: 'spot treatment for disease and chinch bugs where needed', insect_spot: 'spot treatment for disease and chinch bugs where needed' }),
  7: L('In July the program focuses on an inspection of the whole lawn, plus spot treatment for caterpillars, leaf spot disease and chinch bugs where needed.', { scouting_visit: 'an inspection of the whole lawn', insect_spot: 'spot treatment for caterpillars, leaf spot disease and chinch bugs where needed', fungicide: 'spot treatment for caterpillars, leaf spot disease and chinch bugs where needed' }),
  8: L('In August the program focuses on a micronutrient feeding, plus spot treatment for leaf spot disease and caterpillars where needed.', { micros: 'a micronutrient feeding', fungicide: 'spot treatment for leaf spot disease and caterpillars where needed', insect_spot: 'spot treatment for leaf spot disease and caterpillars where needed' }),
  9: L('In September the program focuses on a micronutrient feeding, plus spot treatment for root disease and caterpillars where needed.', { micros: 'a micronutrient feeding', fungicide: 'spot treatment for root disease and caterpillars where needed', insect_spot: 'spot treatment for root disease and caterpillars where needed' }),
  10: L(`In October the program focuses on ${FALL_FEED} with ${V13_FALL_BARRIER}, plus spot treatment for large patch, grubs and weeds where needed.`, { feed: FALL_FEED, pre_emergent: V13_FALL_BARRIER, fungicide: 'spot treatment for large patch, grubs and weeds where needed', insect_spot: 'spot treatment for large patch, grubs and weeds where needed', broadleaf: 'spot treatment for large patch, grubs and weeds where needed' }),
  11: L('In November the program focuses on a feeding, plus spot treatment for large patch and sedge where needed.', { feed: 'a feeding', fungicide: 'spot treatment for large patch and sedge where needed', broadleaf: 'spot treatment for large patch and sedge where needed' }),
  12: L('In December the program focuses on a light feeding, plus spot treatment for large patch and weeds where needed.', { feed: 'a light feeding', fungicide: 'spot treatment for large patch and weeds where needed', broadleaf: 'spot treatment for large patch and weeds where needed' }),
};

// Any applied product with nitrogen (analysis_n > 0). Reads the catalog value on
// either report shape; when the catalog value is absent, a fertilizer-analysis
// name ("24-0-11") is read the same way.
function nitrogenOf(app) {
  if (!app || typeof app !== 'object') return 0;
  const p = app.product && typeof app.product === 'object' ? app.product : {};
  const facts = app.approved_report_product_facts && typeof app.approved_report_product_facts === 'object' ? app.approved_report_product_facts : {};
  for (const v of [p.analysis_n, app.analysis_n, p.analysisN, app.analysisN, facts.analysis_n, facts.analysisN]) {
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  const name = p.name || app.product_name || facts.name || '';
  const m = /(?:^|[^\d])(\d{1,2})-\d{1,2}-\d{1,2}(?!\d)/.exec(String(name));
  return m ? Number(m[1]) : 0;
}

function appliedNitrogen(applications) {
  return (Array.isArray(applications) ? applications : []).some((app) => nitrogenOf(app) > 0);
}

// A resolved catalog row is a fertilizer when its category / type says so.
const FERTILIZER_TYPE = /fert|nitrogen|urea|\bnpk\b/i;
const isFertilizerRow = (row) => FERTILIZER_TYPE.test(`${row && row.category || ''} ${row && row.product_type || ''} ${row && row.subcategory || ''}`);

/**
 * The report-data caller's nitrogen answer for the program line. Fails closed:
 * only fully resolved products with a known analysis_n of 0 (or a resolved
 * non-fertilizer with no analysis_n) clear it. Counts as nitrogen applied:
 *   - a failed product load or catalog read;
 *   - ANY applied product without a resolved catalog row (no catalogId, or no
 *     row returned; a removed catalog row nulls service_products.product_id,
 *     and a name such as "Chelated Iron Plus" says nothing about its analysis);
 *   - a resolved row with analysis_n above 0;
 *   - a resolved fertilizer-type row whose analysis_n is NULL;
 *   - the name / application shapes (a fertilizer analysis such as "24-0-11"),
 *     kept only as an extra positive signal.
 * @param {{ applications?: object[], productsLoadFailed?: boolean, loadCatalogRows: (ids: string[]) => Promise<object[]> }} input
 *   loadCatalogRows returns rows with id, analysis_n and category / product_type.
 * @returns {Promise<boolean>}
 */
async function resolveNitrogenApplied({ applications = [], productsLoadFailed = false, loadCatalogRows }) {
  if (productsLoadFailed) return true;
  const apps = Array.isArray(applications) ? applications : [];
  if (appliedNitrogen(apps)) return true;
  try {
    const ids = apps.map((app) => (app && app.product && app.product.catalogId) || null);
    if (ids.some((id) => !id)) return true;
    const unique = [...new Set(ids)];
    if (!unique.length) return false;
    const rows = await loadCatalogRows(unique);
    const byId = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row && row.id), row]));
    return unique.some((id) => {
      const row = byId.get(String(id));
      if (!row) return true;
      const n = row.analysis_n;
      if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return isFertilizerRow(row);
      return Number(n) > 0;
    });
  } catch {
    return true;
  }
}

// Service keys of the recurring lawn plan (a 9x or 12x plan visit runs the
// month's protocol). The catalog's billing type must also say recurring.
const RECURRING_LAWN_PLAN_KEY = /^lawn_(?:care|recurring)(?:_|$)/;

/**
 * Is this visit a recurring lawn plan visit? Only those get the program line:
 * a one-time lawn job (lawn_care_one_time, lawn_pest_knockdown, ...) or a
 * callback is not part of the program. Never the WaveGuard tier.
 *
 * The frozen completion identity wins (same rule the trace-eligibility path
 * uses): service_data.completedServiceKey is stamped at completion, so a later
 * edit that repoints the scheduled row to another service can neither give a
 * completed one-time visit the line nor take it from a genuine program visit.
 * A frozen key that is null (the freezer could not prove an identity) is an
 * unknown identity: no line, and no live fallback. Only a legacy record with
 * no completedServiceKey at all falls back to the live catalog identity of the
 * scheduled visit (service_id, then service_key_snapshot, then an unambiguous
 * name, via the completion-profile resolver): a real, non-synthesized profile
 * whose billing type is recurring and whose key is a recurring lawn plan key.
 * Fails closed: no scheduled visit and no frozen key, a callback, an unresolved
 * or synthesized profile, or a lookup error all mean false.
 * @param {{ serviceData?: object|null, scheduledService?: object|null, isCallback?: boolean, loadProfile?: (row: object) => Promise<object|null> }} input
 * @returns {Promise<boolean>}
 */
const isRecurringLawnPlanKey = (key) => RECURRING_LAWN_PLAN_KEY.test(String(key || '')) && !/one_?time/i.test(String(key || ''));

async function resolveProgramVisit({ serviceData = null, scheduledService = null, isCallback = false, loadProfile } = {}) {
  if (isCallback === true) return false;
  if (serviceData && typeof serviceData === 'object' && Object.prototype.hasOwnProperty.call(serviceData, 'completedServiceKey')) {
    return isRecurringLawnPlanKey(serviceData.completedServiceKey);
  }
  if (!scheduledService || typeof loadProfile !== 'function') return false;
  try {
    const profile = await loadProfile(scheduledService);
    if (!profile || profile.synthesized) return false;
    return String(profile.billingType || '').toLowerCase() === 'recurring'
      && isRecurringLawnPlanKey(profile.serviceKey);
  } catch {
    return false;
  }
}

/**
 * @param {{ month?: number|null, applications?: object[], nitrogenApplied?: boolean|null, programVisit?: boolean, protocolVersion?: string|null }} input
 *   programVisit must be true (a recurring lawn plan visit, see resolveProgramVisit);
 *   anything else, including omitted, returns null.
 *   protocolVersion is the lawn protocol version the visit's plan resolved
 *   (completion ledger row, else the scheduled visit's pin), null when none is
 *   recorded. Only 2026.10-v13 with GATE_LAWN_V13 on gets a line.
 *   nitrogenApplied is the caller's catalog-backed answer (report-data reads
 *   analysis_n); null means derive it from `applications`. month is the visit's
 *   calendar month (1-12), already computed at a noon-UTC anchor by the report builder.
 * @returns {string|null} the program line, or null when there is no honest line
 *   (not a plan visit, not a v13 visit, no valid month, or a Jun-Sep visit that
 *   applied nitrogen); the caller then keeps the season note.
 */
function buildProgramLine({ month = null, applications = [], nitrogenApplied = null, programVisit = false, protocolVersion = null } = {}) {
  if (programVisit !== true) return null;
  // v13 copy only for a visit whose plan resolved the staged v13 version (the
  // closeout's ledger row, or the scheduled visit's pin, carries it). A visit with
  // no recorded version is historical or unattributed, and one pinned to an older
  // version ran a retired grass-track program: neither gets a line.
  if (!featureGates.lawnV13Live?.() || protocolVersion !== LAWN_V13_VERSION) return null;
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (NO_NITROGEN_MONTHS.has(m) && (nitrogenApplied === null ? appliedNitrogen(applications) : nitrogenApplied === true)) return null;
  return PROGRAM_LINES_V13[m].line;
}


// GATE_LAWN_PROGRAM_DETAIL (owner 2026-10-06: "add more detail here ... use the
// labels, seasonality"): under the v13 month sentence, why this month's step
// fits the season, what the customer will see, and seasonal watering guidance.
// Each line restates the v13 month step (server/config/lawn-protocol-v13.json)
// by category, never a product name or rate, plus Southwest Florida seasons:
// dry season Nov-May, rainy season Jun-Sep, summer nitrogen limits Jun-Sep.
// Watering here is general seasonal guidance only; a product's own water-in
// or hold step comes from its label rule in the report's watering section.
const DRY = 'Water about \u00be inch only when the lawn shows thirst (blades fold or footprints stay). Water early in the morning, on your county\u2019s allowed watering days.';
const RAIN = 'Summer rain usually covers the lawn. Turn irrigation down or off in weeks with regular rain, and water only when the lawn shows thirst. Extra water now invites fungus.';
const PROGRAM_DETAIL_V13 = Object.freeze({
  1: Object.freeze({
    whyNow: 'January is the coolest stretch of the year. Winter weeds are sprouting while the grass grows slowly, so a weed barrier goes down where it fits the property and a micronutrient feeding keeps the color up without pushing growth the grass cannot use in the cold. Cool, damp spells can bring large patch, so we treat any active spots.',
    whatYouSee: 'Color holds steady and growth stays slow, so mowing is light. A few weeds that sprouted earlier may still show; we spot treat them.',
    watering: [DRY, 'In cool weather the lawn needs water less often than in spring.'],
  }),
  2: Object.freeze({
    whyNow: 'As the days lengthen in February, the lawn starts to green up. A feeding supports that green-up, and we spot treat weeds while they are small.',
    whatYouSee: 'Green-up builds as the weather warms, and mowing picks up toward the end of the month.',
    watering: [DRY],
  }),
  3: Object.freeze({
    whyNow: 'In March the soil warms and summer weeds such as crabgrass start to sprout. The spring weed barrier goes down now where it fits the property, ahead of them, with a micronutrient feeding for color. Spring is also when the root disease take-all can show, so mapped trouble areas get a treatment.',
    whatYouSee: 'The weed barrier is invisible: it works by stopping new weeds before they start. Color deepens and growth speeds up.',
    watering: [DRY],
  }),
  4: Object.freeze({
    whyNow: 'April warms quickly and the grass is growing hard, so it gets a light feeding. Chinch bugs start to wake up in hot, sunny spots, and we check for them and treat where we find them.',
    whatYouSee: 'Thicker, faster growth and weekly mowing. Dry, yellowing patches in sunny areas near pavement are worth telling us about.',
    watering: [DRY, 'April and May are usually the driest months, so check for thirst more often.'],
  }),
  5: Object.freeze({
    whyNow: 'May, before the rains, is peak season for chinch bugs and other lawn insects in hot, sunny turf. The sunny turf gets an insect treatment where it fits the property, and we spot treat chinch bugs, weeds and dry spots elsewhere.',
    whatYouSee: 'The lawn should hold its color through the dry heat. Spots that stay yellow after watering are worth telling us about.',
    watering: [DRY, 'April and May are usually the driest months, so check for thirst more often.'],
  }),
  6: Object.freeze({
    whyNow: 'The rainy season starts in June, and local summer fertilizer rules limit nitrogen until fall. The lawn gets iron and micronutrients for color instead, plus a weed barrier for summer weeds where it fits the property. Heat and rain bring gray leaf spot and chinch bugs, which we spot treat.',
    whatYouSee: 'Color from the micronutrients shows without extra top growth. Growth is fast with the rain, so mowing stays weekly.',
    watering: [RAIN],
  }),
  7: Object.freeze({
    whyNow: 'July is a scouting visit. Summer fertilizer limits mean no whole-lawn feeding, so we inspect the whole lawn and treat problem spots only, such as caterpillars, leaf spot or chinch bugs.',
    whatYouSee: 'Summer rain keeps the lawn growing. Chewed or ragged patches can mean caterpillars and are worth telling us about.',
    watering: [RAIN],
  }),
  8: Object.freeze({
    whyNow: 'Late summer heat and rain continue. A micronutrient feeding keeps the color up, and we treat leaf spot or caterpillar spots where we find them.',
    whatYouSee: 'Steady color through the heat, with fast growth and weekly mowing.',
    watering: [RAIN],
  }),
  9: Object.freeze({
    whyNow: 'September is the end of the rainy season. A micronutrient feeding keeps the color up, mapped take-all areas get a fall treatment, and we watch for caterpillars.',
    whatYouSee: 'Growth starts to slow as the month goes on.',
    watering: [RAIN, 'As the rains taper off, turn irrigation back up only as the lawn needs it.'],
  }),
  10: Object.freeze({
    whyNow: 'As the soil cools in October, winter weeds like annual bluegrass and chickweed start to sprout. The fall feeding goes down now, with a weed barrier where it fits the property, so the barrier is in place before they come up. Cooler, damp nights also bring large patch, a fungus that shows as tan or orange rings, so we check for it and treat any spots.',
    whatYouSee: 'The feeding greens the lawn as it settles in. Growth slows as the days get shorter, so you will mow less. The weed barrier is invisible: it works by stopping new weeds before they start.',
    watering: [DRY, 'Wet grass overnight invites large patch, so water in the morning only.'],
  }),
  11: Object.freeze({
    whyNow: 'November is cool and dry. The lawn gets a feeding to carry it into winter, mapped large patch areas are treated, and sedge spots are treated if they come back.',
    whatYouSee: 'Growth slows and color holds.',
    watering: [DRY, 'Wet grass overnight invites large patch, so water in the morning only.'],
  }),
  12: Object.freeze({
    whyNow: 'December brings cooler spells. A light feeding keeps the color up, and we treat any large patch and weed spots.',
    whatYouSee: 'Slow growth and light mowing through the holidays.',
    watering: [DRY, 'In cool weather the lawn needs water less often than in spring.'],
  }),
});

// The month's detail, only beside a v13 program line (same visits, same month)
// and only while GATE_LAWN_PROGRAM_DETAIL is live. When the visit carries its
// own label aftercare (a water-in or a hold) or a weather-derived weekly water
// plan, the seasonal watering lines step
// aside so the report never gives two watering directions (codex #6091 r1).
function buildProgramDetail({ month, programLine, aftercare = null, water = null } = {}) {
  if (!programLine || typeof featureGates.lawnProgramDetailLive !== 'function' || !featureGates.lawnProgramDetailLive()) return undefined;
  const detail = PROGRAM_DETAIL_V13[Number(month)];
  if (!detail) return undefined;
  const weekPlan = water && water.weekPlan;
  // The weather-derived "Water This Week" plan is the report's watering
  // direction when present; the seasonal lines never sit beside it (codex #6091 r2).
  const visitWatering = !!(weekPlan || (aftercare && (aftercare.waterInRequired || aftercare.neutral === false)));
  return visitWatering ? { whyNow: detail.whyNow, whatYouSee: detail.whatYouSee, watering: [] } : detail;
}

module.exports = {
  buildProgramLine,
  buildProgramDetail,
  PROGRAM_DETAIL_V13,
  PROGRAM_LINES_V13,
  QUALIFIERS,
  NO_NITROGEN_MONTHS,
  appliedNitrogen,
  resolveNitrogenApplied,
  resolveProgramVisit,
  isRecurringLawnPlanKey,
};
