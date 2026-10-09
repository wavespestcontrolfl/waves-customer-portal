'use strict';

/**
 * GATE_LAWN_REPORT_FACTS (owner 2026-10-08): three facts of the customer LAWN report that are
 * DECIDED ONCE at completion, frozen on the record, and only READ afterwards.
 *
 *   1. reentry     "Ready to walk on" is a CONDITION from the products applied, not a 30 minute clock.
 *   2. productUse  a spot product says where it was used ("Spot treatment, about 250 sq ft").
 *   3. ties        a photo finding (or the technician's tap) is tied to what was applied, in one
 *                  fixed sentence (the sentences live in lawn-visit-summary.js) and the product's
 *                  "What to expect" line follows the tie (lawn-expectations.js).
 *
 * Lesson of #6087 and #6089: a decision that changes at RENDER time by a gate races the stored-PDF
 * cache and never converges in review. So the gate controls ONLY the freeze (the lawn write gate,
 * lawn-report-write-gate.js). Every reader below takes the record's structured_notes and never
 * reads a gate: a record that carries a frozen decision renders it whatever the gate says, and a
 * record without one renders exactly as before. The PDF key carries the frozen decision
 * (frozenReportFactsStamp, ':rf=').
 *
 * structured_notes.lawnReportFacts = {
 *   v: 1, frozenAt,
 *   reentry: { rule: 'dry' | 'watered_in_and_dry' | 'default', source: 'facts' | 'default',
 *              products: [{ id, rule, source }] },
 *   productUse: { [service_products.id]: { sqft: number | null } },   // spot rows only
 *   ties: { assessmentId, items: [...] },       // see cleanTies
 * }
 *
 * Only structured facts are stored. Every customer sentence is chosen by code from the closed tables
 * below at read time, so a hand-edited row prints nothing it was not built from.
 *
 * Pure except freezeReportFacts / gatherAndFreezeReportFacts (the writes and reads).
 */

const crypto = require('crypto');
const logger = require('../logger');
const { CONDITION_LABEL_VALUES } = require('../lawn-diagnostic-report');

const FREEZE_KEY = 'lawnReportFacts';
const FREEZE_VERSION = 1;

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

const isPlain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ── 1. Re-entry: the closed tables ──────────────────────────────────────────

// Strictest last. Only two conditions exist; anything else is the marked 'default' (today's behavior).
const RULES = Object.freeze(['dry', 'watered_in_and_dry']);
const RANK = Object.freeze({ dry: 1, watered_in_and_dry: 2 });
const SOURCES = Object.freeze(['facts', 'default']);

// AGENTS.md (customer-surface compliance): the re-entry idiom is "once dry" + the technician confirms timing. The
// clause is the one the report already prints on its non-live / printed record, word for word:
// REENTRY_SAFE_COPY 'Ready once dry — your technician confirms timing.' (server/services/social-media.js:2848,
// client/src/pages/ServiceReportDocument.jsx:246, and its per-target line at :280). One fixed clause, shared by
// both rules, and it carries no figure and no "safe".
const TECHNICIAN_CONFIRMS = 'your technician confirms timing';
const REENTRY_TEXT = Object.freeze({
  dry: `Ready to walk on once the application has dried — ${TECHNICIAN_CONFIRMS}.`,
  watered_in_and_dry: `Ready to walk on once today’s treatment has dried and, after you water it in, the grass is dry again — ${TECHNICIAN_CONFIRMS}.`,
});
const REENTRY_PETS = 'Keep people and pets off the lawn until then.';
const REENTRY_STATUS = Object.freeze({ dry: 'Once dry', watered_in_and_dry: 'After watering in' });

// The application method as the report payload normalizes it (methodFromProduct).
function methodOf(row) {
  const raw = String((row && (row.application_method || row.method)) || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return raw && raw !== 'null' ? raw : '';
}

const isGranular = (method) => method.includes('granular');
const isBait = (method) => method.includes('bait') || method === 'station_check';

// Whether the product's own frozen label says plain "until dry" and nothing longer. The label floor of a
// product is what the report shows today (the label re-entry line, and a fixed hours figure when it states
// one); our condition may never be weaker than it. So the condition stands only on positive evidence:
// the frozen re-entry text reads as a plain until-dry sentence and no positive figure is stored. A stored
// positive rei_hours, a text that states hours, a text we cannot read, and NO text at all (the snapshot
// freezes a catalog NULL as 0, indistinguishable from the residential "until dry" 0, sms-label-facts.js
// frozenReiHours) are all "not plain until dry".
function labelIsPlainUntilDry(facts) {
  const hours = Number(facts && facts.reentryHours);
  if (Number.isFinite(hours) && hours > 0) return false;
  const text = facts && facts.reentrySummary;
  if (!text) return false;
  try {
    const { parseReentryText } = require('../sms-label-facts');
    const parsed = parseReentryText(text);
    return !!parsed && parsed.kind === 'until_dry';
  } catch { return false; }
}

// The second accepted label shape, "plain until watered in and dry": the standard sentence for a granule the
// program waters in ("Stay off treated areas until the product has been watered in and the turf is dry."). The
// shared SMS parser (sms-label-facts.js, not changed) does not read it, so it is recognized here, narrowly: the
// WHOLE text must be one sentence that says to stay off until the product / application / treatment / granules
// has (have) been watered in and the turf / grass / lawn / surface is dry (or has dried). It must carry no
// digit and no time word anywhere (an hours figure makes it a different label), and no positive rei_hours may be
// stored. Near misses ("until dust has settled", "...no re-entry wait once dry", a watered-in sentence that
// also states hours) do not match.
const WATERED_IN_AND_DRY_RE = new RegExp(
  '^(?:stay off|keep (?:people and pets|pets and people|everyone) off)'
  + ' (?:the )?(?:treated )?(?:areas?|turf|lawn|grass)'
  + ' until (?:the )?(?:product|application|treatment|granules?) (?:has|have) been watered in'
  + ' and (?:the )?(?:turf|grass|lawn|surface) (?:is dry|has dried)\\.?$',
  'i',
);
const TIME_WORD_RE = /\d|\b(?:hours?|hrs?|minutes?|mins?|days?|overnight)\b/i;
function labelIsPlainUntilWateredInAndDry(facts) {
  const hours = Number(facts && facts.reentryHours);
  if (Number.isFinite(hours) && hours > 0) return false;
  const text = String((facts && facts.reentrySummary) || '').replace(/\s+/g, ' ').trim();
  return !!text && !TIME_WORD_RE.test(text) && WATERED_IN_AND_DRY_RE.test(text);
}

// One applied product's re-entry rule, from facts the visit already froze: the product's approved frozen
// facts (label floor, watering rule) and the recorded application method. Never from a name, and never from
// the method alone. Every branch below must be at least as strict as what the report shows today.
//   no approved frozen facts                              default (the label floor is unknown)
//   label is neither accepted shape (hours, unreadable, none)  default (today's line or figure is the floor)
//   label "until watered in and dry"                      watered_in_and_dry ONLY with a frozen water-in rule
//                                                         (hold, none or missing: default; the label and the
//                                                         watering facts must agree, never weaker than the label)
//   label "until dry", frozen water-in rule               watered_in_and_dry
//   label "until dry", a granule whose rule is hold or none, a bait   dry (not watered in)
//   label "until dry", a granule with no frozen watering rule         default (cannot tell whether it is watered in)
//   label "until dry", a spray or spot spray              dry
//   no recorded method                                    default
function productReentry(row) {
  const id = String(row && row.id);
  const facts = isPlain(row && row.approved_report_product_facts) ? row.approved_report_product_facts : null;
  const unusable = { id, rule: null, source: 'default' };
  if (!facts) return unusable;
  const mode = isPlain(facts.wateringRule) ? facts.wateringRule.mode : null;
  if (labelIsPlainUntilWateredInAndDry(facts)) {
    return mode === 'water_in' ? { id, rule: 'watered_in_and_dry', source: 'facts' } : unusable;
  }
  if (!labelIsPlainUntilDry(facts)) return unusable;
  const method = methodOf(row);
  let rule = null;
  if (mode === 'water_in') rule = 'watered_in_and_dry';
  else if (isBait(method)) rule = 'dry';
  else if (isGranular(method)) rule = mode === 'hold' || mode === 'none' ? 'dry' : null;
  else if (method) rule = 'dry';
  return rule ? { id, rule, source: 'facts' } : unusable;
}

// The visit's rule is the strictest of its products. One product with no usable fact fails closed:
// the visit keeps today's line default (rule 'default', marked), because a clean "once the spray has
// dried" could be weaker than what the product's label already says.
function visitReentry(rows) {
  const products = (Array.isArray(rows) ? rows : []).map(productReentry);
  if (!products.length) return null;
  if (products.some((p) => p.rule === null)) return { rule: 'default', source: 'default', products };
  const strictest = products.reduce((top, p) => (RANK[p.rule] > RANK[top.rule] ? p : top));
  return { rule: strictest.rule, source: 'facts', products };
}

function cleanReentryProduct(raw) {
  if (!isPlain(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) return null;
  const rule = raw.rule === null || RULES.includes(raw.rule) ? raw.rule : undefined;
  if (rule === undefined || !SOURCES.includes(raw.source)) return null;
  return { id: raw.id, rule, source: raw.source };
}

// A stored reentry block, shape-checked; null when anything is off (a rule this code does not know is none).
function cleanReentry(raw) {
  if (!isPlain(raw) || !(raw.rule === 'default' || RULES.includes(raw.rule)) || !SOURCES.includes(raw.source)) return null;
  const products = (Array.isArray(raw.products) ? raw.products : []).map(cleanReentryProduct);
  if (!products.length || products.some((p) => !p)) return null;
  return { rule: raw.rule, source: raw.source, products };
}

// ── 2. Product use: a spot row says where it went ───────────────────────────

// The area a spot row's card may state: only one the technician recorded AS the spot's extent. The sheet's
// areaValue is also the planned / whole-lawn fallback when the technician typed an amount instead of an area, and
// service_products cannot tell the two apart, so the sheet names the rows whose spot area it recorded
// (lawnFast.spotAreas, frozen by spotAreaFreeze into structured_notes.lawnSpotAreaRecorded). An unnamed row prints
// plain "Spot treatment".
function spotSqft(row, recorded) {
  const productId = String((row && row.product_id) || '').toLowerCase();
  if (!productId || !(recorded instanceof Set) || !recorded.has(productId)) return null;
  const value = row.area_value != null && row.area_value !== '' ? Number(row.area_value) : NaN;
  const unit = String(row.area_unit || '').toLowerCase();
  return Number.isFinite(value) && value > 0 && (unit === 'sqft' || unit === 'sq_ft') ? value : null;
}

// The default areas the lawn Fast Complete sheet attaches to every PLAN product (client/src/lib/lawn-completion.js
// LAWN_DEFAULT_AREAS): not a recorded location, so a row carrying exactly these is ambiguous, like its areaValue.
const DEFAULT_PLAN_AREAS = Object.freeze(['front yard', 'back yard', 'side yards']);

// Whether a row carries a location somebody RECORDED (a place typed or picked), beyond the sheet's default plan areas.
function hasRecordedLocation(row) {
  const parts = String((row && (row.application_area || row.area)) || '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return false;
  return !(parts.length === DEFAULT_PLAN_AREAS.length && DEFAULT_PLAN_AREAS.every((area) => parts.includes(area)));
}

/**
 * The spot rows the card describes by an override. Only a completion from the lawn Fast Complete sheet (the surface
 * that sends the marker contract: `recorded` is a Set, possibly empty) has the ambiguity this fixes, where a row's
 * areaValue may be a planned or whole-lawn fallback. Every other surface (the re-service sheet, the full form) records
 * the location itself, so its rows get no entry and the recorded application area renders as it always did. Within the
 * quick sheet, a row that carries an explicit recorded location (beyond the default plan areas) is left alone too: the
 * place the technician named is more precise than the extent, so it keeps rendering. Every other spot row is described:
 * "Spot treatment, about N sq ft" when its area was recorded as the spot's extent, else plain "Spot treatment".
 */
function productUseEntries(rows, recorded = null) {
  const out = {};
  if (!(recorded instanceof Set)) return out;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (methodOf(row) !== 'spot_treatment' || !row.id || hasRecordedLocation(row)) continue;
    out[String(row.id)] = { sqft: spotSqft(row, recorded) };
  }
  return out;
}

/**
 * The completion record of which products' spot area the technician recorded (GATE_LAWN_REPORT_FACTS):
 * `{ lawnSpotAreaRecorded: { v: 1, productIds } }` to spread into structured_notes, or `{}`. Written only for a
 * completion that carries the `lawnFast` echo (the lawn Fast Complete sheet; productIds may be empty, and the block
 * itself says "this surface"), from its `spotAreas` block, checked here: only while the gate is live, uuid product ids,
 * each once, bounded. Read by nobody but the facts freeze.
 */
function spotAreaFreeze(lawnFast) {
  if (!require('../../config/feature-gates').lawnReportFactsLive()) return {};
  // The echo exists only on a lawn Fast Complete sheet completion: its presence is the surface marker.
  if (!isPlain(lawnFast)) return {};
  const block = isPlain(lawnFast.spotAreas) && lawnFast.spotAreas.v === 1 && Array.isArray(lawnFast.spotAreas.productIds) ? lawnFast.spotAreas : { productIds: [] };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const productIds = [...new Set(block.productIds.filter((id) => typeof id === 'string' && uuid.test(id)).map((id) => id.toLowerCase()))].slice(0, 50);
  return { lawnSpotAreaRecorded: { v: 1, productIds } };
}

function recordedSpotAreas(structuredNotes) {
  const block = parseJsonObject(structuredNotes).lawnSpotAreaRecorded;
  // null = no marker: not a lawn Fast Complete sheet completion (see productUseEntries).
  if (!(isPlain(block) && block.v === 1 && Array.isArray(block.productIds))) return null;
  return new Set(block.productIds.map((id) => String(id).toLowerCase()));
}

function cleanProductUse(raw) {
  if (!isPlain(raw)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!isPlain(entry) || !id || id.length > 64) continue;
    const sqft = Number.isFinite(entry.sqft) && entry.sqft > 0 && entry.sqft < 1e7 ? entry.sqft : null;
    out[id] = { sqft };
  }
  return out;
}

// "about 250": 5s under 100, 10s under 1,000, 50s above.
function roundedSqft(sqft) {
  const step = sqft < 100 ? 5 : (sqft < 1000 ? 10 : 50);
  return Math.max(step, Math.round(sqft / step) * step);
}

/** The card text of a spot row: 'Spot treatment, about 250 sq ft' or 'Spot treatment'. */
function productUseText(entry) {
  if (!isPlain(entry)) return null;
  return Number.isFinite(entry.sqft) && entry.sqft > 0
    ? `Spot treatment, about ${roundedSqft(entry.sqft).toLocaleString('en-US')} sq ft`
    : 'Spot treatment';
}

// ── 3. Ties: a finding and what was applied ─────────────────────────────────

// Kind of finding by the allowlisted condition label (lawn-diagnostic-report CONDITION_LABELS).
// Drought stress is owned by the watering banner: a drought tie prints only when the wetting agent
// was applied.
const KIND_BY_LABEL = Object.freeze({
  'large patch (fungal) activity': 'fungus',
  'gray leaf spot': 'fungus',
  'dollar spot': 'fungus',
  'fungal activity': 'fungus',
  'weed pressure': 'weeds',
  'chinch bug activity': 'insects',
  'caterpillar activity': 'insects',
  'grub activity': 'insects',
  'drought stress': 'drought',
});
const PHOTO_KINDS = Object.freeze(['fungus', 'weeds', 'insects', 'drought']);
// The kind of product that answers each kind of finding.
const PRODUCT_FOR_KIND = Object.freeze({ fungus: 'fungicide', weeds: 'herbicide', insects: 'insecticide', drought: 'wetting_agent' });
const PRODUCT_KINDS = Object.freeze(['fungicide', 'herbicide', 'insecticide', 'wetting_agent']);
// A weed or insect finding is answered by a SPOT row; a fungicide or the wetting agent by any row.
const SPOT_ONLY = Object.freeze(new Set(['herbicide', 'insecticide']));
// The technician's tap (the treatment guide's card kinds) and the product it needs on the visit.
const TECH_PRODUCT = Object.freeze({ chinch: 'insecticide', caterpillars: 'insecticide', fungus: 'fungicide' });
const TECH_KINDS = Object.freeze(Object.keys(TECH_PRODUCT));
// Which expectation family becomes curative when a tie says the product treated a finding.
const FAMILY_FOR_PRODUCT = Object.freeze({ fungicide: 'fungicide', insecticide: 'insecticide' });
const SURE_CONFIDENCES = new Set(['high', 'moderate']);
const SEVERITY_ORDER = Object.freeze({ severe: 0, moderate: 1, mild: 2 });
const MAX_TIES = 4;

// The kind of one applied row for tie purposes, or null. A product the expectations classification locks to
// "preventive" (Acelepryn, lawn-expectations.js modeLock) is never a treatment of a finding: its "What to
// expect" line stays preventive, so a tie could only contradict it. The tie and the expectation therefore read
// the same classification.
function rowProductKind(row) {
  const { classifyLawnProduct } = require('./lawn-expectations');
  const facts = row.approved_report_product_facts;
  const names = [row.product_name, facts && facts.name];
  if (names.some((name) => name && classifyLawnProduct(name)?.modeLock === 'preventive')) return null;
  const { classifyProduct } = require('./lawn-report-v2');
  const text = `${row.product_category || ''} ${row.product_name || ''} ${(facts && facts.category) || ''}`;
  const kind = /wetting/i.test(text) ? 'wetting_agent' : classifyProduct(row).kind;
  return PRODUCT_KINDS.includes(kind) ? kind : null;
}

// What kinds of product a visit's rows hold: { fungicide: {any, spot}, ... }.
function productKinds(rows) {
  const held = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const kind = rowProductKind(row);
    if (!kind) continue;
    const seen = held[kind] || { any: false, spot: false };
    seen.any = true;
    if (methodOf(row) === 'spot_treatment') seen.spot = true;
    held[kind] = seen;
  }
  return held;
}

const answered = (held, product) => !!held[product] && (SPOT_ONLY.has(product) ? held[product].spot : held[product].any);

// The kept PHOTO findings of the visit's own reviewed run, by kind: the same guards as "What the
// photos showed" (a confirmed assessment, its own run, reviewed, rows the technician kept), with the
// cause labels included (the tie names what was treated). A stored cause label already passed the
// naming gate when the run was written (safeConditionLabel downgrades a cause below moderate
// confidence to a generic label), so a cause label here is a moderate-or-better read.
function photoFindingsByKind(run, assessment) {
  if (!run || !assessment || assessment.confirmed_by_tech !== true || !run.reviewed_at) return [];
  if (String(run.assessment_id) !== String(assessment.id)) return [];
  if (run.customer_id != null && assessment.customer_id != null && String(run.customer_id) !== String(assessment.customer_id)) return [];
  const { keptRunRows } = require('./tip-library');
  const rows = keptRunRows(run).reviewed
    .filter((row) => typeof row.label === 'string' && hasOwn(KIND_BY_LABEL, row.label) && CONDITION_LABEL_VALUES.includes(row.label))
    .map((row, index) => ({
      index,
      label: row.label,
      kind: KIND_BY_LABEL[row.label],
      rank: hasOwn(SEVERITY_ORDER, row.severity) ? SEVERITY_ORDER[row.severity] : 3,
      sure: row.can_determine !== false && SURE_CONFIDENCES.has(String(row.confidence || '').toLowerCase()),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const byKind = new Map();
  for (const row of rows) {
    const seen = byKind.get(row.kind);
    // The most severe row names the finding; the least confident row hedges it.
    if (!seen) byKind.set(row.kind, { ...row });
    else seen.sure = seen.sure && row.sure;
  }
  return PHOTO_KINDS.filter((kind) => byKind.has(kind)).map((kind) => byKind.get(kind));
}

/**
 * The tie items of one visit. `techFindings` are the technician's taps that were found AND taken
 * (lawn-treatment-guide.js guideTakenFindings): { kind: chinch | caterpillars | fungus }.
 * A tap counts only while a product of its kind is on the visit (never a treatment we did not
 * record). The technician's word replaces a photo tie of the same kind.
 */
function buildTies({ rows, run, assessment, techFindings = [] }) {
  const held = productKinds(rows);
  const items = [];
  const techKinds = new Set();
  for (const tap of techFindings) {
    // The technician said where he treated, so a product of the kind on the visit is enough (any method).
    if (!TECH_KINDS.includes(tap.kind) || !held[TECH_PRODUCT[tap.kind]]) continue;
    items.push({ source: 'technician', kind: tap.kind, product: TECH_PRODUCT[tap.kind] });
    techKinds.add(tap.kind === 'fungus' ? 'fungus' : 'insects');
  }
  for (const finding of photoFindingsByKind(run, assessment)) {
    if (techKinds.has(finding.kind)) continue;
    const product = PRODUCT_FOR_KIND[finding.kind];
    items.push({
      source: 'photo', kind: finding.kind, label: finding.label, sure: finding.sure, product: answered(held, product) ? product : null,
    });
  }
  return items.slice(0, MAX_TIES);
}

// The technician's recorded finds that may reach the customer. The echo came from the client, so each find is
// checked here before it can become a tie, and an unverifiable one stays on the technician record only:
//   - the card's product ids are really applied on this visit, each of the card's own kind (and not
//     preventive-locked), the products the card named, not any product of the kind;
//   - the live guide's own definitions agree (lawn-treatment-guide.js verifyGuideFind): the ids are staged
//     program rows of that card kind, and a fungus or caterpillar card matches a finding on the confirmed
//     assessment. The standing chinch tap is offered every month, so it is checked against its rungs alone.
async function verifiedTechFindings({ taps, rows, assessment, run, knex }) {
  const guide = require('../lawn-treatment-guide');
  const byId = new Map((Array.isArray(rows) ? rows : []).filter((row) => row.product_id).map((row) => [String(row.product_id).toLowerCase(), row]));
  const signals = assessment && assessment.confirmed_by_tech === true ? guide.signalsFromAssessment(assessment, run) : null;
  const verified = [];
  for (const tap of Array.isArray(taps) ? taps : []) {
    if (!TECH_KINDS.includes(tap.kind) || !Array.isArray(tap.productIds) || !tap.productIds.length) continue;
    const applied = tap.productIds.every((id) => byId.has(id) && rowProductKind(byId.get(id)) === TECH_PRODUCT[tap.kind]);
    if (applied && await guide.verifyGuideFind({ kind: tap.kind, productIds: tap.productIds, signals, knex })) verified.push({ kind: tap.kind });
  }
  return verified;
}

function cleanTie(raw) {
  if (!isPlain(raw)) return null;
  if (raw.source === 'technician') {
    return TECH_KINDS.includes(raw.kind) && raw.product === TECH_PRODUCT[raw.kind]
      ? { source: 'technician', kind: raw.kind, product: raw.product } : null;
  }
  if (raw.source !== 'photo' || !PHOTO_KINDS.includes(raw.kind)) return null;
  if (typeof raw.label !== 'string' || KIND_BY_LABEL[raw.label] !== raw.kind) return null;
  if (raw.product !== null && raw.product !== PRODUCT_FOR_KIND[raw.kind]) return null;
  return { source: 'photo', kind: raw.kind, label: raw.label, sure: raw.sure === true, product: raw.product };
}

function cleanTies(raw) {
  if (!isPlain(raw) || !Array.isArray(raw.items)) return null;
  const items = raw.items.map(cleanTie).filter(Boolean).slice(0, MAX_TIES);
  return { assessmentId: raw.assessmentId == null ? null : String(raw.assessmentId), items };
}

// ── The frozen block: build, read, key ──────────────────────────────────────

// `withTies` is false while the tie part is not live (feature-gates.js lawnReportTiesLive): no tie is read or stored.
function buildReportFacts({ rows, run, assessment, techFindings, withTies = true, recordedSpotAreas: recorded = null, now = new Date() }) {
  const reentry = visitReentry(rows);
  return {
    v: FREEZE_VERSION,
    frozenAt: now.toISOString(),
    ...(reentry ? { reentry } : {}),
    productUse: productUseEntries(rows, recorded),
    ...(withTies ? { ties: { assessmentId: assessment && assessment.id != null ? String(assessment.id) : null, items: buildTies({ rows, run, assessment, techFindings }) } } : {}),
  };
}

/** The frozen facts on a record's structured_notes, shape-checked, or null (absent or not whole). */
function readFrozenReportFacts(structuredNotes) {
  const raw = parseJsonObject(structuredNotes)[FREEZE_KEY];
  if (!isPlain(raw) || raw.v !== FREEZE_VERSION) return null;
  return {
    reentry: cleanReentry(raw.reentry),
    productUse: cleanProductUse(raw.productUse),
    ties: cleanTies(raw.ties),
  };
}

/** The visit's re-entry rule when it is a real decision (never the marked 'default'), or null. */
function frozenReentryRule(structuredNotes) {
  const facts = readFrozenReportFacts(structuredNotes);
  return facts && facts.reentry && facts.reentry.rule !== 'default' ? facts.reentry : null;
}

/**
 * The frozen rule a RENDER of this record reads: frozenReentryRule, unless an ADMIN corrected the re-entry
 * minutes afterwards (the PATCH stamps structured_notes.reentryAdjusted), when the minutes the admin typed
 * stand and the record renders its clock as before. A technician's stepper at completion (it marks only
 * advisory.reentry_adjusted) never overrides the condition: the condition wins.
 */
function frozenReentryForRecord(record) {
  const rule = frozenReentryRule(record && record.structured_notes);
  if (!rule) return null;
  return parseJsonObject(record.structured_notes).reentryAdjusted === true ? null : rule;
}

/** { [service_products.id]: 'Spot treatment, about 250 sq ft' } for the frozen spot rows. */
function frozenProductUseTexts(structuredNotes) {
  const facts = readFrozenReportFacts(structuredNotes);
  if (!facts) return {};
  return Object.fromEntries(Object.entries(facts.productUse).map(([id, entry]) => [id, productUseText(entry)]));
}

/** The frozen ties of one assessment ([] when none, or frozen for another assessment). */
function frozenTies(structuredNotes, assessmentId) {
  const facts = readFrozenReportFacts(structuredNotes);
  if (!facts || !facts.ties || assessmentId == null || facts.ties.assessmentId !== String(assessmentId)) return [];
  return facts.ties.items;
}

/**
 * Whether the record already carries a frozen tie block for this assessment (with or without items). A retried
 * completion uses it to write the same version of the Visit Summary the first run's v6 copy was built for, whatever
 * the gates say now: the live gate only decides whether NEW facts may be frozen.
 */
function hasFrozenTieBlock(structuredNotes, assessmentId) {
  const facts = readFrozenReportFacts(structuredNotes);
  return !!(facts && facts.ties && assessmentId != null && facts.ties.assessmentId === String(assessmentId));
}

/** The expectation families a frozen tie of THIS assessment makes curative (none for another assessment, after a retake). */
function frozenTiedFamilies(structuredNotes, assessmentId) {
  const items = frozenTies(structuredNotes, assessmentId);
  return [...new Set(items.filter((t) => t.product && FAMILY_FOR_PRODUCT[t.product]).map((t) => FAMILY_FOR_PRODUCT[t.product]))];
}

/**
 * The PDF cache-key component: '' when the record carries no frozen decision, else ':rf=' and a short
 * hash of the facts a render reads. Gate-free by design: the key follows the record.
 */
function frozenReportFactsStamp(structuredNotes) {
  const facts = readFrozenReportFacts(structuredNotes);
  if (!facts) return '';
  const hasDecision = (facts.reentry && facts.reentry.rule !== 'default')
    || Object.keys(facts.productUse).length > 0
    || (facts.ties && facts.ties.items.length > 0);
  if (!hasDecision) return '';
  const reentry = facts.reentry && facts.reentry.rule !== 'default' ? { rule: facts.reentry.rule } : null;
  const body = JSON.stringify({ reentry, productUse: facts.productUse, ties: facts.ties });
  return `:rf=${crypto.createHash('sha1').update(body).digest('hex').slice(0, 8)}`;
}

// ── The re-entry condition a render prints ──────────────────────────────────

/** The customer wording for a frozen re-entry rule: { rule, text, pets, statusLabel }, chosen by code. */
function reentryCondition(reentry) {
  if (!reentry || !RULES.includes(reentry.rule)) return null;
  return { rule: reentry.rule, text: REENTRY_TEXT[reentry.rule], pets: REENTRY_PETS, statusLabel: REENTRY_STATUS[reentry.rule] };
}

// ── Small readers for the report build (kept here so the big builders carry no new decisions) ──

/** The frozen re-entry condition sentence for a render of this record, or null (a record with no real rule). */
function frozenReentryText(record) {
  const condition = reentryCondition(frozenReentryForRecord(record));
  return condition ? condition.text : null;
}

/** { [service_products.id]: card text } for a LAWN record; {} for any other line. */
function frozenUseTextsFor(serviceLine, structuredNotes) {
  return serviceLine === 'lawn' ? frozenProductUseTexts(structuredNotes) : {};
}

/** { areaUse } for one product row that has a frozen spot text, else {} (a spread, so the caller decides nothing). */
function areaUseFields(texts, product) {
  const text = product && product.id ? texts[String(product.id)] : null;
  return text ? { areaUse: text } : {};
}

/**
 * The PDF cache-key component for a record's frozen decision (':rf=...' or ''). Read from the SAME service row the
 * render loads when it carries structured_notes, from the record only for a partial lookup row; an unreadable record
 * stamps a one-off value (re-render, never a stale hit).
 */
async function reportFactsKeyStamp(service, knex) {
  try {
    const notes = hasOwn(service, 'structured_notes')
      ? service.structured_notes
      : (await knex('service_records').where({ id: service.id }).first('structured_notes'))?.structured_notes;
    return frozenReportFactsStamp(notes);
  } catch {
    return `:rf=err${crypto.randomBytes(4).toString('hex')}`;
  }
}

// ── Freeze ──────────────────────────────────────────────────────────────────

/**
 * Freeze the block, first writer wins: the key's absence is in the UPDATE predicate (the row lock
 * serializes two writers; the second re-checks after the first commits and writes nothing). Never
 * throws; returns the block the record is now frozen to, or null.
 */
async function freezeReportFacts({ knex, serviceRecordId, facts }) {
  if (!knex || !serviceRecordId || !facts) return null;
  try {
    const written = await knex('service_records')
      .where({ id: serviceRecordId })
      .whereRaw(`(structured_notes::jsonb -> '${FREEZE_KEY}') IS NULL`)
      .update({
        structured_notes: knex.raw(
          "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ [FREEZE_KEY]: facts })],
        ),
      });
    if (Number(written) > 0) return facts;
    const row = await knex('service_records').where({ id: serviceRecordId }).first('structured_notes');
    const stored = parseJsonObject(row && row.structured_notes)[FREEZE_KEY];
    return isPlain(stored) ? stored : null;
  } catch (err) {
    logger.warn(`[lawn-report-facts] freeze failed for service_record ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

// The lawn rows with their frozen product facts (label floor, watering rule), or null when any read
// failed: a freeze made from a partial product picture could never be repaired (first writer wins).
async function loadRows(record, knex) {
  const { attachApprovedReportProductFacts } = require('./report-data');
  const { applyReportIdentitySnapshot } = require('./report-identity-snapshot');
  const raw = await knex('service_products').where({ service_record_id: record.id }).orderBy('created_at');
  const snapshot = applyReportIdentitySnapshot(record).report_identity_snapshot || null;
  const rows = await attachApprovedReportProductFacts(knex, raw, { frozenFacts: snapshot && snapshot.productFacts ? snapshot.productFacts : null });
  if (rows.catalogEnrichmentFailed || rows.wateringRuleLookupFailed) return null;
  return rows;
}

// The visit's linked assessment and its run; both null when the visit has none.
async function loadAssessmentAndRun(record, knex) {
  const { loadLinkedLawnAssessment } = require('./report-data');
  const assessment = await loadLinkedLawnAssessment(record, knex, { failClosed: true });
  if (!assessment) return { assessment: null, run: null };
  const run = await knex('lawn_assessment_runs')
    .where({ assessment_id: assessment.id, customer_id: assessment.customer_id })
    // `severities` and `scores_raw` ride along: the technician-find verification reads the run's per-finding levels
    // (lawn-treatment-guide.js signalsFromAssessment), and without them a fungus or caterpillar card could never verify.
    .first('assessment_id', 'customer_id', 'reviewed_findings', 'added_details', 'reviewed_at', 'severities', 'scores_raw');
  return { assessment, run: run || null };
}

/**
 * The completion step (the lawn write gate, before the first report build, so the v6 copy's first
 * freeze already sees the ties): read the visit's products, assessment run and the technician's taps,
 * decide, freeze. Never throws; a failed read freezes nothing and the report renders as it always did.
 * Returns the frozen block (for the caller's in-memory notes) or null.
 */
async function gatherAndFreezeReportFacts({ record, knex, withTies = false, now = new Date() }) {
  if (!record || !record.id || !knex) return null;
  // Cheap exit: a block already on the row (a resumed completion, a second run, a recorded failure) is never rebuilt.
  if (readFrozenReportFacts(record.structured_notes)) return null;
  try {
    const notes = parseJsonObject(record.structured_notes);
    // Ties are decided BEFORE the copy: if the v6 copy or the Visit Summary already froze without a block (an earlier
    // attempt that could not record anything), a tie frozen now would disagree with them, so none is frozen.
    const tiesAllowed = withTies && !notes.lawnCopyV6 && !notes.lawnVisitSummary;
    const rows = await loadRows(record, knex);
    if (!rows) throw new Error('the visit\'s product facts could not be read');
    if (!rows.length) return null;
    const { assessment, run } = tiesAllowed ? await loadAssessmentAndRun(record, knex) : { assessment: null, run: null };
    const taps = tiesAllowed ? require('../lawn-treatment-guide').guideTakenFindings(record.structured_notes) : [];
    // A read that fails here THROWS (verifiedTechFindings): a find that could not be checked is not a find we may leave out.
    const techFindings = await verifiedTechFindings({ taps, rows, assessment, run, knex });
    const facts = buildReportFacts({ rows, run, assessment, techFindings, withTies: tiesAllowed, recordedSpotAreas: recordedSpotAreas(record.structured_notes), now });
    return await freezeReportFacts({ knex, serviceRecordId: record.id, facts });
  } catch (err) {
    logger.warn(`[lawn-report-facts] gather failed for service_record ${record.id}: ${err.message}`);
    return await recordFailedFreeze({ record, knex, now });
  }
}

/**
 * One attempt decides. When the attempt fails (any read, or the write), a MARKED block is recorded instead: no
 * re-entry rule (so the report keeps today's default clock, never anything weaker), no spot text (the zone text, as
 * today), no ties. It is a frozen block like any other, so the v6 copy, the Visit Summary, the PDF key and every later
 * attempt (the write gate's own call, a resumed completion) agree with it, and nothing can freeze different facts after
 * copy has frozen. Never throws; null only if even the marker could not be written.
 */
async function recordFailedFreeze({ record, knex, now = new Date() }) {
  return freezeReportFacts({ knex, serviceRecordId: record.id, facts: { v: FREEZE_VERSION, frozenAt: now.toISOString(), failed: true, productUse: {} } });
}

module.exports = {
  FREEZE_KEY,
  FREEZE_VERSION,
  REENTRY_TEXT,
  REENTRY_PETS,
  TECHNICIAN_CONFIRMS,
  KIND_BY_LABEL,
  PRODUCT_FOR_KIND,
  TECH_PRODUCT,
  productReentry,
  visitReentry,
  productUseEntries,
  spotAreaFreeze,
  hasRecordedLocation,
  productUseText,
  buildTies,
  buildReportFacts,
  readFrozenReportFacts,
  frozenReentryRule,
  frozenReentryForRecord,
  frozenReentryText,
  frozenUseTextsFor,
  areaUseFields,
  reportFactsKeyStamp,
  frozenProductUseTexts,
  frozenTies,
  hasFrozenTieBlock,
  frozenTiedFamilies,
  frozenReportFactsStamp,
  reentryCondition,
  freezeReportFacts,
  gatherAndFreezeReportFacts,
  cleanTies,
  _test: { methodOf, recordedSpotAreas, rowProductKind, verifiedTechFindings, labelIsPlainUntilDry, labelIsPlainUntilWateredInAndDry, roundedSqft, photoFindingsByKind, productKinds },
};
