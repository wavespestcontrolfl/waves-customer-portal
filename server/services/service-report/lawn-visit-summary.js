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
 *   3b. Ties (v4, GATE_LAWN_REPORT_FACTS): a photo finding tied to what was applied, or the
 *                     technician's own find, in fixed sentences from the facts frozen at completion
 *                     (lawn-report-facts.js). A finding with no matching product says it will be checked
 *                     by hand, and only on a recurring plan visit with a real next visit; a treatment is
 *                     never promised.
 *   4. Results build: one fixed sentence (no time words), recurring lawn plan visits only.
 *   5. Next visit:    "At the next visit we will look at {topics}." Only for a recurring plan visit
 *                     with a real scheduled next visit; a one-time visit promises neither line.
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
 *   - There is NO watering sentence: the report's watering banner owns the watering step, with its
 *     own timing and expiry, so the summary can never contradict or outlive it (owner 2026-10-07).
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
const { cleanTies, KIND_BY_LABEL, PRODUCT_FOR_KIND, TECH_PRODUCT } = require('./lawn-report-facts');

const COMPOSER_VERSION = 'lawn_visit_summary_fixed_v1';
const FREEZE_KEY = 'lawnVisitSummary';
// v3: fixed sentences with slots, no watering sentence. Older prototype entries read as nothing.
// v4 (GATE_LAWN_REPORT_FACTS): the same, plus the finding-to-product tie (slots.ties). A new completion
// freezes v4 only while that gate is live, v3 otherwise; both versions render, each exactly as frozen.
const FREEZE_VERSION = 3;
const FREEZE_VERSION_TIES = 4;
const READ_VERSIONS = Object.freeze([FREEZE_VERSION, FREEZE_VERSION_TIES]);
// No model call: the step is record reads plus one atomic write.
const BUDGET_MS = 10 * 1000;
// The longest paragraph any valid slots can render (pinned by a test).
const MAX_TEXT_CHARS = 1500;

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

// The report's score cards (reportV2.diagnosis keys) and their status bands. `strong` and `healthy` stay
// DISTINCT bands (lawn-visual-diagnosis: 85+ and 70-84), so a lawn with visible thinning is never called
// thick. Water / Coverage is the watering banner's, so it has no phrase here.
const STATUS_BAND = Object.freeze({ strong: 'strong', healthy: 'healthy', watch: 'watch', needs_attention: 'needs_attention' });
const POSITIVE_BANDS = Object.freeze(['strong', 'healthy']);
const AREA_ORDER = Object.freeze(['weed_pressure', 'coverage', 'color_vigor', 'damage_disease_signals']);
const AREA_PHRASES = Object.freeze({
  weed_pressure: Object.freeze({
    strong: 'very few weeds',
    healthy: 'weeds well in check',
    watch: 'some weeds we are keeping an eye on',
    needs_attention: 'weeds that need more attention',
  }),
  coverage: Object.freeze({
    strong: 'thick coverage',
    healthy: 'good coverage overall with only minor thinning',
    watch: 'some thin areas we are keeping an eye on',
    needs_attention: 'thin areas that need more attention',
  }),
  color_vigor: Object.freeze({
    strong: 'strong color',
    healthy: 'healthy color',
    watch: 'color we are keeping an eye on',
    needs_attention: 'color that needs more attention',
  }),
  // A strong or healthy stress card prints nothing: "no stress" would be an all clear.
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

// Ties (v4). What was applied, in the words a customer hears; what the technician found.
const TIE_PRODUCT_PHRASES = Object.freeze({
  fungicide: 'a fungicide',
  herbicide: 'a weed control product',
  insecticide: 'an insect control product',
  wetting_agent: 'a wetting agent',
});
const TECH_FOUND_PHRASES = Object.freeze({ chinch: 'chinch bugs', caterpillars: 'caterpillars', fungus: 'signs of fungus' });
const MAX_TIES = 2;
// An unmatched finding prints only while the report's own card for its topic shows a concern, like a
// finding in the list above. Drought stress belongs to the watering banner and never prints unmatched.
const CARD_FOR_TIE_KIND = Object.freeze({ fungus: 'damage_disease_signals', insects: 'damage_disease_signals', weeds: 'weed_pressure' });
// The technician's finds (chinch bugs, caterpillars, signs of fungus) are all stress / damage topics.
const TECH_CARD_KIND = Object.freeze({ chinch: 'insects', caterpillars: 'insects', fungus: 'fungus' });

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
  tieSure: (label, product) => `Today’s photos showed ${label} in one area. We treated that spot with ${product} today.`,
  tieHedged: (label, product) => `Today’s photos showed what may be ${label} in one area, so we treated that spot with ${product} today.`,
  tieCheck: (label) => `Today’s photos showed what may be ${label} in one area. We will check it by hand at the next visit.`,
  tieTech: (found) => `Your technician found ${found} and treated that spot today.`,
  results: 'Results from treatments like these build gradually, and each visit adds to the last one.',
  nextVisit: (list) => `At the next visit we will look at ${list}.`,
});

// ── Facts ─────────────────────────────────────────────────────────────────

const CONFIDENCES = new Set(['high', 'moderate', 'low', 'unknown']);
const FINDING_LABELS = new Set(PHOTO_FINDING_LABELS);
// An N-P-K analysis such as 15-0-15 or 18-0-10 (percent signs not required).
const FERTILIZER_ANALYSIS_RE = /\b\d{1,2}-\d{1,2}-\d{1,2}\b/;

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
  const byLabel = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    const label = clean(f && f.label);
    if (!FINDING_LABELS.has(label)) continue;
    const raw = String((f && f.confidence) || '').toLowerCase();
    const confidence = CONFIDENCES.has(raw) ? raw : 'unknown';
    // A finding the technician marked undeterminable from the photos is always hedged.
    const canDetermine = !(f && f.canDetermine === false);
    const seen = byLabel.get(label);
    // The same label twice keeps the more cautious read of the two.
    if (!seen) byLabel.set(label, { label, confidence, canDetermine });
    else byLabel.set(label, { label, confidence: SURE_CONFIDENCES.has(seen.confidence) ? confidence : seen.confidence, canDetermine: seen.canDetermine && canDetermine });
  }
  return [...byLabel.values()];
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
  const ties = (cleanTies({ items: raw.ties }) || { items: [] }).items;
  return {
    season: Object.prototype.hasOwnProperty.call(SEASONS, raw.season) ? raw.season : null,
    applied: applied.slice(0, 6),
    findings: cleanFindings(raw.findings).slice(0, 5),
    areas: cleanAreas(raw.areas),
    watchNext: (Array.isArray(raw.watchNext) ? raw.watchNext : []).filter((t) => Object.prototype.hasOwnProperty.call(TOPIC_PHRASES, t)),
    recurring: raw.recurring === true,
    nextVisitBooked: raw.nextVisitBooked === true,
    // Only when there is one: a visit with no tie normalizes (and hashes) exactly as a v3 visit does.
    ...(ties.length ? { ties } : {}),
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
    .map((f) => ({ label: f.label, hedged: f.canDetermine === false || !SURE_CONFIDENCES.has(f.confidence) }));
}

function areaSlots(areas, findings, ties = []) {
  // A card whose topic a finding or a tie already states is not read out a second time.
  const covered = new Set([...findings.map((f) => CARD_FOR_LABEL[f.label]), ...ties.map((t) => CARD_FOR_TIE_KIND[t.kind] || CARD_FOR_TIE_KIND[TECH_CARD_KIND[t.kind]])]);
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

// The tie slots (v4): a technician's find, a photo finding with its product, or a photo finding
// to be checked by hand (recurring visit with a real next visit, card showing a concern).
function tieSlots(facts) {
  const status = new Map(facts.areas.map((a) => [a.key, a.status]));
  const checkable = facts.recurring && facts.nextVisitBooked;
  const slots = [];
  for (const tie of facts.ties || []) {
    if (tie.source === 'technician') slots.push({ t: 'tech', kind: tie.kind });
    else if (tie.product) slots.push({ t: 'photo', kind: tie.kind, label: tie.label, sure: tie.sure === true, product: tie.product });
    else if (checkable && CARD_FOR_TIE_KIND[tie.kind] && CARD_STATUSES_THAT_PRINT.includes(status.get(CARD_FOR_TIE_KIND[tie.kind]))) {
      slots.push({ t: 'photo', kind: tie.kind, label: tie.label, sure: false, product: null });
    }
  }
  return slots.slice(0, MAX_TIES);
}

/** Facts -> slots, or null when there is nothing grounded to say. Pure. */
function buildSlots(rawFacts) {
  const facts = normalizeFacts(rawFacts);
  const applied = appliedSlots(facts.applied);
  const ties = tieSlots(facts);
  // A finding the tie already states is not listed again.
  const tied = new Set(ties.map((t) => t.label).filter(Boolean));
  const findings = findingSlots(facts.findings, facts.areas).filter((f) => !tied.has(f.label));
  const areas = areaSlots(facts.areas, findings, ties);
  if (!applied.length && !findings.length && !areas.length && !ties.length) return null;
  return {
    season: applied.length ? facts.season : null,
    applied,
    areas,
    findings,
    ...(ties.length ? { ties } : {}),
    // The recurring-plan promises are decided here and frozen, so a read renders the same.
    recurring: facts.recurring,
    nextVisit: facts.recurring && facts.nextVisitBooked,
    watch: facts.recurring && facts.nextVisitBooked ? topicSlots(facts, findings) : [],
  };
}

const MAX_SENTENCES = 6; // six parts exist today; the cap is a guard against a future template edit
// Reading order, and the order parts are dropped in when a paragraph would pass the cap: the
// results line first, then the next-visit line, then the area read.
const SENTENCE_ORDER = Object.freeze(['applied', 'photoRead', 'findings', 'ties', 'results', 'nextVisit']);
const DROP_ORDER = Object.freeze(['results', 'nextVisit', 'photoRead']);

// ── Render: slots -> sentences (a closed set; nothing else is ever printed) ──

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
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
    if (phrase) (POSITIVE_BANDS.includes(a.band) ? good : concerns).push(phrase);
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

// One tie slot -> its fixed sentence(s), or null. The label must be a table label of the slot's own
// kind and the product a table product, so a hand-edited slot prints nothing.
function tieSentence(tie) {
  if (!tie || typeof tie !== 'object') return null;
  if (tie.t === 'tech') {
    return Object.hasOwn(TECH_FOUND_PHRASES, tie.kind) && TECH_PRODUCT[tie.kind] ? SENTENCE.tieTech(TECH_FOUND_PHRASES[tie.kind]) : null;
  }
  if (tie.t !== 'photo' || !Object.hasOwn(KIND_BY_LABEL, tie.label) || KIND_BY_LABEL[tie.label] !== tie.kind) return null;
  if (tie.product == null) return SENTENCE.tieCheck(tie.label);
  if (!Object.hasOwn(TIE_PRODUCT_PHRASES, tie.product) || PRODUCT_FOR_KIND[tie.kind] !== tie.product) return null;
  return (tie.sure === true ? SENTENCE.tieSure : SENTENCE.tieHedged)(tie.label, TIE_PRODUCT_PHRASES[tie.product]);
}

function tiesSentence(slots) {
  const sentences = (Array.isArray(slots.ties) ? slots.ties : []).slice(0, MAX_TIES).map(tieSentence).filter(Boolean);
  return sentences.length ? sentences.join(' ') : null;
}

function nextVisitSentence(slots) {
  if (slots.nextVisit !== true) return null;
  const topics = (Array.isArray(slots.watch) ? slots.watch : []).filter((t) => Object.hasOwn(TOPIC_PHRASES, t)).map((t) => TOPIC_PHRASES[t]);
  return topics.length ? SENTENCE.nextVisit(joinList(topics)) : null;
}

/** Slots -> ordered sentences. Pure; unknown ids and malformed slots print nothing. */
function renderSentences(slots) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return [];
  const applied = appliedSentence(slots);
  const parts = {
    applied,
    photoRead: photoReadSentence(slots),
    findings: findingsSentence(slots),
    ties: tiesSentence(slots),
    results: applied && slots.recurring === true ? SENTENCE.results : null,
    nextVisit: nextVisitSentence(slots),
  };
  // Every template is ONE sentence; the cap is enforced here anyway, dropping the lowest-priority
  // parts first, so a template edit cannot break it.
  const kept = new Set(SENTENCE_ORDER.filter((id) => parts[id]));
  for (const id of DROP_ORDER) if (kept.size > MAX_SENTENCES) kept.delete(id);
  return SENTENCE_ORDER.filter((id) => kept.has(id)).map((id) => parts[id]);
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
  readVersions: READ_VERSIONS,
  budgetMs: BUDGET_MS,
  normalizeInputs: normalizeFacts,
  frozenEntryProblem,
});

async function generateVisitSummary(facts) {
  const composed = composeVisitSummary(facts);
  return composed.ok ? { ...composed, inputsHash: engine.inputsHash(normalizeFacts(facts)) } : composed;
}

// A render depends only on the frozen record (never on the gate, the clock or the renderer), so every pod and
// browser agrees: the text prints when the entry is whole, equals render(slots) under the CURRENT tables and passes
// the screens; otherwise null (the report keeps the generic recap).
const readFrozenVisitSummary = engine.readFrozenTechParagraph;
// PDF cache-key component: '' when nothing prints, else ':tp=<hash of the frozen text>' (the caller renames it).
const visitSummarySignature = engine.techParagraphSignature;

// `args.version` is the version a new entry is written with (4 while GATE_LAWN_REPORT_FACTS is live, else 3).
function createAndFreezeVisitSummary(args) {
  return engine.createAndFreezeTechParagraph({ ...args, deps: { generate: generateVisitSummary, ...(args.deps || {}) } });
}

module.exports = {
  COMPOSER_VERSION,
  FREEZE_KEY,
  FREEZE_VERSION,
  FREEZE_VERSION_TIES,
  BUDGET_MS,
  MAX_TEXT_CHARS,
  MAX_SENTENCES,
  CATEGORY_BY_KIND,
  APPLIED_PHRASES,
  AREA_PHRASES,
  FINDING_PHRASES,
  TIE_PRODUCT_PHRASES,
  TECH_FOUND_PHRASES,
  TOPIC_PHRASES,
  SENTENCE,
  normalizeFacts,
  buildSlots,
  renderSentences,
  render,
  composeVisitSummary,
  generateVisitSummary,
  createAndFreezeVisitSummary,
  readFrozenVisitSummary,
  visitSummarySignature,
  freezeVisitSummary: engine.freezeTechParagraph,
  _test: { frozenEntryProblem, textProblem },
};
