'use strict';

/**
 * PROTOTYPE ONLY. Lawn "Visit Summary" (GATE_LAWN_VISIT_SUMMARY_V2).
 *
 * FIXED SENTENCES, NO MODEL (owner ruling 2026-10-07). Code writes every word
 * from the closed tables below, chosen from the visit's structured facts. Two
 * Codex rounds on the model-written version found 27 ways free text slipped past
 * a validator (invented pests, "no significant issues", past-tense watering, the
 * wrong season, numbers, future treatment promises). A table phrase cannot carry
 * any of those, so there is no validator to slip past. Same design as the tree &
 * shrub "From your technician" paragraph (tree-shrub-tech-paragraph.js).
 *
 * The paragraph, in this order, each sentence only when its facts exist:
 *   1. What we did:   "Today we applied {categories}, which fits the {season} season."
 *   2. Photo read:    area reads as closed (area, status) phrases.
 *   3. Findings:      kept photo findings, by their own symptom label, hedged by confidence.
 *   4. Results build: one fixed sentence (no time words).
 *   5. Watering:      from the FROZEN watering instruction only.
 *   6. Next visit:    "At the next visit we will look at {topics}."
 *
 * Choices (each one pinned by a test):
 *   - The technician's note is NOT an input. Free text is never copied.
 *   - A product's name, active ingredient and rate never reach this module's
 *     output: a product becomes its category phrase and nothing else.
 *   - The v13 program line, the report headline and a product's target list are
 *     not inputs, so a pest named there can never be stated as a sighting.
 *   - Rain is not stated. conditions.rain_24h_in mixes observed hours with
 *     forecast hours (application-conditions.js), so observed rain cannot be told
 *     apart; the report's own rain surfaces stay the only place rain is said.
 *   - A photo finding prints only while the report's own card for that topic reads
 *     watch or needs attention (the "What the photos showed" rule), so the
 *     paragraph never says "thick coverage" and "thinning turf" together.
 *   - Watering hours are the frozen deadline rounded DOWN, never longer.
 *
 * Where it lives: lawn-report-write-gate.js composes and freezes at completion,
 * in the awaited gate step that runs before the report email is queued and
 * before the email worker rebuilds the PDF (composition is synchronous, so there
 * is no email race). The frozen entry is { text, slots }; a render only reads it,
 * and at read time the text must equal render(slots) under the CURRENT tables,
 * so a changed table or a hand-edited row prints nothing (the recap stays). The
 * SMS keeps the short customerRecap.
 *
 * Pure except the freeze's write. No gate read: callers decide.
 */

const { createTechParagraphEngine, clean } = require('./tech-paragraph-engine');
const { customerCopyViolations } = require('./technician-report-copy');
const { lawnResultTimingViolation } = require('./report-writer-rules');
const { CARD_FOR_LABEL, CARD_STATUSES_THAT_PRINT, PHOTO_FINDING_LABELS } = require('./lawn-photo-findings');

const COMPOSER_VERSION = 'lawn_visit_summary_fixed_v1';
const FREEZE_KEY = 'lawnVisitSummary';
// v2: fixed sentences with slots. A v1 entry (the retired model-written prototype) reads as nothing.
const FREEZE_VERSION = 2;
// No model call: the step is record reads plus one atomic write.
const BUDGET_MS = 10 * 1000;
// The longest paragraph any valid slots can render (pinned by a test).
const MAX_TEXT_CHARS = 1100;

// ── Closed phrase tables (the owner reads and approves these) ──────────────

// What a product KIND is, in the words a customer hears. Never a name or a rate.
const CATEGORY_BY_KIND = Object.freeze({
  fertilizer: 'a feeding',
  supplement: 'a micronutrient and color boost',
  pre_emergent: 'a pre-emergent weed barrier',
  herbicide: 'weed control',
  insecticide: 'insect control',
  fungicide: 'disease protection',
  other: 'a lawn treatment',
});
// A weed barrier or control product that also carries a fertilizer analysis is
// BOTH (owner 2026-10-06): its phrase keeps the feeding half.
const COMBO_KIND = Object.freeze({
  pre_emergent: 'a feeding with a pre-emergent weed barrier',
  herbicide: 'a feeding with weed control',
  insecticide: 'a feeding with insect control',
  fungicide: 'a feeding with disease protection',
  other: 'a feeding',
});
const APPLIED_PHRASES = Object.freeze({
  ...CATEGORY_BY_KIND,
  ...Object.fromEntries(Object.entries(COMBO_KIND).map(([kind, phrase]) => [`combo_${kind}`, phrase])),
});
const APPLIED_ORDER = Object.freeze([
  'fertilizer', 'combo_pre_emergent', 'combo_herbicide', 'combo_insecticide', 'combo_fungicide', 'combo_other',
  'supplement', 'pre_emergent', 'herbicide', 'insecticide', 'fungicide', 'other',
]);
const MAX_APPLIED = 4;

const SEASONS = Object.freeze({ spring: 'spring', summer: 'summer', fall: 'fall', winter: 'winter' });

// The report's score cards (reportV2.diagnosis keys) and their status bands.
// Water / Coverage is the watering banner's, so it has no phrase here.
const STATUS_BAND = Object.freeze({ strong: 'good', healthy: 'good', watch: 'watch', needs_attention: 'needs_attention' });
const AREA_ORDER = Object.freeze(['weed_pressure', 'coverage', 'color_vigor', 'damage_disease_signals']);
const AREA_PHRASES = Object.freeze({
  weed_pressure: Object.freeze({
    good: 'few weeds',
    watch: 'some weeds we are keeping an eye on',
    needs_attention: 'weeds that need more attention',
  }),
  coverage: Object.freeze({
    good: 'thick coverage',
    watch: 'some thin areas we are keeping an eye on',
    needs_attention: 'thin areas that need more attention',
  }),
  color_vigor: Object.freeze({
    good: 'good color',
    watch: 'color we are keeping an eye on',
    needs_attention: 'color that needs more attention',
  }),
  // A healthy stress card prints nothing: "no stress" would be an all clear.
  damage_disease_signals: Object.freeze({
    watch: 'a few areas showing stress we are keeping an eye on',
    needs_attention: 'some areas showing stress that need more attention',
  }),
});

// Kept photo findings: ONLY the symptom labels on the report's own allowlist
// (PHOTO_FINDING_LABELS), each by its own words. A low or unknown confidence
// takes the hedged form.
const FINDING_PHRASES = Object.freeze({
  'weed pressure': Object.freeze({ sure: 'some weed pressure', hedged: 'what may be some weed pressure' }),
  'thinning turf': Object.freeze({ sure: 'some thinning turf', hedged: 'what may be some thinning turf' }),
  'color and nutrient stress': Object.freeze({ sure: 'some color and nutrient stress', hedged: 'what may be some color and nutrient stress' }),
  'color stress': Object.freeze({ sure: 'some color stress', hedged: 'what may be some color stress' }),
  'general lawn stress': Object.freeze({ sure: 'some general lawn stress', hedged: 'what may be some general lawn stress' }),
  'a lawn condition we are monitoring': Object.freeze({ sure: 'a lawn condition we are monitoring', hedged: 'what may be a lawn condition we are monitoring' }),
});
const SURE_CONFIDENCES = new Set(['high', 'moderate']);
const MAX_FINDINGS = 3;

// What we will look at next visit. Insight categories and finding labels both map
// into this one closed list.
const TOPIC_PHRASES = Object.freeze({
  weeds: 'weeds',
  thin: 'thin areas',
  color: 'lawn color',
  damage: 'stressed areas',
  monitoring: 'the condition we are monitoring',
  mowing: 'mowing height',
});
const TOPIC_ORDER = Object.freeze(['weeds', 'thin', 'color', 'damage', 'monitoring', 'mowing']);
const TOPIC_BY_AREA = Object.freeze({ weed_pressure: 'weeds', coverage: 'thin', color_vigor: 'color', damage_disease_signals: 'damage' });
const TOPIC_BY_LABEL = Object.freeze({
  'weed pressure': 'weeds',
  'thinning turf': 'thin',
  'color and nutrient stress': 'color',
  'color stress': 'color',
  'general lawn stress': 'damage',
  'a lawn condition we are monitoring': 'monitoring',
});
const MAX_TOPICS = 3;

const SENTENCE = Object.freeze({
  applied: (list, season) => `Today we applied ${list}${season ? `, which fits the ${season} season` : ''}.`,
  photoRead: (list) => `Our photo read shows ${list}.`,
  photoReadMixed: (good, concerns) => `Our photo read shows ${good}, along with ${concerns}.`,
  findings: (list) => `In the photos we noticed ${list}.`,
  results: 'Results from treatments like these build gradually, and each visit adds to the last one.',
  nextVisit: (list) => `At the next visit we will look at ${list}.`,
});
// The watering step, by the frozen instruction's state. The only sentences with digits.
const WATERING_SENTENCE = Object.freeze({
  water_in: (inches, hours) => `Please water the treated lawn in with ${inches} of water within ${hours} of today’s visit.`,
  // The frozen hold has its own release condition (a clock time and/or "not before dry")
  // and the water-in deadline counts from the visit, so the note owns both: no amounts here.
  hold_then_water_in: () => 'Please follow the watering note in this report: hold off first, then water the treatment in when it says.',
  hold: () => 'Please hold off on watering the treated lawn for now. The watering note in this report says when to start again.',
});

// ── Facts ─────────────────────────────────────────────────────────────────

const CONFIDENCES = new Set(['high', 'moderate', 'low', 'unknown']);
const WATERING_STATES = new Set(['water_in', 'hold_then_water_in', 'hold']);
const FINDING_LABELS = new Set(PHOTO_FINDING_LABELS);
// An N-P-K analysis such as 15-0-15 or 18-0-10 (percent signs not required).
const FERTILIZER_ANALYSIS_RE = /\b\d{1,2}-\d{1,2}-\d{1,2}\b/;
const MAX_INCHES = 3;
const MAX_HOURS = 72;

const finite = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// A product becomes its kind and whether it also feeds. Its name and active are read
// here ONLY to spot a fertilizer analysis; neither is kept.
function cleanApplied(p) {
  if (!p || !clean(p.name || p.kind)) return null;
  const kind = Object.prototype.hasOwnProperty.call(CATEGORY_BY_KIND, p.kind) ? p.kind : 'other';
  // Idempotent: an already-normalized { kind, alsoFeeds } (its name and active are gone) keeps its flag.
  const alsoFeeds = kind !== 'fertilizer' && kind !== 'supplement'
    && (p.alsoFeeds === true || FERTILIZER_ANALYSIS_RE.test(`${clean(p.activeIngredient)} ${clean(p.name)}`));
  return { kind, alsoFeeds };
}

function cleanWatering(w) {
  if (!w || !WATERING_STATES.has(w.state)) return null;
  // A hold, alone or before a water-in, is described by the report's own watering note: no amounts.
  if (w.state === 'hold' || w.state === 'hold_then_water_in') return { state: w.state, inches: null, hours: null };
  const inches = finite(w.inches);
  const hours = finite(w.hours);
  // A half-known step is no step: the report banner owns it.
  if (!(inches > 0 && inches <= MAX_INCHES) || !(hours >= 1 && hours <= MAX_HOURS)) return null;
  return { state: w.state, inches: Number(inches.toFixed(2)), hours: Math.floor(hours) };
}

// The report's score-card key for a diagnosis row: its own key, else read from its label.
function areaKeyOf(area) {
  if (area && AREA_ORDER.includes(area.key)) return area.key;
  const label = String((area && area.label) || '');
  if (/weed/i.test(label)) return 'weed_pressure';
  if (/stress|damage/i.test(label)) return 'damage_disease_signals';
  if (/coverage|density/i.test(label)) return 'coverage';
  if (/color|vigor/i.test(label)) return 'color_vigor';
  return null;
}

function cleanAreas(areas) {
  const out = new Map();
  for (const area of Array.isArray(areas) ? areas : []) {
    const key = areaKeyOf(area);
    if (key && STATUS_BAND[area.status] && !out.has(key)) out.set(key, { key, status: area.status });
  }
  return AREA_ORDER.filter((key) => out.has(key)).map((key) => out.get(key));
}

function cleanFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const label = clean(f && f.label);
    if (!FINDING_LABELS.has(label) || seen.has(label)) continue;
    seen.add(label);
    const confidence = String((f && f.confidence) || '').toLowerCase();
    out.push({ label, confidence: CONFIDENCES.has(confidence) ? confidence : 'unknown' });
  }
  return out;
}

/**
 * The canonical facts. Everything the composer reads comes from here: no name, no
 * active ingredient, no rate, no free text. Idempotent.
 */
function normalizeFacts(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const seen = new Set();
  const applied = [];
  for (const p of (Array.isArray(raw.applied) ? raw.applied : []).map(cleanApplied).filter(Boolean)) {
    const key = `${p.kind}|${p.alsoFeeds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    applied.push(p);
  }
  return {
    season: Object.prototype.hasOwnProperty.call(SEASONS, raw.season) ? raw.season : null,
    applied: applied.slice(0, 6),
    findings: cleanFindings(raw.findings).slice(0, 5),
    areas: cleanAreas(raw.areas),
    watering: cleanWatering(raw.watering),
    watchNext: (Array.isArray(raw.watchNext) ? raw.watchNext : []).filter((t) => Object.prototype.hasOwnProperty.call(TOPIC_PHRASES, t)),
  };
}

// ── Slots: the choices code makes from the facts ──────────────────────────

// Applied phrase ids in the fixed order; a combination covers its plain kind.
function appliedSlots(applied) {
  const ids = new Set();
  for (const p of applied) ids.add(p.alsoFeeds ? `combo_${p.kind}` : p.kind);
  const combined = [...ids].filter((id) => id.startsWith('combo_'));
  if (combined.length) ids.delete('fertilizer');
  for (const id of combined) ids.delete(id.slice('combo_'.length));
  if (ids.size > 1) ids.delete('other');
  return APPLIED_ORDER.filter((id) => ids.has(id)).slice(0, MAX_APPLIED);
}

// A finding prints only while the report's own card for that topic shows a concern.
function findingSlots(findings, areas) {
  const status = new Map(areas.map((a) => [a.key, a.status]));
  return findings
    .filter((f) => CARD_STATUSES_THAT_PRINT.includes(status.get(CARD_FOR_LABEL[f.label])))
    .slice(0, MAX_FINDINGS)
    .map((f) => ({ label: f.label, hedged: !SURE_CONFIDENCES.has(f.confidence) }));
}

function areaSlots(areas, findings) {
  const covered = new Set(findings.map((f) => CARD_FOR_LABEL[f.label]));
  return areas
    .filter((a) => !covered.has(a.key) && AREA_PHRASES[a.key][STATUS_BAND[a.status]])
    .map((a) => ({ key: a.key, band: STATUS_BAND[a.status] }));
}

function topicSlots(facts, findings) {
  const topics = new Set(facts.watchNext);
  for (const a of facts.areas) if (a.status === 'watch' || a.status === 'needs_attention') topics.add(TOPIC_BY_AREA[a.key]);
  for (const f of findings) topics.add(TOPIC_BY_LABEL[f.label]);
  return TOPIC_ORDER.filter((t) => topics.has(t)).slice(0, MAX_TOPICS);
}

/** Facts -> slots, or null when there is nothing grounded to say. Pure. */
function buildSlots(rawFacts) {
  const facts = normalizeFacts(rawFacts);
  const applied = appliedSlots(facts.applied);
  const findings = findingSlots(facts.findings, facts.areas);
  const areas = areaSlots(facts.areas, findings);
  if (!applied.length && !findings.length && !areas.length) return null;
  return {
    season: applied.length ? facts.season : null,
    applied,
    areas,
    findings,
    watering: facts.watering,
    watch: topicSlots(facts, findings),
  };
}

// ── Render: slots -> sentences (a closed set; nothing else is ever printed) ──

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// The frozen amounts as words, or null when either is out of range.
function amountOf(inches, hours) {
  const n = Number(inches);
  const h = Number(hours);
  if (!(n > 0 && n <= MAX_INCHES) || !(Number.isInteger(h) && h >= 1 && h <= MAX_HOURS)) return null;
  return { inches: `${n} ${n === 1 ? 'inch' : 'inches'}`, hours: `${h} ${h === 1 ? 'hour' : 'hours'}` };
}

function appliedSentence(slots) {
  const phrases = (Array.isArray(slots.applied) ? slots.applied : []).filter((id) => Object.hasOwn(APPLIED_PHRASES, id)).map((id) => APPLIED_PHRASES[id]);
  if (!phrases.length) return null;
  return SENTENCE.applied(joinList(phrases), Object.hasOwn(SEASONS, slots.season) ? SEASONS[slots.season] : null);
}

function photoReadSentence(slots) {
  const good = [];
  const concerns = [];
  for (const a of Array.isArray(slots.areas) ? slots.areas : []) {
    const phrase = Object.hasOwn(AREA_PHRASES, a && a.key) && AREA_PHRASES[a.key][a.band];
    if (phrase) (a.band === 'good' ? good : concerns).push(phrase);
  }
  if (good.length && concerns.length) return SENTENCE.photoReadMixed(joinList(good), joinList(concerns));
  return good.length || concerns.length ? SENTENCE.photoRead(joinList(good.length ? good : concerns)) : null;
}

function findingsSentence(slots) {
  const phrases = (Array.isArray(slots.findings) ? slots.findings : [])
    .filter((f) => f && Object.hasOwn(FINDING_PHRASES, f.label))
    .map((f) => FINDING_PHRASES[f.label][f.hedged === false ? 'sure' : 'hedged']);
  return phrases.length ? SENTENCE.findings(joinList(phrases)) : null;
}

function wateringSentence(slots) {
  const w = slots.watering;
  if (!w || !Object.hasOwn(WATERING_SENTENCE, w.state)) return null;
  if (w.state === 'hold' || w.state === 'hold_then_water_in') return WATERING_SENTENCE[w.state]();
  const amount = amountOf(w.inches, w.hours);
  return amount ? WATERING_SENTENCE[w.state](amount.inches, amount.hours) : null;
}

function nextVisitSentence(slots) {
  const topics = (Array.isArray(slots.watch) ? slots.watch : []).filter((t) => Object.hasOwn(TOPIC_PHRASES, t)).map((t) => TOPIC_PHRASES[t]);
  return topics.length ? SENTENCE.nextVisit(joinList(topics)) : null;
}

/** Slots -> ordered sentences. Pure; unknown ids and malformed slots print nothing. */
function renderSentences(slots) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return [];
  const applied = appliedSentence(slots);
  return [
    applied,
    photoReadSentence(slots),
    findingsSentence(slots),
    applied ? SENTENCE.results : null,
    wateringSentence(slots),
    nextVisitSentence(slots),
  ].filter(Boolean);
}

/** Slots -> the paragraph text, or '' when nothing applies. Pure. */
function render(slots) {
  return renderSentences(slots).join(' ');
}

// ── Compose / read-time guard ─────────────────────────────────────────────

// Words no table phrase may ever carry: an all clear, a cure, a guarantee.
const BANNED_RE = /\b(?:eradicat\w*|exterminat\w*|eliminat\w*|resolved|solved|gone|cleared|pest[\s-]?free|safe(?:ly|r|st)?|chemicals?|cured?|healed|fixed|guarantee[sd]?|promise[sd]?)\b|\bno\s+(?:\w+\s+)?(?:issues?|problems?|concerns?|pests?|damage|weeds?|disease)\b|\bnothing\s+(?:wrong|to\s+worry|of\s+concern)|\ball\s+clear\b|\bperfect(?:ly)?\b|\bflawless/i;

// Every rule a rendered text must pass, at write time and again at read time.
function textProblem(text) {
  const t = clean(text);
  if (!t || t.length > MAX_TEXT_CHARS) return 'shape';
  if (customerCopyViolations(t).length) return 'copy';
  if (BANNED_RE.test(t)) return 'banned';
  if (lawnResultTimingViolation(t)) return 'timing';
  return null;
}

/**
 * Never throws. Facts in, { ok, paragraph, slots } out, or { ok: false, reason }
 * when there is nothing grounded to say or the text fails the screens (a table
 * edit that breaks a rule is a miss, never copy).
 */
function composeVisitSummary(rawFacts) {
  try {
    const slots = buildSlots(rawFacts);
    if (!slots) return { ok: false, reason: 'nothing_to_ground' };
    const paragraph = render(slots);
    const problem = textProblem(paragraph);
    if (problem) return { ok: false, reason: 'rejected', problems: [problem] };
    return { ok: true, paragraph, slots };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// A frozen entry is checked again where it is read: the text must be exactly what
// the CURRENT tables render from the stored slots, and pass every screen.
function frozenEntryProblem(entry) {
  const text = clean(entry && entry.text);
  if (!text) return 'shape';
  if (!entry.slots || typeof entry.slots !== 'object' || Array.isArray(entry.slots)) return 'no_slots';
  if (render(entry.slots) !== text) return 'drift';
  return textProblem(text);
}

// ── Freeze (shared plumbing: tech-paragraph-engine.js) ────────────────────

const engine = createTechParagraphEngine({
  logTag: 'lawn-visit-summary',
  laneId: 'lawn_visit_summary', // names the freeze's log lines only; nothing here calls a model
  promptVersion: COMPOSER_VERSION,
  freezeKey: FREEZE_KEY,
  freezeVersion: FREEZE_VERSION,
  budgetMs: BUDGET_MS,
  normalizeInputs: normalizeFacts,
  frozenEntryProblem,
});

async function generateVisitSummary(facts) {
  const composed = composeVisitSummary(facts);
  return composed.ok ? { ...composed, inputsHash: engine.inputsHash(normalizeFacts(facts)) } : composed;
}

function createAndFreezeVisitSummary(args) {
  return engine.createAndFreezeTechParagraph({ ...args, deps: { generate: generateVisitSummary, ...(args.deps || {}) } });
}

module.exports = {
  COMPOSER_VERSION,
  FREEZE_KEY,
  FREEZE_VERSION,
  BUDGET_MS,
  MAX_TEXT_CHARS,
  CATEGORY_BY_KIND,
  APPLIED_PHRASES,
  AREA_PHRASES,
  FINDING_PHRASES,
  TOPIC_PHRASES,
  SENTENCE,
  WATERING_SENTENCE,
  normalizeFacts,
  buildSlots,
  renderSentences,
  render,
  composeVisitSummary,
  generateVisitSummary,
  createAndFreezeVisitSummary,
  readFrozenVisitSummary: engine.readFrozenTechParagraph,
  visitSummarySignature: engine.techParagraphSignature,
  freezeVisitSummary: engine.freezeTechParagraph,
  _test: { frozenEntryProblem, textProblem, amountOf },
};
