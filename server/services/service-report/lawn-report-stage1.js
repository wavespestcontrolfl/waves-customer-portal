'use strict';

/**
 * GATE_LAWN_REPORT_STAGE1_FIXES (owner 2026-10-09): five small fixes found on one real lawn report, kept apart from
 * the builders they correct so those builders gain no decisions. The gate is read here, at call time, and only ever
 * for a lawn report.
 *
 *   1. applyStage1Fixes(v2, args)   the damage finding names the pest a spot insecticide row targeted
 *   2. stage1ExpectPlan(rows, ...)   lawn-copy-v6.js asks which row prints as the SECOND "What to expect" line
 *   3. stage1TechTips(tips, ...)     a frozen "add your irrigation settings" tip is left off beside a schedule on file
 *   4. (client) the web page leaves out the "What we applied today" card that repeats Today's result
 *   5. (client) the web hero leaves out the customer's email and phone
 *   stage1PayloadFlag / stage1PdfStamp   the payload key the page reads and the PDF cache-key part
 *
 * No sentence is written here. Every customer sentence comes from a table that already exists: the Visit Summary's own
 * technician-find sentence (lawn-visit-summary.js SENTENCE.tieTech), the owner-approved expectation rows
 * (config/lawn-expectations.js) and the tip library's frozen copy. Gate off: every export is a no-op or the old value,
 * so the payload, render, PDF and PDF cache key are byte-identical. Pure. No database read, no model call.
 */

const featureGates = require('../../config/feature-gates');

// A partial feature-gates mock (a test) means off, never a crash in a report build.
function stage1Live() {
  return typeof featureGates.lawnReportStage1FixesLive === 'function' && featureGates.lawnReportStage1FixesLive();
}

/**
 * The PDF cache-key part. The gate itself moves the key (':s1=1'). The "What to expect" second line is also FROZEN in the
 * v6 copy (structured_notes.lawnCopyV6[assessment].stage1Expect), and a render replays it whatever the gate says, so a
 * record that carries a frozen stage 1 entry keeps a key part after the gate is unset (':s1f=1'): a PDF cached before the
 * flip is never served for a document that now prints the second line. Pure; `notes` is the record's structured_notes.
 */
function stage1PdfStamp(notes = null) {
  if (stage1Live()) return ':s1=1';
  return frozenStage1Expect(notes) ? ':s1f=1' : '';
}

/** True when any frozen v6 copy entry of the record carries the stage 1 marker. */
function frozenStage1Expect(notes) {
  let value = notes;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return false; }
  }
  const map = value && typeof value === 'object' ? value.lawnCopyV6 : null;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  return Object.values(map).some((entry) => entry && typeof entry === 'object' && entry.stage1Expect === true);
}

/**
 * The key part for a render: from the SAME service row the render loads when it carries structured_notes, from the
 * record only for a partial lookup row (and only while the gate is off: a live gate needs no read). An unreadable record
 * stamps a one-off value (re-render, never a stale hit).
 */
async function stage1KeyStamp(service, knex) {
  if (stage1Live()) return ':s1=1';
  try {
    const notes = service && Object.prototype.hasOwnProperty.call(service, 'structured_notes')
      ? service.structured_notes
      : (await knex('service_records').where({ id: service.id }).first('structured_notes'))?.structured_notes;
    return stage1PdfStamp(notes);
  } catch {
    return `:s1f=err${require('crypto').randomBytes(4).toString('hex')}`;
  }
}

/** The payload key the web page reads (applied card, hero contact lines): lawn only. */
function stage1PayloadFlag(serviceLine) {
  return serviceLine === 'lawn' && stage1Live() ? { lawnStage1Fixes: true } : {};
}

const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

// The same normalization the completion route uses for a stored method, without loading that module when a plain
// value is enough. A row is a spot row when its method reads spot_treatment ("Spot treatment", "spot_spray").
function isSpotMethod(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) return false;
  if (normalized === 'spot_treatment') return true;
  if (/trunk|inject|foliar|pin|granular|bait|gel|glue|station|fog|ulv|broadcast|perimeter|band/.test(normalized)) return false;
  return normalized.includes('spot');
}

const INSECTICIDE_FAMILY = 'insecticide';

// ── 1. The damage finding names the pest ────────────────────────────────────

// Which Visit Summary technician-find phrase a recorded target stands for (lawn-visit-summary.js TECH_FOUND_PHRASES).
// A target outside this list (white grubs, mole crickets, fire ants, a weed, a fungus) names no pest the Visit
// Summary has a sentence for, so the finding is left as it was.
function pestKindOfTarget(target) {
  const text = String(target || '');
  if (/\bchinch\b/i.test(text)) return 'chinch';
  if (/caterpillar|armyworm|webworm/i.test(text)) return 'caterpillars';
  return null;
}

function appMethod(app) {
  return app && (app.method ?? app.applicationMethod ?? app.application_method);
}

function appProductName(app) {
  const product = (app && app.product) || {};
  const facts = (app && app.approved_report_product_facts) || {};
  return clean(product.name) || clean(app && app.product_name) || clean(facts.name);
}

// The spot area the row may state. A frozen spot text ("Spot treatment, about 500 sq ft", GATE_LAWN_REPORT_FACTS) is
// the only sure source on a lawn Fast Complete sheet row, whose areaValue can be a whole-lawn fallback, so a frozen
// text with no figure means no figure. A row with no frozen text uses its recorded area when the unit is square feet.
function spotSqft(app) {
  const frozen = clean(app && app.areaUse);
  if (frozen) {
    const match = /about\s+([\d,]+)\s+sq\s*ft/i.exec(frozen);
    const value = match ? Number(match[1].replace(/,/g, '')) : null;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const value = num(app && (app.areaValue ?? app.area_value));
  const unit = String((app && (app.areaUnit ?? app.area_unit)) || '').toLowerCase().replace(/[^a-z]/g, '');
  return value != null && value > 0 && (unit === 'sqft' || unit === 'squarefeet') ? value : null;
}

// The expectation table's own mode for a product (config/lawn-expectations.js): a product locked to "preventive"
// (Acelepryn) is never a treatment of a finding, so it never produces a "found and treated" sentence. A product the table
// does not map has no known mode, so it counts as none. Curative = in the insecticide family and not preventive-locked.
function isCurativeInsecticide(name) {
  const { classifyLawnProduct } = require('./lawn-expectations');
  const cls = classifyLawnProduct(name);
  return Boolean(cls) && cls.family === INSECTICIDE_FAMILY && cls.modeLock !== 'preventive';
}

/**
 * The first spot insecticide row whose recorded target is a known pest, or null:
 * { kind: 'chinch' | 'caterpillars', app, sqft }. A row with an inferred method (a legacy row) is never a spot row, and a
 * row whose product the expectation table locks to preventive mode never counts.
 */
function targetedSpotInsecticide(applications, classifyProduct) {
  for (const app of Array.isArray(applications) ? applications : []) {
    if (!app || app.methodInferred === true || !isSpotMethod(appMethod(app))) continue;
    if (classifyProduct(app).kind !== 'insecticide') continue;
    if (!isCurativeInsecticide(appProductName(app))) continue;
    const targets = Array.isArray(app.targets) ? app.targets : [];
    const kind = targets.map(pestKindOfTarget).find(Boolean);
    if (kind) return { kind, app, sqft: spotSqft(app) };
  }
  return null;
}

const upperFirst = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The damage finding's words for a pest the visit's spot insecticide targeted:
 *   headline      "Chinch bug damage in one area — treated today"
 *   whatWeSaw     the Visit Summary's own sentence ("Your technician found chinch bugs and treated that spot today.")
 *   wavesAction   "Applied <product> to about 500 sq ft." only when the spot area is recorded; the product CATEGORY
 *                 phrase stands for the name while GATE_LAWN_REPORT_COPY_FIXES is live (no product name in a sentence)
 * Returns null when the visit has no such row.
 */
function damageWords(applications, classifyProduct) {
  const hit = targetedSpotInsecticide(applications, classifyProduct);
  if (!hit) return null;
  const { SENTENCE, TECH_FOUND_PHRASES, TIE_PRODUCT_PHRASES } = require('./lawn-visit-summary');
  const found = TECH_FOUND_PHRASES[hit.kind];
  if (!found) return null;
  // "chinch bugs" -> "Chinch bug damage"; "caterpillars" -> "Caterpillar damage".
  const noun = upperFirst(found.replace(/s$/, ''));
  const words = {
    headline: `${noun} damage in one area — treated today`,
    whatWeSaw: SENTENCE.tieTech(found),
    wavesAction: null,
  };
  if (hit.sqft != null) {
    const copyFixes = typeof featureGates.lawnReportCopyFixesLive === 'function' && featureGates.lawnReportCopyFixesLive();
    const area = Math.round(hit.sqft).toLocaleString('en-US');
    const name = copyFixes ? null : appProductName(hit.app);
    // The catalog name is staff-edited text: the composed sentence goes through the same full customer-copy screen the other
    // sentence composers use (banned wording, access codes), and a name that fails it falls back to the category phrase.
    const named = name ? `Applied ${name} to about ${area} sq ft.` : null;
    const { customerCopyViolations } = require('./technician-report-copy');
    words.wavesAction = named && customerCopyViolations(named).length === 0 && customerCopyViolations(name).length === 0
      ? named
      : `Applied ${TIE_PRODUCT_PHRASES.insecticide} to about ${area} sq ft.`;
  }
  return words;
}

/**
 * Runs after buildLawnReportV2's own build (the exported builder calls it): the damage insight takes the words above
 * and the snapshot's watch list repeats the new headline. nextVisitPlan, whyItMatters and the card's status stay.
 * Mutates and returns the report; a no-op while the gate is off or when no damage finding is on the report.
 */
function applyStage1Fixes(v2, args, classifyProduct) {
  if (!v2 || !stage1Live()) return v2;
  const insights = Array.isArray(v2.insights) ? v2.insights : [];
  const damage = insights.find((card) => card && card.category === 'damage');
  if (!damage) return v2;
  const words = damageWords(args && args.applications, classifyProduct);
  if (!words) return v2;
  const before = damage.headline;
  damage.headline = words.headline;
  damage.whatWeSaw = words.whatWeSaw;
  if (words.wavesAction) damage.wavesAction = words.wavesAction;
  if (v2.snapshot && Array.isArray(v2.snapshot.watching)) {
    v2.snapshot.watching = v2.snapshot.watching.map((line) => (line === before ? words.headline : line));
  }
  return v2;
}

// ── 2. A second "What to expect" line ───────────────────────────────────────

// The expectation rows that can print second, in priority order, by the engine's row family: the insecticide row when
// a spot insecticide was applied, else the feeding row. Both families already exist in config/lawn-expectations.js.
const FEED_FAMILIES = Object.freeze(['granular_fertilizer', 'potassium_feed']);

const hasLine = (row, key) => Boolean(row && Array.isArray(row.sentences) && row.sentences.some((s) => s && s.key === key && clean(s.text)));

/**
 * Which row prints as the SECOND "What to expect" line: { first, second } or null.
 *   first   the engine's primary row (the weed line when a herbicide was applied), unchanged
 *   second  the insecticide row when the visit had a spot insecticide, else the feeding row; its own
 *           visible-change sentence only, one line
 * null = no second row to add; the caller keeps the engine's own selection.
 * `products` are the report's treatment products ({ kind, method }).
 */
function stage1ExpectPlan(rows, products) {
  if (!stage1Live()) return null;
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && hasLine(row, 'visibleChange'));
  if (list.length < 2) return null;
  const first = list[0];
  const spotInsecticide = (Array.isArray(products) ? products : [])
    .some((p) => p && p.kind === 'insecticide' && isSpotMethod(p.method));
  // The insecticide line is the CURATIVE row only (owner 2026-10-09): a spot insecticide with no target, or a product the
  // table locks to preventive, gets no insecticide line and the feeding row is considered instead.
  const wanted = [
    ...(spotInsecticide ? [(row) => row.id === 'insecticide_curative'] : []),
    ...FEED_FAMILIES.map((family) => (row) => row.family === family),
  ];
  for (const matches of wanted) {
    const second = list.find((row) => row !== first && matches(row));
    if (second) return { first, second };
  }
  return null;
}

// ── 3. No irrigation-settings tip beside a schedule on file ─────────────────

const IRRIGATION_PORTAL_TIP = 'lawn_irrigation_portal';

/**
 * True when the report's Water card says a sprinkler schedule is on file: weekly inches ('inches') or run minutes and/or
 * watering days ('runtime_only', which exists only while GATE_LAWN_REPORT_POLISH is live). Without the polish key the
 * card's own flag stands (scheduleOnFile, true when weekly inches are known).
 */
function scheduleIsOnFile(water) {
  if (!water || typeof water !== 'object') return false;
  if (water.scheduleKind) return water.scheduleKind === 'inches' || water.scheduleKind === 'runtime_only';
  return water.scheduleOnFile === true;
}

/**
 * The frozen technician tips the report may carry. The tip that asks the customer to add irrigation settings is left off
 * while the Water card says a schedule is on file; the technician's other tip (one is allowed a visit) is untouched.
 * The same array comes back whenever nothing changes.
 */
function stage1TechTips(tips, { serviceLine, reportV2 } = {}) {
  if (serviceLine !== 'lawn' || !stage1Live() || !Array.isArray(tips)) return tips;
  if (!scheduleIsOnFile(reportV2 && reportV2.water)) return tips;
  const kept = tips.filter((tip) => !(tip && tip.id === IRRIGATION_PORTAL_TIP));
  return kept.length === tips.length ? tips : kept;
}

module.exports = {
  stage1Live,
  stage1PdfStamp,
  stage1KeyStamp,
  frozenStage1Expect,
  stage1PayloadFlag,
  isSpotMethod,
  pestKindOfTarget,
  damageWords,
  applyStage1Fixes,
  stage1ExpectPlan,
  scheduleIsOnFile,
  stage1TechTips,
  IRRIGATION_PORTAL_TIP,
};
