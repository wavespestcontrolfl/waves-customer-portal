/**
 * Lawn monthly program line (lawn report rebuild P9, GATE_LAWN_EXPECTATIONS).
 *
 * One calendar-based, tier-neutral sentence about what this month's visit in the
 * program does, written from what server/config/protocols.json says for that
 * grass and month. It replaces the generic peak/shoulder/dormant season note in
 * snapshot.seasonalNote while the gate is live.
 *
 * Rules the copy keeps (pinned by server/tests/lawn-program-line.test.js):
 *   - program-level: "this month in the program", never a promise about one
 *     product, a tier, a rate, a date or a clock time;
 *   - no product or brand name, no ordinance / county / blackout / law wording;
 *   - no watering, rain, irrigation or mowing instruction (the banner and the
 *     water card own those);
 *   - every claim is backed by a `tags` entry that the test proves against the
 *     protocols.json visit for that grass and month, so no treatment is invented.
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

const L = (tags, line) => ({ tags, line });

// month number (1-12) -> { tags, line }, per grass. `tags` name the protocol
// facts the sentence relies on; the test maps each tag to evidence in the
// protocols.json visit for that grass and month.
const PROGRAM_LINES = {
  st_augustine: {
    1: L(['pre_emergent', 'broadleaf'], 'January starts the weed barrier with the first of two pre-emergent applications, and we spot-treat winter broadleaf weeds.'),
    2: L(['feed', 'micros'], 'February gives the lawn a light feeding with iron and micronutrients to support color as it wakes up from winter.'),
    3: L(['pre_emergent', 'feed', 'scout'], 'March completes the pre-emergent weed barrier, adds a spring feeding and starts our scouting for chinch bugs and thatch buildup.'),
    4: L(['insect_prevention', 'broadleaf', 'potassium'], 'April puts down a preventive insect treatment ahead of chinch bug season, adds potassium and treats broadleaf weeds once the lawn has greened up.'),
    5: L(['feed', 'micros', 'biostimulant'], 'May gives a spring feeding with iron and a biostimulant to prepare the lawn for summer stress.'),
    6: L(['potassium', 'micros', 'scout'], 'June adds potassium and micronutrients for summer stress tolerance and starts our checks for chinch bugs.'),
    7: L(['broadleaf', 'potassium', 'scout'], 'July treats summer broadleaf weeds, adds potassium and re-checks for chinch bugs.'),
    8: L(['scout'], 'August is a scouting month: we check the lawn for chinch bugs, disease and stress, and photograph anything that needs attention.'),
    9: L(['potassium', 'broadleaf'], 'September adds potassium and controls fall weeds as the season turns, getting the lawn ready for fall disease prevention.'),
    10: L(['feed', 'fungicide', 'micros'], 'October gives the final feeding of the year, with iron and a preventive fungicide against fall disease such as large patch.'),
    11: L(['potassium', 'micros', 'broadleaf'], 'November adds potassium and micronutrients for winter hardiness and treats winter weeds when conditions are right.'),
    12: L(['winter'], 'December is a winter check-in: we look over how the lawn is resting and plan the weed barrier for January.'),
  },
  bermuda: {
    1: L(['pre_emergent', 'broadleaf', 'dormancy'], 'January starts the weed barrier with the first pre-emergent application and treats broadleaf weeds, while we note any fall disease damage on the dormant turf.'),
    2: L(['feed', 'micros', 'scout'], 'February gives a light feeding with iron and micronutrients as Bermuda begins to wake up, and we watch for early green-up.'),
    3: L(['pre_emergent', 'feed', 'growth_regulator'], 'March completes the pre-emergent weed barrier, adds a spring feeding and starts the growth-regulation cycle that keeps Bermuda dense and tidy.'),
    4: L(['insect_prevention', 'broadleaf', 'growth_regulator', 'potassium'], 'April brings a preventive treatment against armyworms and mole crickets, weed control, potassium and the next growth-regulation cycle.'),
    5: L(['feed', 'micros', 'biostimulant', 'growth_regulator'], 'May gives a spring feeding with iron and a biostimulant and continues growth regulation to keep Bermuda dense.'),
    6: L(['potassium', 'growth_regulator', 'scout'], 'June adds potassium, continues growth regulation and checks for armyworms, which become more active in summer.'),
    7: L(['broadleaf', 'growth_regulator', 'scout'], 'July treats summer broadleaf weeds, continues growth regulation and re-checks for armyworm activity.'),
    8: L(['scout'], 'August is a scouting month: we check for armyworms, mole crickets and stress across the lawn, and photograph anything that needs attention.'),
    9: L(['potassium', 'broadleaf', 'scout', 'growth_regulator'], 'September adds potassium, controls broadleaf weeds and makes a final check for fall armyworms as growth regulation winds down.'),
    10: L(['feed', 'fungicide', 'growth_regulator'], 'October gives the final feeding of the year, applies a preventive fungicide before soil cools and wraps up growth regulation.'),
    11: L(['fungicide', 'potassium', 'broadleaf'], 'November repeats the fall disease prevention and adds potassium for winter hardiness as Bermuda heads toward dormancy.'),
    12: L(['winter', 'dormancy'], 'December is a winter check-in: Bermuda turns brown and dormant in cool weather, which is normal, and we plan the weed barrier for January.'),
  },
  zoysia: {
    1: L(['pre_emergent', 'broadleaf', 'scout'], 'January starts the weed barrier with the first pre-emergent application and treats broadleaf weeds, and we scout for large patch, the main disease risk on zoysia.'),
    2: L(['micros', 'fungicide'], 'February adds iron and micronutrients as zoysia slowly wakes up, with disease prevention continuing where large patch is active.'),
    3: L(['pre_emergent', 'feed', 'growth_regulator', 'fungicide'], 'March completes the pre-emergent weed barrier, adds a spring feeding and starts conservative growth regulation as the window for large patch prevention closes.'),
    4: L(['insect_prevention', 'broadleaf', 'potassium', 'scout'], 'April brings a preventive treatment against webworms, the main insect on zoysia, plus weed control and potassium.'),
    5: L(['feed', 'micros', 'biostimulant', 'growth_regulator'], 'May gives a spring feeding with iron and a biostimulant, and keeps growth regulation conservative so zoysia stays dense.'),
    6: L(['potassium', 'growth_regulator', 'scout'], 'June adds potassium, keeps growth regulation light and checks for webworms.'),
    7: L(['broadleaf', 'growth_regulator'], 'July treats summer broadleaf weeds and keeps growth regulation light to protect zoysia density.'),
    8: L(['scout'], 'August is a scouting month: we check zoysia for disease, webworms and stress, and photograph anything that needs attention.'),
    9: L(['potassium', 'broadleaf'], 'September adds potassium, controls weeds and prepares zoysia for the large patch prevention that starts in October.'),
    10: L(['feed', 'fungicide'], 'October gives the final feeding of the year and starts large patch prevention, the most important disease step on zoysia.'),
    11: L(['fungicide', 'potassium'], 'November continues large patch prevention with a different fungicide group and adds potassium for winter hardiness.'),
    12: L(['winter', 'fungicide'], 'December is a winter check-in, with a rescue treatment if large patch is active and a look at how the lawn is resting.'),
  },
  bahia: {
    1: L(['pre_emergent', 'broadleaf'], 'January starts the weed barrier with the first pre-emergent application, which matters most on thin bahia, and treats winter broadleaf weeds.'),
    2: L(['micros', 'scout'], 'February adds iron and micronutrients and starts our checks for mole crickets, the main insect threat to bahia.'),
    3: L(['pre_emergent', 'feed', 'scout'], 'March completes the pre-emergent weed barrier, adds a spring feeding and continues mole cricket checks during their spring flight.'),
    4: L(['insect_prevention', 'broadleaf', 'potassium'], 'April brings a preventive treatment against mole cricket nymphs, plus weed control and potassium where it fits the lawn.'),
    5: L(['micros', 'crabgrass_watch'], 'May adds iron and micronutrients and checks for crabgrass breaking through the pre-emergent barrier.'),
    6: L(['potassium', 'micros', 'scout'], 'June adds potassium and micronutrients and checks for mole cricket damage, which shows as spongy, lifted turf.'),
    7: L(['broadleaf', 'seed_heads'], 'July is a lighter month for bahia: seed heads are normal in summer, and we treat weeds only when conditions are safe for the turf.'),
    8: L(['scout'], 'August is a scouting month: mole cricket damage peaks now, so we check the lawn and photograph anything that needs attention.'),
    9: L(['potassium', 'broadleaf', 'crabgrass_watch'], 'September adds potassium, treats broadleaf weeds only when conditions are safe for bahia and checks for crabgrass breakthrough.'),
    10: L(['feed', 'conditional_treatment'], 'October gives the second and final feeding of the year and adds a treatment only where mole crickets or disease are active.'),
    11: L(['broadleaf', 'potassium'], 'November controls winter broadleaf weeds and adds potassium for winter hardiness.'),
    12: L(['winter', 'dormancy'], 'December is a winter check-in: bahia goes dormant and looks brown in cool weather, which is normal, and we plan the weed barrier for January.'),
  },
};

// Unknown, mixed or missing grass: only what is true in all four programs that month.
const DEFAULT_LINES = {
  1: L(['pre_emergent', 'broadleaf'], 'January starts the weed barrier with the first pre-emergent application, and we treat winter broadleaf weeds.'),
  2: L(['micros'], 'February adds iron and micronutrients to support color as the lawn wakes up from winter.'),
  3: L(['pre_emergent', 'feed'], 'March completes the pre-emergent weed barrier and adds a spring feeding.'),
  4: L(['insect_prevention', 'broadleaf', 'potassium'], 'April brings a preventive insect treatment, weed control and potassium for the growing season.'),
  5: L(['micros'], 'May adds iron and micronutrients to support color through summer stress.'),
  6: L(['potassium', 'micros', 'scout'], 'June adds potassium and micronutrients for summer stress tolerance, and we check for insect activity.'),
  7: L(['broadleaf'], 'July treats summer broadleaf weeds where conditions are safe for the turf.'),
  8: L(['scout'], 'August is a scouting month: we check the lawn for insects, disease and stress, and photograph anything that needs attention.'),
  9: L(['potassium', 'broadleaf'], 'September adds potassium and controls weeds as the season turns.'),
  10: L(['feed', 'fungicide'], 'October gives the final feeding of the year, with a preventive disease treatment where the grass calls for it.'),
  11: L(['potassium', 'broadleaf'], 'November adds potassium for winter hardiness and treats winter weeds when conditions are right.'),
  12: L(['winter'], 'December is a winter check-in: we look over how the lawn is resting and plan the weed barrier for January.'),
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

/**
 * The report-data caller's nitrogen answer for the program line. Only positive
 * evidence clears it: a catalog analysis_n > 0, or the name/application check
 * for products the catalog cannot resolve. A failed product load or catalog
 * read counts as nitrogen applied (no line beats a wrong line).
 * @param {{ applications?: object[], productsLoadFailed?: boolean, loadCatalogRows: (ids: string[]) => Promise<object[]> }} input
 * @returns {Promise<boolean>}
 */
async function resolveNitrogenApplied({ applications = [], productsLoadFailed = false, loadCatalogRows }) {
  if (productsLoadFailed) return true;
  const apps = Array.isArray(applications) ? applications : [];
  try {
    const ids = [...new Set(apps.map((app) => app && app.product && app.product.catalogId).filter(Boolean))];
    const rows = ids.length ? await loadCatalogRows(ids) : [];
    return (Array.isArray(rows) ? rows : []).some((row) => Number(row && row.analysis_n || 0) > 0)
      || appliedNitrogen(apps);
  } catch {
    return true;
  }
}

/**
 * @param {{ grassType?: string|null, month?: number|null, applications?: object[], nitrogenApplied?: boolean|null }} input
 *   nitrogenApplied is the caller's catalog-backed answer (report-data reads
 *   analysis_n); null means derive it from `applications`. month is the visit's calendar month (1-12), already computed at a noon-UTC
 *   anchor by the report builder.
 * @returns {string|null} the program line, or null when there is no honest line
 *   (no valid month, a month the grass's protocol has no visit for, or a Jun-Sep
 *   visit that applied nitrogen).
 */
function buildProgramLine({ grassType = null, month = null, applications = [], nitrogenApplied = null } = {}) {
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
  NO_NITROGEN_MONTHS,
  grassKeyFor,
  protocolMonths,
  appliedNitrogen,
  resolveNitrogenApplied,
};
