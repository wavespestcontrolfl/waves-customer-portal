/**
 * Lawn monthly program line (lawn report rebuild P9, GATE_LAWN_EXPECTATIONS).
 *
 * One calendar-based, tier-neutral sentence about what the program focuses on in
 * this month, written from what server/config/protocols.json says for that grass
 * and month. It describes the program, not what one visit applied: a step the
 * protocol makes conditional (skip / only-if / soil-test / weather-gated /
 * optional / on request) is only ever stated with a qualifier. It replaces
 * the generic peak/shoulder/dormant season note in snapshot.seasonalNote while
 * the gate is live.
 *
 * Rules the copy keeps (pinned by server/tests/lawn-program-line.test.js):
 *   - program-level: "in <month> the program focuses on ...", never a promise
 *     about one product, a tier, a visit count, a rate, a date or a clock time;
 *   - no product or brand name, no ordinance / county / blackout / law wording;
 *   - no watering, rain, irrigation or mowing instruction (the banner and the
 *     water card own those);
 *   - every claim has a `claims` entry whose phrase the test proves against the
 *     protocols.json visit for that grass and month, including its conditions,
 *     so no treatment is invented and no skipped step is stated plainly.
 *
 * Jun-Sep: the program carries no nitrogen in those months, so a line that
 * describes them would be wrong for a visit that applied a nitrogen product
 * (analysis_n > 0). buildProgramLine returns null for that visit and the caller
 * keeps the old season note.
 */

const protocols = require('../../config/protocols.json');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Months in which the program applies no nitrogen. A visit that did apply some
// does not match the line, so the line steps aside.
const NO_NITROGEN_MONTHS = new Set([6, 7, 8, 9]);

// Wording that marks a step as conditional. A claim whose protocols.json step
// is conditional (skip / only-if / soil-test / weather-gated / tier-specific /
// optional) must carry one of these inside its own phrase; the test derives
// which claims are conditional from protocols.json itself. None of them names
// irrigation, watering, a tier, a visit count or a product.
const QUALIFIERS = [
  'where the lawn needs it',
  'where needed',
  'when conditions allow',
  'where it fits the property',
  'where a soil test calls for it',
  'matched to soil test results',
  'as needed',
  'on request',
  'where helpful',
];

// month number (1-12) -> { line, claims } per grass. `line` describes what the
// program focuses on this time of year (never what one visit applied);
// `claims` maps each protocol fact the sentence relies on to the exact phrase
// that states it, so the test can prove the phrase against protocols.json.
// L(line, { tag: phrase }): every tag's phrase appears verbatim in the line.
const L = (line, claims) => ({ line, claims });

const BARRIER = 'a pre-emergent weed-barrier application';
const SOIL_FEED = 'a spring feeding matched to soil test results';
const FALL_FEED = 'the fall feeding';
const WINTER = 'offers a winter check-in on request, including what dormant, brown turf means';

const PROGRAM_LINES = {
  st_augustine: {
    1: L(`In January the program focuses on ${BARRIER}, with broadleaf weed control when conditions allow.`, { pre_emergent: BARRIER, broadleaf: 'broadleaf weed control when conditions allow' }),
    2: L('In February the program focuses on a light feeding with iron and micronutrients.', { feed: 'a light feeding with iron and micronutrients', micros: 'a light feeding with iron and micronutrients' }),
    3: L(`In March the program focuses on ${BARRIER} and a spring feeding, with scouting for chinch bugs and thatch.`, { pre_emergent: BARRIER, feed: 'a spring feeding', chinch_check: 'scouting for chinch bugs and thatch', thatch_check: 'scouting for chinch bugs and thatch' }),
    4: L('In April the program focuses on a preventive insect treatment ahead of chinch bug season, plus potassium where a soil test calls for it and weed control when conditions allow.', { insect_prevention: 'a preventive insect treatment ahead of chinch bug season', potassium: 'potassium where a soil test calls for it', broadleaf: 'weed control when conditions allow' }),
    5: L(`In May the program focuses on ${SOIL_FEED}, plus iron and a biostimulant.`, { feed: SOIL_FEED, micros: 'iron and a biostimulant', biostimulant: 'iron and a biostimulant' }),
    6: L('In June the program focuses on checking for chinch bugs and on micronutrients and potassium where a soil test calls for it.', { chinch_check: 'checking for chinch bugs', micros: 'micronutrients and potassium where a soil test calls for it', potassium: 'micronutrients and potassium where a soil test calls for it' }),
    7: L('In July the program focuses on checking for chinch bugs, with summer broadleaf weed control when conditions allow and potassium where the lawn needs it.', { chinch_check: 'checking for chinch bugs', broadleaf: 'summer broadleaf weed control when conditions allow', potassium: 'potassium where the lawn needs it' }),
    8: L('August is a scouting month: the program checks the lawn for chinch bugs and disease, and photographs anything that needs attention.', { scouting_visit: 'checks the lawn for chinch bugs and disease, and photographs anything that needs attention' }),
    9: L('In September the program focuses on potassium where a soil test calls for it and weed control when conditions allow.', { potassium: 'potassium where a soil test calls for it', broadleaf: 'weed control when conditions allow' }),
    10: L(`In October the program focuses on ${FALL_FEED} with iron, plus fall disease control where the lawn needs it and a thatch check.`, { feed: FALL_FEED, micros: 'with iron', fungicide: 'fall disease control where the lawn needs it', thatch_check: 'a thatch check' }),
    11: L('In November the program focuses on micronutrients and potassium where the lawn needs it, plus broadleaf weed control when conditions allow.', { micros: 'micronutrients and potassium where the lawn needs it', potassium: 'micronutrients and potassium where the lawn needs it', broadleaf: 'broadleaf weed control when conditions allow' }),
    12: L('In December the program offers a winter wellness check-in on request.', { winter_touchpoint: 'offers a winter wellness check-in on request' }),
  },
  bermuda: {
    1: L(`In January the program focuses on ${BARRIER}, with broadleaf weed control when conditions allow and a review of any fall disease damage.`, { pre_emergent: BARRIER, broadleaf: 'broadleaf weed control when conditions allow', sds_review: 'a review of any fall disease damage' }),
    2: L('In February the program focuses on a light feeding with iron and micronutrients, plus monitoring for early green-up as Bermuda wakes up late.', { feed: 'a light feeding with iron and micronutrients', micros: 'a light feeding with iron and micronutrients', green_up_watch: 'monitoring for early green-up', late_green_up: 'as Bermuda wakes up late' }),
    3: L(`In March the program focuses on ${BARRIER}, a spring feeding and growth regulation.`, { pre_emergent: BARRIER, feed: 'a spring feeding', growth_regulator: 'growth regulation' }),
    4: L('In April the program focuses on a preventive treatment against armyworms and mole crickets, scouting for both, and growth regulation, with potassium where a soil test calls for it.', { insect_prevention: 'a preventive treatment against armyworms and mole crickets', armyworm_check: 'scouting for both', mole_cricket_check: 'scouting for both', growth_regulator: 'growth regulation', potassium: 'potassium where a soil test calls for it' }),
    5: L(`In May the program focuses on ${SOIL_FEED}, a biostimulant, and growth regulation as needed.`, { feed: SOIL_FEED, biostimulant: 'a biostimulant', growth_regulator: 'growth regulation as needed' }),
    6: L('In June the program focuses on growth regulation, armyworm checks, and micronutrients and potassium where a soil test calls for it.', { growth_regulator: 'growth regulation', armyworm_check: 'armyworm checks', micros: 'micronutrients and potassium where a soil test calls for it', potassium: 'micronutrients and potassium where a soil test calls for it' }),
    7: L('In July the program focuses on growth regulation and summer broadleaf weed control when conditions allow, with armyworm checks as needed.', { growth_regulator: 'growth regulation', broadleaf: 'summer broadleaf weed control when conditions allow', armyworm_check: 'armyworm checks as needed' }),
    8: L('August is a scouting month: the program checks the lawn for armyworms and general condition.', { scouting_visit: 'checks the lawn for armyworms and general condition', armyworm_check: 'checks the lawn for armyworms and general condition' }),
    9: L('In September the program focuses on an armyworm check, growth regulation, potassium where the lawn needs it and broadleaf weed control when conditions allow.', { armyworm_check: 'an armyworm check', growth_regulator: 'growth regulation', potassium: 'potassium where the lawn needs it', broadleaf: 'broadleaf weed control when conditions allow' }),
    10: L(`In October the program focuses on ${FALL_FEED}, a preventive fungicide before soil cools and growth regulation.`, { feed: FALL_FEED, fungicide: 'a preventive fungicide before soil cools', growth_regulator: 'growth regulation' }),
    11: L('In November the program focuses on fall disease prevention and potassium where the lawn needs it.', { fungicide: 'fall disease prevention', potassium: 'potassium where the lawn needs it' }),
    12: L(`In December the program ${WINTER}.`, { winter_touchpoint: WINTER, dormancy_talk: WINTER }),
  },
  zoysia: {
    1: L(`In January the program focuses on ${BARRIER}, with broadleaf weed control when conditions allow and scouting for large patch.`, { pre_emergent: BARRIER, broadleaf: 'broadleaf weed control when conditions allow', large_patch_watch: 'scouting for large patch' }),
    2: L('In February the program focuses on iron and micronutrients as zoysia wakes up late, with large patch disease prevention where needed.', { micros: 'iron and micronutrients', late_green_up: 'as zoysia wakes up late', fungicide: 'large patch disease prevention where needed' }),
    3: L(`In March the program focuses on ${BARRIER} and a spring feeding, with conservative growth regulation as needed and a thatch check.`, { pre_emergent: BARRIER, feed: 'a spring feeding', growth_regulator: 'conservative growth regulation as needed', thatch_check: 'a thatch check' }),
    4: L('In April the program focuses on a preventive treatment and scouting for webworms, the main insect on zoysia, with potassium where the lawn needs it.', { insect_prevention: 'a preventive treatment', webworm_check: 'scouting for webworms', webworm_primary: 'the main insect on zoysia', potassium: 'potassium where the lawn needs it' }),
    5: L(`In May the program focuses on ${SOIL_FEED}, iron and a biostimulant, and light growth regulation as needed.`, { feed: SOIL_FEED, micros: 'iron and a biostimulant', biostimulant: 'iron and a biostimulant', growth_regulator: 'light growth regulation as needed' }),
    6: L('In June the program focuses on webworm checks, light growth regulation as needed, and micronutrients and potassium where a soil test calls for it.', { webworm_check: 'webworm checks', growth_regulator: 'light growth regulation as needed', micros: 'micronutrients and potassium where a soil test calls for it', potassium: 'micronutrients and potassium where a soil test calls for it' }),
    7: L('In July the program focuses on summer broadleaf weed control when conditions allow and light growth regulation as needed.', { broadleaf: 'summer broadleaf weed control when conditions allow', growth_regulator: 'light growth regulation as needed' }),
    8: L('August is a scouting month: the program checks zoysia for disease and webworms.', { scouting_visit: 'checks zoysia for disease and webworms', webworm_check: 'checks zoysia for disease and webworms' }),
    9: L('In September the program focuses on potassium where the lawn needs it and weed control when conditions allow, ahead of October’s large patch treatment.', { potassium: 'potassium where the lawn needs it', broadleaf: 'weed control when conditions allow', large_patch_prep: 'ahead of October’s large patch treatment' }),
    10: L(`In October the program focuses on ${FALL_FEED} and large patch prevention, the most important disease step on zoysia, plus a thatch check.`, { feed: FALL_FEED, fungicide: 'large patch prevention, the most important disease step on zoysia', thatch_check: 'a thatch check' }),
    11: L('In November the program focuses on large patch prevention and potassium where the lawn needs it.', { fungicide: 'large patch prevention', potassium: 'potassium where the lawn needs it' }),
    12: L('In December the program offers a winter check-in on request and a large patch rescue treatment where needed.', { winter_touchpoint: 'offers a winter check-in on request', fungicide: 'a large patch rescue treatment where needed' }),
  },
  bahia: {
    1: L(`In January the program focuses on ${BARRIER}, which matters most on thin bahia, with broadleaf weed control when conditions allow.`, { pre_emergent: BARRIER, thin_turf: 'which matters most on thin bahia', broadleaf: 'broadleaf weed control when conditions allow' }),
    2: L('In February the program focuses on iron and micronutrients where the lawn needs it and a mole cricket check, since mole crickets are the main insect threat to bahia.', { micros: 'iron and micronutrients where the lawn needs it', mole_cricket_check: 'a mole cricket check', mole_cricket_primary: 'since mole crickets are the main insect threat to bahia' }),
    3: L(`In March the program focuses on ${BARRIER} and a spring feeding, with mole cricket checks as needed during their spring flight.`, { pre_emergent: BARRIER, feed: 'a spring feeding', mole_cricket_check: 'mole cricket checks as needed', mole_flight: 'during their spring flight' }),
    4: L('In April the program focuses on a preventive treatment against mole cricket nymphs, plus potassium where it fits the property and weed control when conditions allow.', { insect_prevention: 'a preventive treatment against mole cricket nymphs', potassium: 'potassium where it fits the property', broadleaf: 'weed control when conditions allow' }),
    5: L('In May the program focuses on iron, micronutrients and potassium where it fits the property, plus crabgrass checks as needed.', { micros: 'iron, micronutrients and potassium where it fits the property', potassium: 'iron, micronutrients and potassium where it fits the property', crabgrass_watch: 'crabgrass checks as needed' }),
    6: L('In June the program focuses on a mole cricket check, since damage shows as spongy, lifted turf, plus micronutrients and potassium where it fits the property.', { mole_cricket_check: 'a mole cricket check', mole_damage_signs: 'since damage shows as spongy, lifted turf', micros: 'micronutrients and potassium where it fits the property', potassium: 'micronutrients and potassium where it fits the property' }),
    7: L('In July the program focuses on broadleaf weed control when conditions allow, with an explanation of normal summer seed heads where helpful.', { broadleaf: 'broadleaf weed control when conditions allow', seed_heads: 'an explanation of normal summer seed heads where helpful' }),
    8: L('August is a scouting month: the program checks bahia for mole cricket damage, which peaks now, and for general condition.', { scouting_visit: 'checks bahia for mole cricket damage, which peaks now, and for general condition', mole_cricket_check: 'checks bahia for mole cricket damage, which peaks now, and for general condition' }),
    9: L('In September the program focuses on potassium where it fits the property, broadleaf weed control when conditions allow, and watching for crabgrass breakthrough.', { potassium: 'potassium where it fits the property', broadleaf: 'broadleaf weed control when conditions allow', crabgrass_watch: 'watching for crabgrass breakthrough' }),
    10: L(`In October the program focuses on ${FALL_FEED} with iron, plus treatment for mole crickets or disease where needed.`, { feed: FALL_FEED, micros: 'with iron', fungicide: 'treatment for mole crickets or disease where needed', mole_cricket_treat: 'treatment for mole crickets or disease where needed' }),
    11: L('In November the program focuses on potassium where it fits the property and broadleaf weed control when conditions allow.', { potassium: 'potassium where it fits the property', broadleaf: 'broadleaf weed control when conditions allow' }),
    12: L(`In December the program ${WINTER}.`, { winter_touchpoint: WINTER, dormancy_talk: WINTER }),
  },
};

// Unknown, mixed or missing grass: only what holds in all four programs that month.
const DEFAULT_LINES = {
  1: L(`In January the program focuses on ${BARRIER}, with broadleaf weed control when conditions allow.`, { pre_emergent: BARRIER, broadleaf: 'broadleaf weed control when conditions allow' }),
  2: L('In February the program focuses on iron and micronutrients where the lawn needs it.', { micros: 'iron and micronutrients where the lawn needs it' }),
  3: L(`In March the program focuses on ${BARRIER} and a spring feeding.`, { pre_emergent: BARRIER, feed: 'a spring feeding' }),
  4: L('In April the program focuses on a preventive insect treatment, plus potassium where the lawn needs it and weed control when conditions allow.', { insect_prevention: 'a preventive insect treatment', potassium: 'potassium where the lawn needs it', broadleaf: 'weed control when conditions allow' }),
  5: L('In May the program focuses on iron and micronutrients where the lawn needs it.', { micros: 'iron and micronutrients where the lawn needs it' }),
  6: L('In June the program focuses on insect checks and on micronutrients and potassium where the lawn needs it.', { insect_check: 'insect checks', micros: 'micronutrients and potassium where the lawn needs it', potassium: 'micronutrients and potassium where the lawn needs it' }),
  7: L('In July the program focuses on summer broadleaf weed control when conditions allow.', { broadleaf: 'summer broadleaf weed control when conditions allow' }),
  8: L('August is a scouting month: the program checks the lawn for insect activity and general condition.', { scouting_visit: 'checks the lawn for insect activity and general condition' }),
  9: L('In September the program focuses on potassium where the lawn needs it and weed control when conditions allow.', { potassium: 'potassium where the lawn needs it', broadleaf: 'weed control when conditions allow' }),
  10: L(`In October the program focuses on ${FALL_FEED} and disease control where needed.`, { feed: FALL_FEED, fungicide: 'disease control where needed' }),
  11: L('In November the program focuses on potassium where the lawn needs it and broadleaf weed control when conditions allow.', { potassium: 'potassium where the lawn needs it', broadleaf: 'broadleaf weed control when conditions allow' }),
  12: L('In December the program offers a winter check-in on request.', { winter_touchpoint: 'offers a winter check-in on request' }),
};

function grassKeyFor(grassType) {
  const key = String(grassType || '').toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '');
  return Object.prototype.hasOwnProperty.call(PROGRAM_LINES, key) ? key : null;
}

// Month numbers (1-12) the protocol carries a visit for, for one grass key.
function protocolMonths(grassKey) {
  const visits = protocols && protocols.lawn && protocols.lawn[grassKey] && protocols.lawn[grassKey].visits;
  if (!Array.isArray(visits)) return new Set();
  return new Set(visits.map((v) => MONTH_ABBR.indexOf(String(v && v.month).slice(0, 3)) + 1).filter((m) => m >= 1));
}

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
 * @param {{ grassType?: string|null, month?: number|null, applications?: object[], nitrogenApplied?: boolean|null, programVisit?: boolean }} input
 *   programVisit must be true (a recurring lawn plan visit, see resolveProgramVisit);
 *   anything else, including omitted, returns null.
 *   nitrogenApplied is the caller's catalog-backed answer (report-data reads
 *   analysis_n); null means derive it from `applications`. month is the visit's
 *   calendar month (1-12), already computed at a noon-UTC anchor by the report builder.
 * @returns {string|null} the program line, or null when there is no honest line
 *   (not a plan visit, no valid month, a month the grass's protocol has no visit
 *   for, or a Jun-Sep visit that applied nitrogen).
 */
function buildProgramLine({ grassType = null, month = null, applications = [], nitrogenApplied = null, programVisit = false } = {}) {
  if (programVisit !== true) return null;
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (NO_NITROGEN_MONTHS.has(m) && (nitrogenApplied === null ? appliedNitrogen(applications) : nitrogenApplied === true)) return null;
  const grassKey = grassKeyFor(grassType);
  if (grassKey) {
    if (!protocolMonths(grassKey).has(m)) return null;
    return PROGRAM_LINES[grassKey][m].line;
  }
  return DEFAULT_LINES[m].line;
}

module.exports = {
  buildProgramLine,
  PROGRAM_LINES,
  DEFAULT_LINES,
  QUALIFIERS,
  NO_NITROGEN_MONTHS,
  grassKeyFor,
  protocolMonths,
  appliedNitrogen,
  resolveNitrogenApplied,
  resolveProgramVisit,
};
