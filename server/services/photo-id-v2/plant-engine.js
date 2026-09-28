/**
 * Photo ID v2 lawn/plant engine (L3 of the Waves lawn/plant photo ID
 * upgrade). Pure orchestration + deterministic workup builder over the
 * species catalog's `plant` and `condition` sections (`../species-catalog.js`,
 * landed by #5143/#5158) — see
 * `~/photo-id-lawn-plant-build-20260927/PLANT-ENGINE-CONTRACT.md` for the
 * full spec this module implements. Sibling of `pest-engine.js`
 * (`~/photo-id-v2-build-20260926/V2-CONTRACT.md`), same model policy
 * (`MODELS.TEXT_POLICIES.photoIdVision`, read at call time).
 *
 * **L3 has no runtime caller.** No route, no gate, no storage — L4 wires
 * `identifyPlantV2` into `POST /api/photo-id/lawn` / `/tree_shrub`.
 *
 * A pest photo asks "what is it?"; a lawn/plant photo asks "what's wrong
 * with it, and what would settle that?" — so the customer object is a
 * WORKUP: what we can see, up to three possible causes with what fits and
 * what doesn't fit yet, the one observation that would settle it, and the
 * next step. A cause is NAMED only when its `required_signature` is fully
 * visible AND the catalog says a photo can confirm it (the naming gate,
 * §6.3) — mechanically the tech-side lawn engine's own rule
 * (`lawn-diagnostic-prompt.js`). Weeds, grass type, host plants and palms
 * still get the pest-style identity answer.
 *
 * Nothing here is model prose reaching the customer: every customer-visible
 * string is a catalog field or one of the fixed templates defined in this
 * file (exported below, per the contract's "one place" rule).
 */

'use strict';

const MODELS = require('../../config/models');
const catalog = require('../species-catalog');
const { isApproved } = require('../species-catalog-approval');
const { dispatch } = require('../llm/call');
const { etParts } = require('../../utils/datetime-et');
const Ajv = require('ajv');
const {
  dedupeCandidates, sameCandidateKey,
} = require('./pest-engine');
const {
  CANDIDATES_A_SCHEMA,
  VERIFY_A_SCHEMA,
  CONDITIONS_SCHEMA,
  ESCALATION_SCHEMA,
  OBSERVED_TERMS,
  buildCatalogIndexText,
  buildIdentityCandidatesPrompt,
  buildIdentityVerifyPrompt,
  buildConditionIndexLine,
  buildConditionSelectionPrompt,
  buildEscalationPrompt,
} = require('./plant-engine-prompts');

const PROMPT_VERSION = 'photo-id-v2-plant-1';
const MAX_OUTPUT_TOKENS = 2048;
const PRETTY_SURE_MIN = 0.80;
const LIKELY_MIN = 0.55;
const LINEAGE_CLIMB_MIN = 0.60;
const OUTCOME_CLASS_ALT_MIN = 0.20;

// ── fixed templates (every customer-visible string not a catalog field) ───

const RETAKE_TEXT = Object.freeze({
  lawn: 'Take the three photos again in better light: the whole area, the edge where bad meets good, and a close-up.',
  tree_shrub: 'Take the three photos again in better light: the whole plant, a close-up of one leaf, and the underside of a leaf or the stem.',
  palm: 'Take the three photos again in better light: the whole palm, the oldest fronds, the newest fronds, and the spear.',
});

const TECHNICIAN_CONFIRM_TEXT = 'A technician confirms this on a visit.';
const LAB_CONFIRM_TEXT = 'A technician collects a sample for a lab test.';

const REFERRAL_TEMPLATES = Object.freeze({
  arborist: 'This needs a licensed arborist or palm specialist; a technician can point you to one.',
  extension_office: 'Your county UF/IFAS Extension office confirms this kind of problem; a technician can help you get it there.',
  report_fdacs: 'This may be a regulated problem. Please report it to the Florida Department of Agriculture and Consumer Services (FDACS).',
});

const NEXT_STEP_TEMPLATES = Object.freeze({
  inspection: 'A technician checks this on your next visit.',
  none: 'No treatment needed; keep an eye on it.',
  // Not in the contract's own examples — this module's own fallback for a
  // possibility that clears none of the other next_step_hint rules, so the
  // field is never left without customer-facing text.
  unclear: "We can't tell from these photos; a technician can take a look on your next visit.",
});

// Contract §6.3's fixed headline table, lawn vs. plant (tree_shrub + palm
// share the "plant" column).
const SYMPTOM_HEADLINES = Object.freeze({
  browning: { lawn: 'Brown patches in the lawn', plant: 'Browning leaves' },
  thinning: { lawn: 'Thinning turf', plant: 'Thinning canopy' },
  yellowing: { lawn: 'Yellowing turf', plant: 'Yellowing leaves' },
  spotting: { lawn: 'Spots on the grass blades', plant: 'Spots on the leaves' },
  wilting: { lawn: 'Wilting turf', plant: 'Wilting' },
  dieback: { lawn: 'Dying patches', plant: 'Branch or frond dieback' },
  weed_pressure: { lawn: 'Weeds in the lawn', plant: null },
  frond_discoloration: { lawn: null, plant: 'Discolored fronds' },
  trunk_damage: { lawn: null, plant: 'Trunk damage' },
  mushrooms: { lawn: 'Mushrooms in the lawn', plant: 'Mushrooms or growths' },
});
const UNUSABLE_HEADLINE = "We couldn't tell from these photos";

function headlineColumnFor(subject) {
  return subject === 'lawn' ? 'lawn' : 'plant';
}

function symptomHeadlineFor(term, subject) {
  const row = SYMPTOM_HEADLINES[term];
  const headline = row ? row[headlineColumnFor(subject)] : null;
  return headline || UNUSABLE_HEADLINE;
}

// Hard-cap rule (tech engine rule, contract §6.3): these read at most
// `likely` from photos alone, whatever the verified confidence.
const HARD_CAP_GROUP = 'turf-diseases';
const HARD_CAP_SLUGS = new Set(['drought-irrigation-stress']);
function isHardCapped(entry, sig) {
  if (sig.isPestPossibility) return true;
  if (entry.group === HARD_CAP_GROUP) return true;
  if (HARD_CAP_SLUGS.has(entry.slug)) return true;
  return entry.kind === 'disorder';
}

// Own design decision (documented in the PR): a pest entry (from `catalog
// reads` §4's "pest possibilities") carries no `condition` block of its own
// — it is read-only, never edited by this module — so its signature is
// synthesized from its own `traits` (as both `elements` and `signs`,
// confirmable_by 'photo', since a pest is a photo-identifiable organism)
// and its `look_alikes` (as `differentials`). It is ALWAYS hard-capped at
// `likely` (see `isHardCapped`), matching the contract's explicit "pest
// possibilities... read at most likely" rule.
function signatureFor(entry) {
  if (entry.condition) {
    const c = entry.condition;
    return {
      elements: c.required_signature?.elements || [],
      confirmableBy: c.required_signature?.confirmable_by || null,
      signatureText: c.required_signature?.text || null,
      signs: c.signs || [],
      symptoms: c.symptoms || [],
      differentials: c.differentials || [],
      fieldTests: c.field_tests || [],
      siteFactors: c.site_factors || [],
      hosts: c.hosts || [],
      outcome: c.outcome || null,
      recoveryNote: c.recovery_note || null,
      isPestPossibility: false,
    };
  }
  const differentials = (entry.look_alikes || []).map((la) => ({
    slug: la.slug, difference: la.difference || null, next_observation: la.next_photo || null, photo_can_confirm: la.photo_can_confirm !== false,
  }));
  return {
    elements: entry.traits || [],
    confirmableBy: 'photo',
    signatureText: (entry.traits || [])[0] || null,
    signs: entry.traits || [],
    symptoms: [],
    differentials,
    fieldTests: [],
    siteFactors: [],
    hosts: [],
    outcome: null,
    recoveryNote: null,
    isPestPossibility: true,
  };
}

// ── catalog access (§4) ────────────────────────────────────────────────

const WEED_GROUPS = ['broadleaf-weeds', 'grassy-weeds', 'sedges'];

function turfIndexFor() {
  return catalog.listEntries({ group: 'turfgrasses' });
}
function weedIndexFor() {
  return WEED_GROUPS.flatMap((g) => catalog.listEntries({ group: g }));
}
function hostIndexFor(subject) {
  if (subject === 'tree_shrub') {
    return [...catalog.listEntries({ group: 'shrubs-trees' }), ...catalog.listEntries({ group: 'palms' })];
  }
  if (subject === 'palm') {
    const sago = catalog.getEntry('sago-palm');
    return [...catalog.listEntries({ group: 'palms' }), ...(sago ? [sago] : [])];
  }
  return [];
}
/** The full identity index a subject draws from (turf + weeds for lawn;
 * host for tree_shrub/palm) — NOT approval-filtered, same as the pest
 * engine's own catalog index (approval is enforced only at naming time). */
function identityIndexFor(subject) {
  if (subject === 'lawn') return [...turfIndexFor(), ...weedIndexFor()];
  return hostIndexFor(subject);
}

function pestPossibilitiesForSubject(subject) {
  const line = subject === 'lawn' ? 'lawn' : 'tree_shrub';
  return catalog.listEntries({ section: 'pest' }).filter((e) => e.service?.line === line);
}

/** Class tokens for a subject/host (contract §4 point 2). */
function classTokensFor(subject, hostEntry) {
  if (subject === 'lawn') return ['turf'];
  if (subject === 'palm') return ['palms'];
  if (subject === 'tree_shrub') {
    const tokens = ['shrubs', 'trees'];
    if (hostEntry && hostEntry.slug === 'citrus') tokens.push('citrus');
    return tokens;
  }
  return [];
}

/**
 * `conditionIndexFor(subject, hostSlug)` — contract §4. A resolved host is
 * one whose catalog entry is OWNER-APPROVED (`isApproved`); an unresolved
 * host (none given, or given but not approved) falls back to the whole
 * class index. Unapproved entries never enter this index at all — a
 * deliberate difference from the identity index above and from the pest
 * engine's own catalog index, per the contract's explicit "excluded from
 * every prompt index and every answer" rule for conditions.
 */
function conditionIndexFor(subject, hostSlug = null) {
  const hostEntry = hostSlug ? catalog.getEntry(hostSlug) : null;
  const resolvedHost = hostEntry && isApproved(hostEntry) ? hostEntry : null;
  const classTokens = classTokensFor(subject, hostEntry);
  const commonProblemEntries = resolvedHost
    ? (resolvedHost.plant?.common_problems || []).map((slug) => catalog.getEntry(slug)).filter(Boolean)
    : [];
  const byHostOrClass = catalog.listEntries({ section: 'condition' }).filter((c) => {
    const hosts = c.condition?.hosts || [];
    if (resolvedHost && hosts.includes(resolvedHost.slug)) return true;
    return classTokens.some((t) => hosts.includes(t));
  });
  const pestPossibilities = pestPossibilitiesForSubject(subject);
  const seen = new Set();
  const deduped = [];
  for (const entry of [...commonProblemEntries, ...byHostOrClass, ...pestPossibilities]) {
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    deduped.push(entry);
  }
  return deduped.filter(isApproved);
}

// ── candidate normalization (identity, Calls A/B) ─────────────────────────

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function toImages(photos) {
  return (photos || []).filter((p) => p && p.data).map((p, i) => ({
    data: p.data,
    mimeType: String(p.mimeType || 'image/jpeg').toLowerCase(),
    label: p.label || `Photo ${i + 1}`,
  }));
}

function idCuesFor(entry) {
  const cues = entry.plant?.id_cues;
  return (cues && cues.length) ? cues : (entry.traits || []);
}

/** Resolve a model's raw identity item against ONLY the slot's own index
 * (turf, weeds, or host — never the whole catalog). Codex pre-push P1: a
 * global `catalog.getEntry(rawSlug)` fallback accepted any existing slug —
 * an unrelated pest or condition entry, or a weed slug returned in the
 * "turf" slot — as a real identity, approval checks notwithstanding. An
 * out-of-slot slug now degrades to an off-catalog candidate, same as any
 * hallucinated one. */
function resolveIdentityCandidate(raw, indexEntries) {
  const rawSlug = String(raw?.slug || '').trim();
  const entry = rawSlug ? (indexEntries.find((e) => e.slug === rawSlug) || null) : null;
  const confidence = clamp01(raw?.confidence);
  const cuesVisible = Array.isArray(raw?.cues_visible) ? raw.cues_visible.filter(Number.isFinite) : [];
  const cuesNotVisible = Array.isArray(raw?.cues_not_visible) ? raw.cues_not_visible.filter(Number.isFinite) : [];
  if (entry) {
    return {
      slug: entry.slug, offCatalogName: null, groupId: entry.group, confidence, entry, cuesVisible, cuesNotVisible, checked: false, verified: false,
    };
  }
  return {
    slug: null,
    offCatalogName: String(raw?.off_catalog_name || rawSlug || '').trim() || null,
    groupId: null,
    confidence,
    entry: null,
    cuesVisible,
    cuesNotVisible,
    checked: false,
    verified: false,
  };
}

function citesARealCue(entry, cuesVisible) {
  const count = idCuesFor(entry).length;
  return (cuesVisible || []).some((n) => Number.isInteger(n) && n >= 1 && n <= count);
}

/** `verifyJson` is the Ajv-validated Call B response (or `null` on a miss) —
 * callers must validate before calling this (see `validJson(..., 'verifyA')`
 * at the call site), never the raw, unvalidated `dispatch()` result. */
function mergeIdentityVerify(candidates, verifyJson) {
  const bySlug = new Map();
  if (Array.isArray(verifyJson?.candidates)) {
    for (const v of verifyJson.candidates) {
      if (v?.slug && typeof v.confidence === 'number') bySlug.set(String(v.slug), v);
    }
  }
  return candidates.map((c) => {
    if (!c.entry) return c;
    const v = bySlug.get(c.slug);
    if (!v) return c;
    const cuesVisible = Array.isArray(v.cues_visible) ? v.cues_visible.filter(Number.isFinite) : [];
    const cuesNotVisible = Array.isArray(v.cues_not_visible) ? v.cues_not_visible.filter(Number.isFinite) : [];
    return {
      ...c, confidence: clamp01(v.confidence), cuesVisible, cuesNotVisible, checked: true, verified: citesARealCue(c.entry, cuesVisible),
    };
  });
}

/** Same threshold ladder as `pest-engine.buildAnswer`'s entry-level rule,
 * for ONE identity slot (turf, one weed, or a host plant): `pretty_sure` at
 * >=0.80, `likely` 0.55-0.80, else null (the caller climbs the lineage
 * instead). Approval-gated.
 *
 * `disagreed` (Gemini/OpenAI escalation split on this slot's own top pick)
 * means this slot has no real answer at all — null, same as no candidate.
 * `blockPrettySure` (an escalation trigger fired for this slot but OpenAI
 * never answered) caps the wording at `likely` even at >=0.80 confidence —
 * the same "never pretty_sure on an unanswered trigger" rule
 * `pest-engine.buildAnswer` enforces (Codex pre-push P1 round 2: escalation
 * uncertainty was recorded in `internal` but never reached either builder).
 */
function identityEntryLevelAnswer(top, { blockPrettySure = false, disagreed = false } = {}) {
  if (disagreed || !top?.entry || !isApproved(top.entry)) return null;
  const blocked = !top.verified || blockPrettySure;
  if (top.confidence >= PRETTY_SURE_MIN && !blocked) return { wording: 'pretty_sure', entry: top.entry };
  if (top.confidence >= LIKELY_MIN) return { wording: 'likely', entry: top.entry };
  return null;
}

// ── condition/possibility selection (Call C) ──────────────────────────────

function resolveConditionCandidate(raw, indexEntries) {
  const rawSlug = String(raw?.slug || '').trim();
  const entry = rawSlug ? (indexEntries.find((e) => e.slug === rawSlug) || null) : null;
  if (!entry) return null;
  const confidence = clamp01(raw?.confidence);
  const listify = (v) => (Array.isArray(v) ? v.filter(Number.isFinite) : []);
  return {
    slug: entry.slug,
    entry,
    sig: signatureFor(entry),
    confidence,
    elementsVisible: new Set(listify(raw?.elements_visible)),
    signsVisible: new Set(listify(raw?.signs_visible)),
    symptomsVisible: new Set(listify(raw?.symptoms_visible)),
  };
}

function outcomeClassOf(sig) {
  return ['no_cure', 'regulated'].includes(sig.outcome) ? 'no_cure_regulated' : 'other';
}

/** Naming gate, contract §6.3, points 1-3 (point 4, the outcome-class
 * cross-check against siblings, is applied by the caller). */
function passesOwnSignatureGate(possibility) {
  const { sig, elementsVisible, confidence } = possibility;
  if (sig.confirmableBy !== 'photo') return false;
  if (!sig.elements.length) return false;
  if (confidence < LIKELY_MIN) return false;
  return sig.elements.every((_, i) => elementsVisible.has(i + 1));
}

/** Whether ANY other possibility with a different outcome class reads
 * >=0.20 confidence — the naming gate's 4th condition. */
function hasConflictingOutcomeClassAlt(possibilities, top) {
  const topClass = outcomeClassOf(top.sig);
  return possibilities.some((p) => p !== top && p.confidence >= OUTCOME_CLASS_ALT_MIN && outcomeClassOf(p.sig) !== topClass);
}

/** `disagreed` (Gemini's and OpenAI's own top condition pick differ) forces
 * no answer at all — the contract's escalation "disagree" rule, applied to
 * conditions the same way `identityEntryLevelAnswer` applies it to identity.
 * `blockPrettySure` (an escalation trigger fired but OpenAI never answered)
 * caps the wording at `likely` even past 0.80 (Codex pre-push P1 round 2). */
function namedAnswerFor(possibilities, top, { blockPrettySure = false, disagreed = false } = {}) {
  if (disagreed || !top || !isApproved(top.entry)) return null;
  if (!passesOwnSignatureGate(top)) return null;
  if (hasConflictingOutcomeClassAlt(possibilities, top)) return null;
  const wording = (top.confidence >= PRETTY_SURE_MIN && !isHardCapped(top.entry, top.sig) && !blockPrettySure) ? 'pretty_sure' : 'likely';
  return { wording, entry: top.entry, sig: top.sig };
}

/** Catalog strings visible for a possibility — elements/signs/symptoms
 * marked visible, deduped, max `limit`. */
function visibleStringsFor(possibility, limit = 3) {
  const { sig, elementsVisible, signsVisible, symptomsVisible } = possibility;
  const picked = [];
  sig.elements.forEach((text, i) => { if (elementsVisible.has(i + 1)) picked.push(text); });
  sig.signs.forEach((text, i) => { if (signsVisible.has(i + 1)) picked.push(text); });
  sig.symptoms.forEach((text, i) => { if (symptomsVisible.has(i + 1)) picked.push(text); });
  return [...new Set(picked)].slice(0, limit);
}

function notYetFor(possibility, limit = 3) {
  const { sig, elementsVisible } = possibility;
  return sig.elements.filter((_, i) => !elementsVisible.has(i + 1)).slice(0, limit);
}

// ── local annotations (§6.2) ───────────────────────────────────────────────

// contract §6.2's fixed frond-pattern slug groups — no generic catalog field
// encodes which fronds a palm nutrient/disease entry shows first, so this
// module names the entries explicitly (documented in the PR).
const FROND_OLDEST_SLUGS = new Set(['potassium-deficiency-palm', 'magnesium-deficiency-palm', 'lethal-bronzing', 'lethal-yellowing']);
const FROND_NEWEST_SLUGS = new Set(['manganese-deficiency-palm', 'boron-deficiency-palm', 'iron-deficiency-palm']);
const FROND_SPEAR_SLUGS = new Set(['palm-bud-rot']);

function localAnnotationsFor(entry, sig, { currentMonth, chips = {}, context = {} } = {}) {
  const tags = [];
  if (Array.isArray(entry.peak_months) && entry.peak_months.includes(currentMonth)) tags.push('peak_season');
  const factors = new Set(sig.siteFactors);
  const watering = Number.isFinite(Number(chips.watering_days)) ? Number(chips.watering_days) : null;
  if ((factors.has('frequent_irrigation') && watering !== null && watering >= 3)
    || (factors.has('infrequent_irrigation') && watering !== null && watering <= 1)) tags.push('fits_watering');
  const recentApplications = new Set([
    chips.recent_application && chips.recent_application !== 'none' && chips.recent_application !== 'not_sure' ? chips.recent_application : null,
    ...(Array.isArray(context.applications) ? context.applications.filter((a) => Number(a.days_ago) <= 21).map((a) => a.kind) : []),
  ].filter(Boolean));
  if ((factors.has('recent_herbicide') && (recentApplications.has('weed_control') || recentApplications.has('herbicide')))
    || (factors.has('recent_fertilizer') && recentApplications.has('fertilizer'))) tags.push('fits_application');
  if ((factors.has('full_sun') && chips.light === 'full_sun') || (factors.has('shade') && (chips.light === 'shade' || chips.light === 'part_shade'))) tags.push('fits_light');
  if ((factors.has('new_sod') || factors.has('deep_planting') || factors.has('wounding')) && chips.recently_planted === true) tags.push('fits_new_planting');
  if ((chips.fronds === 'oldest' && FROND_OLDEST_SLUGS.has(entry.slug))
    || (chips.fronds === 'newest' && FROND_NEWEST_SLUGS.has(entry.slug))
    || (chips.fronds === 'spear' && FROND_SPEAR_SLUGS.has(entry.slug))) tags.push('fits_fronds');
  return tags;
}

// ── settle_it (§6.5) ───────────────────────────────────────────────────────

function fieldTestMatchingText(fieldTests, text) {
  if (!text) return null;
  const normalized = text.toLowerCase();
  return fieldTests.find((ft) => ft.name && normalized.includes(ft.name.toLowerCase())) || null;
}

function fieldTestBlock(ft) {
  return {
    kind: 'field_test', who: ft.who || 'customer', name: ft.name, how: ft.how, reads_as: ft.reads_as, photo_can_confirm: true,
  };
}

function ownSignatureSettleIt(top) {
  const { sig } = top;
  if (sig.confirmableBy === 'photo') return { kind: 'photo', text: sig.signatureText };
  if (sig.confirmableBy === 'field_test' && sig.fieldTests[0]) return fieldTestBlock(sig.fieldTests[0]);
  if (sig.confirmableBy === 'lab') return { kind: 'technician', text: LAB_CONFIRM_TEXT };
  if (sig.confirmableBy === 'technician' || sig.confirmableBy === 'field_test') return { kind: 'technician', text: TECHNICIAN_CONFIRM_TEXT };
  return { kind: 'technician', text: TECHNICIAN_CONFIRM_TEXT };
}

function settleItFor(possibilities, subject) {
  const top = possibilities[0] || null;
  if (!top) return { kind: 'retake', text: RETAKE_TEXT[subject] };
  const second = possibilities[1] || null;
  if (second) {
    const diff = top.sig.differentials.find((d) => d.slug === second.entry.slug);
    if (diff) {
      const matchedTest = fieldTestMatchingText(top.sig.fieldTests, diff.next_observation);
      if (matchedTest) return fieldTestBlock(matchedTest);
      const photoCanConfirm = diff.photo_can_confirm !== false;
      return { kind: photoCanConfirm ? 'photo' : 'technician', text: diff.next_observation || null, photo_can_confirm: photoCanConfirm };
    }
  }
  return ownSignatureSettleIt(top);
}

// ── next_step_hint (§6.6) ───────────────────────────────────────────────────

function referralOutcomeCandidateAmong(possibilities) {
  return possibilities.slice(0, 2).find((p) => p.entry.service?.referral && ['no_cure', 'regulated'].includes(p.sig.outcome)) || null;
}
function inspectionCandidateAmong(possibilities) {
  return possibilities.slice(0, 2).find((p) => p.entry.service?.inspection_first || ['inspection', 'specialist'].includes(p.entry.action)) || null;
}

function nextStepHintFor(possibilities) {
  if (!possibilities.length) return { hint: { kind: 'unclear', text: NEXT_STEP_TEMPLATES.unclear }, referral: null };
  const referralCandidate = referralOutcomeCandidateAmong(possibilities);
  if (referralCandidate) {
    const kind = referralCandidate.entry.service.referral;
    const text = REFERRAL_TEMPLATES[kind] || null;
    return { hint: { kind: 'specialist', text }, referral: text ? { kind, text } : null };
  }
  if (inspectionCandidateAmong(possibilities)) {
    return { hint: { kind: 'inspection', text: NEXT_STEP_TEMPLATES.inspection }, referral: null };
  }
  const top = possibilities[0];
  if (top.entry.action === 'fix_conditions' && (!top.entry.service?.line || top.entry.service.line === 'none')) {
    return { hint: { kind: 'fix_conditions', text: top.sig.recoveryNote || 'Fixing the conditions is the realistic next step; a technician can advise.' }, referral: null };
  }
  if (['watch', 'harmless'].includes(top.entry.verdict) && (!top.entry.service?.line || top.entry.service.line === 'none') && top.entry.action === 'monitor') {
    return { hint: { kind: 'none', text: NEXT_STEP_TEMPLATES.none }, referral: null };
  }
  return { hint: { kind: 'unclear', text: NEXT_STEP_TEMPLATES.unclear }, referral: null };
}

// ── possibilities block (§6.2, §6.4) ────────────────────────────────────────

function possibilityBlockFor(possibility) {
  const { entry, sig, confidence } = possibility;
  return {
    slug: entry.slug,
    common_name: entry.common_name,
    kind: entry.kind,
    strength: confidence >= LINEAGE_CLIMB_MIN ? 'strong' : 'possible',
    outcome: sig.outcome,
    confirmable_by: sig.confirmableBy === 'photo' ? null : sig.confirmableBy,
    fits: visibleStringsFor(possibility),
    not_yet: notYetFor(possibility),
    local: localAnnotationsFor(entry, sig, possibility.localCtx),
    what_it_means: entry.copy?.what_it_means || null,
    verdict: entry.verdict,
    action: entry.action,
  };
}

function observedFor(possibilities) {
  const picked = [];
  for (const p of possibilities) {
    for (const text of visibleStringsFor(p, 5)) {
      if (!picked.includes(text)) picked.push(text);
      if (picked.length >= 3) return picked;
    }
  }
  return picked;
}

// ── subject/weeds identity block (Layer A, §6.1) ──────────────────────────

function weedWordingLine(entry, wording) {
  return {
    slug: entry.slug,
    common_name: entry.common_name,
    scientific_name: entry.scientific_name || null,
    wording,
    verdict: entry.verdict,
    what_it_means: entry.copy?.what_it_means || null,
    fact: entry.copy?.fact || null,
  };
}

// ── account turf resolution (§4 "legacy grass map") ────────────────────────

/** `context.grass_type_on_file` (a lawn scorer value, e.g. `st_augustine`,
 * or already a turfgrass slug) resolved to its catalog entry. `unknown` and
 * `mixed` never resolve to one specific grass. An account fact is trusted
 * regardless of the entry's own review status — it is not a model claim
 * subject to the naming gate, just a known fact about the property (own
 * design decision, documented in the PR). */
function resolveAccountTurf(context = {}) {
  const raw = context.grass_type_on_file;
  if (!raw || raw === 'unknown' || raw === 'mixed') return null;
  const direct = catalog.getEntry(raw);
  if (direct && direct.group === 'turfgrasses') return direct;
  const legacy = catalog.resolveLegacySlug(raw);
  if (legacy?.node?.level === 'entry' && legacy.node.group === 'turfgrasses') return legacy.node;
  return null;
}

// ── identity lineage climb (plant-section-aware; §6.1 fallback) ───────────

function candidateNodeIdPlant(candidate) {
  if (!candidate) return null;
  if (candidate.slug) return candidate.slug;
  if (candidate.groupId) {
    const group = catalog.getGroup(candidate.groupId);
    if (group && catalog.sectionOf(group) === 'plant') return candidate.groupId;
  }
  return null;
}
function sumConfidenceAtNodePlant(candidates, level, id) {
  return candidates.reduce((sum, c) => {
    const nodeId = candidateNodeIdPlant(c);
    if (!nodeId) return sum;
    const hit = catalog.lineage(nodeId).find((r) => r.level === level && r.id === id);
    return hit ? sum + c.confidence : sum;
  }, 0);
}
function allLineageRungsPlant(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const nodeId = candidateNodeIdPlant(c);
    if (!nodeId) continue;
    for (const [depth, rung] of catalog.lineage(nodeId).entries()) {
      if (rung.level === 'entry') continue;
      const key = `${rung.level}:${rung.id}`;
      if (!byKey.has(key)) byKey.set(key, { ...rung, depth });
    }
  }
  return [...byKey.values()];
}
function bestRungAtLevelPlant(candidates, rungs, level) {
  let best = null; let bestSum = 0;
  for (const rung of rungs) {
    if (rung.level !== level) continue;
    const sum = sumConfidenceAtNodePlant(candidates, level, rung.id);
    if (sum >= LINEAGE_CLIMB_MIN && (sum > bestSum || (sum === bestSum && (rung.depth || 0) > (best?.depth || 0)))) {
      best = rung; bestSum = sum;
    }
  }
  return best;
}
/** Section-'plant'-aware equivalent of `pest-engine.climbLineage` — that
 * export cannot be reused unmodified here: its own (unexported)
 * `candidateNodeId` hardcodes `sectionOf(group) === 'pest'` for an
 * off-catalog group answer, which would silently reject every off-catalog
 * turf/weed/host climb (documented reuse decision in the PR). */
function climbPlantLineage(candidates) {
  const rungs = allLineageRungsPlant(candidates);
  return bestRungAtLevelPlant(candidates, rungs, 'subgroup')
    || bestRungAtLevelPlant(candidates, rungs, 'group')
    || bestRungAtLevelPlant(candidates, rungs, 'category')
    || null;
}

// ── mode: "identify" (Layer A only, pest-identity card shape, §6.7) ───────

function plantEvidenceFor(candidates) {
  const top = candidates.find((c) => c.entry && isApproved(c.entry)) || null;
  if (!top) return { matches: [], still_need: [] };
  const cues = idCuesFor(top.entry);
  const pick = (nums) => [...new Set(nums || [])]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= cues.length)
    .sort((a, b) => a - b).slice(0, 3).map((n) => cues[n - 1]);
  return { matches: pick(top.cuesVisible), still_need: pick(top.cuesNotVisible) };
}

function plantCandidatesBlockFor(candidates, currentMonth) {
  return candidates.filter((c) => c.entry).slice(0, 3).map((c) => {
    const approved = isApproved(c.entry);
    const group = catalog.getGroup(c.entry.group);
    const local = c.entry.range === 'common' && Array.isArray(c.entry.active_months) && c.entry.active_months.includes(currentMonth)
      ? 'common_here_now' : (c.entry.range === 'rare' ? 'uncommon_here' : null);
    return {
      slug: approved ? c.entry.slug : null,
      common_name: approved ? c.entry.common_name : (group ? group.generic : null),
      scientific_name: approved ? (c.entry.scientific_name || null) : null,
      strength: c.confidence >= LINEAGE_CLIMB_MIN ? 'strong' : 'possible',
      local,
    };
  });
}

function plantNextPhotoFor(wording, candidates, subject) {
  if (wording === 'pretty_sure') return null;
  const top = candidates[0] || null;
  if (top?.entry && isApproved(top.entry)) {
    const la = (top.entry.look_alikes || []).find((l) => isApproved(catalog.getEntry(l.slug)));
    if (la) return { ask: la.next_photo || null, why: la.difference || null, photo_can_confirm: la.photo_can_confirm !== false };
  }
  return { ask: RETAKE_TEXT[subject], why: 'A clearer photo helps us narrow it down.', photo_can_confirm: true };
}

/** Pure builder for `mode: "identify"` — Layer A only. `candidates` is the
 * final, already-combined (Gemini + OpenAI when escalated), ranked
 * identity-candidate list for ONE identity slot (turf, a weed, or a host
 * plant). */
function buildIdentityResult(candidates, {
  subject, currentMonth, blockPrettySure = false, disagreed = false,
}) {
  const top = candidates[0] || null;
  // A disagreement climbs the lineage exactly like an unnamed candidate
  // would (the pest engine's own "disagree -> shared node" rule) — this
  // builder already falls through to `climbPlantLineage` whenever `named`
  // is null. Codex pre-push P1 round 2.
  const named = identityEntryLevelAnswer(top, { blockPrettySure, disagreed });
  let level; let nodeId; let wording; let headline; let subhead; let entryBlock;
  if (named) {
    level = 'entry'; nodeId = named.entry.slug; wording = named.wording;
    headline = `${wording === 'pretty_sure' ? "We're pretty sure" : 'Likely'}: ${named.entry.common_name}`;
    subhead = named.entry.scientific_name || null;
    entryBlock = {
      slug: named.entry.slug,
      common_name: named.entry.common_name,
      scientific_name: named.entry.scientific_name || null,
      kind: named.entry.kind,
      verdict: named.entry.verdict,
      what_it_means: named.entry.copy?.what_it_means || null,
      fact: named.entry.copy?.fact || null,
    };
  } else {
    const node = climbPlantLineage(candidates);
    level = node ? node.level : 'unknown';
    nodeId = node ? node.id : null;
    wording = node ? 'group_only' : 'unknown';
    headline = node ? `Looks like ${node.generic}` : UNUSABLE_HEADLINE;
    subhead = null;
    entryBlock = null;
  }
  return {
    answer: {
      level, node_id: nodeId, wording, headline, subhead,
    },
    entry: entryBlock,
    evidence: plantEvidenceFor(candidates),
    candidates: plantCandidatesBlockFor(candidates, currentMonth),
    next_photo: plantNextPhotoFor(wording, candidates, subject),
    tier: level === 'entry' ? 'ai_suggestion' : 'needs_more_evidence',
  };
}

// ── deterministic workup builder (mode: "workup", §6.7) ────────────────────

/**
 * Pure deterministic workup builder. `ctx.possibilities` is the FINAL,
 * already-combined (Gemini + OpenAI when escalated) list of resolved
 * condition/pest candidates (`resolveConditionCandidate` shape), ranked by
 * confidence. See PLANT-ENGINE-CONTRACT.md §6.
 */
function buildWorkup(ctx) {
  const {
    subject, possibilities = [], turfCandidates = [], weedCandidates = [], hostCandidates = [],
    currentMonth, chips = {}, context = {}, photosCount = 0, quality = { usable: true, issue: 'none' },
    // Escalation uncertainty (Codex pre-push P1 round 2): recorded in
    // `internal` by the orchestration function, but must ALSO reach the
    // builder — a disagreement or an unanswered trigger changes the
    // customer-facing answer, not just an admin-only log line.
    turfDisagreed = false, weedDisagreed = false, hostDisagreed = false,
    turfBlockPrettySure = false, weedBlockPrettySure = false, hostBlockPrettySure = false,
    possibilitiesDisagreed = false, possibilitiesBlockPrettySure = false,
  } = ctx;

  // Codex pre-push P1: the naming gate's outcome-class check (§6.3 condition
  // 4) must see EVERY approved candidate, not just the displayed top 3 — a
  // 4th-ranked no_cure/regulated candidate at >=0.20 confidence still has to
  // block naming a manageable top possibility. Only the DISPLAY list
  // (possibilities block, observed, settle_it, next_step_hint — all of
  // which the contract itself scopes to "the top 3"/"the top 2") is capped.
  const allApprovedPossibilities = possibilities.filter((p) => isApproved(p.entry))
    .sort((a, b) => b.confidence - a.confidence);
  const approvedPossibilities = allApprovedPossibilities
    .slice(0, 3)
    .map((p) => ({ ...p, localCtx: { currentMonth, chips, context } }));

  // Codex pre-push P1 round 2: a photo the model itself flagged unusable (or
  // that Gemini/OpenAI disagreed on whether it even shows the subject) must
  // never carry a named answer, a treatment-shaped next step, or a
  // confident tier — combineQuality already folds in every attempted leg's
  // own read (candidates, conditions, escalation).
  const qualityBlocksNaming = quality.usable === false;

  // ── subject identity (Layer A) ──
  let plantBlock = null;
  const accountTurf = subject === 'lawn' ? resolveAccountTurf(context) : null;
  if (subject === 'lawn' && accountTurf) {
    plantBlock = {
      slug: accountTurf.slug, common_name: accountTurf.common_name, scientific_name: accountTurf.scientific_name || null, source: 'account', wording: null,
    };
  } else if (!qualityBlocksNaming) {
    const identityCandidates = subject === 'lawn' ? turfCandidates : hostCandidates;
    const identityDisagreed = subject === 'lawn' ? turfDisagreed : hostDisagreed;
    const identityBlockPrettySure = subject === 'lawn' ? turfBlockPrettySure : hostBlockPrettySure;
    const named = identityEntryLevelAnswer(identityCandidates[0] || null, { blockPrettySure: identityBlockPrettySure, disagreed: identityDisagreed });
    if (named) {
      plantBlock = {
        slug: named.entry.slug, common_name: named.entry.common_name, scientific_name: named.entry.scientific_name || null, source: 'photo', wording: named.wording,
      };
    }
  }
  const weeds = (subject === 'lawn' && !qualityBlocksNaming && !weedDisagreed)
    ? weedCandidates.map((c) => identityEntryLevelAnswer(c, { blockPrettySure: weedBlockPrettySure })).filter(Boolean).slice(0, 2).map((n) => weedWordingLine(n.entry, n.wording))
    : [];

  // ── answer (naming gate, §6.3) ──
  const namedAnswer = qualityBlocksNaming ? null : namedAnswerFor(allApprovedPossibilities, allApprovedPossibilities[0] || null, {
    blockPrettySure: possibilitiesBlockPrettySure, disagreed: possibilitiesDisagreed,
  });
  let answer;
  if (namedAnswer) {
    answer = {
      level: 'entry',
      node_id: namedAnswer.entry.slug,
      wording: namedAnswer.wording,
      headline: `${namedAnswer.wording === 'pretty_sure' ? "We're pretty sure" : 'Likely'}: ${namedAnswer.entry.common_name}`,
      subhead: namedAnswer.entry.kind === 'disorder' ? null : (namedAnswer.entry.scientific_name || null),
      symptom: null,
    };
  } else {
    // An unusable photo's own `observed_terms` are not trustworthy either —
    // always the fixed unusable headline, never a term-based guess.
    const observedTermsRaw = qualityBlocksNaming ? [] : (ctx.observedTerms || []);
    const term = observedTermsRaw[0] || null;
    answer = {
      level: 'symptom',
      node_id: null,
      wording: null,
      headline: term ? symptomHeadlineFor(term, subject) : UNUSABLE_HEADLINE,
      subhead: null,
      symptom: term,
    };
  }

  // An unusable photo also never earns a treatment-shaped next step.
  const { hint: nextStepHint, referral } = qualityBlocksNaming
    ? { hint: { kind: 'unclear', text: NEXT_STEP_TEMPLATES.unclear }, referral: null }
    : nextStepHintFor(approvedPossibilities);
  const tier = (answer.level === 'entry' && !qualityBlocksNaming) ? 'ai_suggestion' : 'needs_more_evidence';
  const accountBlock = accountTurf ? { grass_type: accountTurf.slug } : {};

  return {
    version: 2,
    kind: 'workup',
    catalog_version: catalog.CATALOG_VERSION,
    subject_type: subject,
    tier,
    subject: { plant: plantBlock, weeds },
    answer,
    observed: observedFor(approvedPossibilities),
    possibilities: approvedPossibilities.map(possibilityBlockFor),
    evidence: { photos: photosCount, chips, account: accountBlock },
    settle_it: settleItFor(approvedPossibilities, subject),
    next_step_hint: nextStepHint,
    referral,
    quality,
  };
}

// ── model calls (sequential: Gemini candidates -> verify -> Gemini
// conditions -> OpenAI escalation, only when a trigger fires; no Claude
// leg, same policy the pest engine reads) ──────────────────────────────────

const ajv = new Ajv({ strict: false, allErrors: false });
const VALIDATE = {
  candidatesA: ajv.compile(CANDIDATES_A_SCHEMA),
  verifyA: ajv.compile(VERIFY_A_SCHEMA),
  conditions: ajv.compile(CONDITIONS_SCHEMA),
  escalation: ajv.compile(ESCALATION_SCHEMA),
};
/** The leg's JSON when it validates against its schema, else null — an
 * `ok:true` response with a shape the schema rejects is treated exactly
 * like a failed/unavailable leg (never consumed as-is). */
function validJson(result, kind) {
  if (!result?.ok || !result.json) return null;
  return VALIDATE[kind](result.json) ? result.json : null;
}

async function callWithProvider(route, payload) {
  if (!route || !route.provider || !route.model) return { ok: false, reason: 'no_route', provider: route?.provider || null, model: route?.model || null };
  const result = await dispatch(route, payload);
  if (!result) return { ok: false, reason: 'no_response', provider: route.provider, model: route.model };
  return { ...result, provider: route.provider, model: result.model || route.model };
}

const DEFAULT_TOTAL_BUDGET_MS = 4 * 60 * 1000;
const MIN_LEG_TIMEOUT_MS = 1000;
function totalBudgetMs() {
  const raw = Number(process.env.PHOTO_ID_V2_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOTAL_BUDGET_MS;
}
function escalateBelow() {
  const raw = Number(process.env.PHOTO_ID_ESCALATE_BELOW);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.80;
}

async function callIdentityCandidates(images, subject, indexTexts, timeoutMs) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.primary;
  return callWithProvider(route, {
    system: buildIdentityCandidatesPrompt(subject, indexTexts),
    text: `These ${images.length} photo(s) show the same subject from different angles. Identify it.`,
    images,
    jsonMode: true,
    jsonSchema: CANDIDATES_A_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    laneId: 'photo_id_v2_plant_candidates',
    promptVersion: PROMPT_VERSION,
  });
}

async function callIdentityVerify(images, candidateContext, timeoutMs) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.primary;
  return callWithProvider(route, {
    system: buildIdentityVerifyPrompt(candidateContext),
    text: 'Check each candidate above against these same photos.',
    images,
    jsonMode: true,
    jsonSchema: VERIFY_A_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    laneId: 'photo_id_v2_plant_verify',
    promptVersion: PROMPT_VERSION,
  });
}

async function callConditionSelection(images, promptArgs, timeoutMs) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.primary;
  return callWithProvider(route, {
    system: buildConditionSelectionPrompt(promptArgs),
    text: 'Assess these photos against the list above.',
    images,
    jsonMode: true,
    jsonSchema: CONDITIONS_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    laneId: 'photo_id_v2_plant_conditions',
    promptVersion: PROMPT_VERSION,
  });
}

async function callEscalation(images, promptArgs, timeoutMs) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.fallback;
  return callWithProvider(route, {
    system: buildEscalationPrompt(promptArgs),
    text: 'Identify and assess these photos fresh.',
    images,
    jsonMode: true,
    jsonSchema: ESCALATION_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    laneId: 'photo_id_v2_plant_escalation',
    promptVersion: PROMPT_VERSION,
  });
}

function identityContextFor(candidates) {
  return candidates.filter((c) => c.entry).map((c) => ({
    slug: c.slug, common_name: c.entry.common_name, cues: idCuesFor(c.entry), lookAlikeDifferences: (c.entry.look_alikes || []).map((la) => la.difference).filter(Boolean),
  }));
}

function combineIdentity(geminiCandidates, escalationRaw, indexEntries) {
  if (!Array.isArray(escalationRaw)) return { candidates: geminiCandidates, disagreed: false, openaiAnswered: false };
  const openaiCandidates = dedupeCandidates(escalationRaw.map((raw) => resolveIdentityCandidate(raw, indexEntries)));
  const openaiTop = openaiCandidates[0] || null;
  const geminiTop = geminiCandidates[0] || null;
  const openaiAnswered = !!openaiTop;
  if (!openaiTop) return { candidates: geminiCandidates, disagreed: false, openaiAnswered };
  if (!geminiTop) return { candidates: openaiCandidates, disagreed: false, openaiAnswered };
  if (sameCandidateKey(geminiTop, openaiTop)) {
    const bumped = { ...geminiTop, confidence: Math.max(geminiTop.confidence, openaiTop.confidence), verified: geminiTop.verified || openaiTop.verified };
    return { candidates: dedupeCandidates([bumped, ...geminiCandidates.slice(1), ...openaiCandidates.slice(1)]), disagreed: false, openaiAnswered };
  }
  return {
    candidates: dedupeCandidates([geminiTop, openaiTop, ...geminiCandidates.slice(1), ...openaiCandidates.slice(1)]),
    disagreed: true,
    openaiAnswered,
  };
}

/** Dedupe possibilities by slug, keeping the higher-confidence instance —
 * same preference rule as `pest-engine.dedupeCandidates`, but WITHOUT its
 * cap at 3: the naming gate's outcome-class check (§6.3 condition 4) needs
 * every approved candidate, not just the ones that will end up displayed
 * (`buildWorkup` does its own top-3 slice for the display list). Codex
 * pre-push P1: reusing `dedupeCandidates` here silently dropped a
 * 4th-ranked no_cure/regulated candidate before the gate ever saw it. */
function dedupePossibilities(list) {
  const bySlug = new Map();
  for (const p of list) {
    const existing = bySlug.get(p.slug);
    if (!existing || p.confidence > existing.confidence) bySlug.set(p.slug, p);
  }
  return [...bySlug.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Same "agree bumps confidence / disagree is uncertain" combination as
 * `combineIdentity`, for the condition/possibility list. `disagreed` means
 * Gemini's and OpenAI's OWN top pick differ — the contract's escalation
 * "disagree" rule (drop to uncertain, tier needs_more_evidence) applies to
 * conditions the same way it does to identity; `buildWorkup` reads it to
 * force the symptom-level fallback rather than name a possibility neither
 * provider actually agreed was top. */
function combinePossibilities(geminiPossibilities, escalationRaw, indexEntries) {
  if (!Array.isArray(escalationRaw)) return { possibilities: geminiPossibilities, disagreed: false, openaiAnswered: false };
  const openaiPossibilities = escalationRaw.map((raw) => resolveConditionCandidate(raw, indexEntries)).filter(Boolean);
  const geminiTop = geminiPossibilities[0] || null;
  const openaiTop = openaiPossibilities[0] || null;
  const openaiAnswered = !!openaiTop;
  const combined = dedupePossibilities([...geminiPossibilities, ...openaiPossibilities]);
  const disagreed = !!(geminiTop && openaiTop && geminiTop.slug !== openaiTop.slug);
  return { possibilities: combined, disagreed, openaiAnswered };
}

/** Conservative combine across every leg that reported a photo-quality read
 * (candidates, conditions, escalation — Codex pre-push P1 round 2: the
 * conditions leg's own read was dropped entirely before). Any leg saying
 * `usable:false` wins; `multiple_subjects` outranks any other issue. */
function combineQuality(...reads) {
  const present = reads.filter(Boolean);
  if (!present.length) return { usable: true, issue: 'none' };
  const usable = present.every((q) => q.usable !== false);
  const withIssue = present.find((q) => q.issue === 'multiple_subjects') || present.find((q) => q.issue && q.issue !== 'none');
  return { usable, issue: withIssue ? withIssue.issue : 'none' };
}

/**
 * Identify a lawn/plant workup from a customer's photos. Never throws —
 * `{ ok: false, reason }` on `no_photos` / `invalid_subject` /
 * `vision_unavailable` / `no_route`; otherwise `{ ok: true, v2, internal }`.
 * `internal` (which models answered, escalation reasons) must never reach
 * the customer — L4 stores it admin-only, separately from `v2`.
 */
async function identifyPlantV2({
  photos = [], subject, chips = {}, context = {}, now = new Date(), mode = 'workup',
} = {}) {
  const images = toImages(photos);
  if (!images.length) return { ok: false, reason: 'no_photos' };
  if (!['lawn', 'tree_shrub', 'palm'].includes(subject)) return { ok: false, reason: 'invalid_subject' };

  const currentMonth = etParts(now).month;
  const deadline = Date.now() + totalBudgetMs();
  const legTimeoutMs = (legsRemaining) => Math.max(MIN_LEG_TIMEOUT_MS, Math.ceil((deadline - Date.now()) / legsRemaining));

  const turfIndex = subject === 'lawn' ? turfIndexFor() : [];
  const weedIndex = subject === 'lawn' ? weedIndexFor() : [];
  const hostIndex = subject !== 'lawn' ? hostIndexFor(subject) : [];
  const indexTexts = {
    turfIndexText: buildCatalogIndexText(turfIndex),
    weedIndexText: buildCatalogIndexText(weedIndex),
    hostIndexText: buildCatalogIndexText(hostIndex),
  };

  const accountTurf = subject === 'lawn' ? resolveAccountTurf(context) : null;

  const candidatesResult = await callIdentityCandidates(images, subject, indexTexts, legTimeoutMs(4));
  const candidatesJson = validJson(candidatesResult, 'candidatesA');
  // Codex pre-push P1: each identity SLOT (turf / weeds / host) is deduped
  // and capped at 3 SEPARATELY — `dedupeCandidates` itself caps at 3, so
  // combining all three slots into one list before deduping let 3
  // higher-confidence weeds silently discard every turf candidate (or vice
  // versa) before verification ever ran.
  const rawTurf = candidatesJson?.turf || [];
  const rawWeeds = candidatesJson?.weeds || [];
  const rawHost = candidatesJson?.host || [];
  // Codex pre-push P1 (round 2): each slot resolves against ONLY its own
  // index — never the combined one — so a weed slug can't become the turf
  // identity (or vice versa) just because it exists somewhere in the catalog.
  const turfFromCall1 = dedupeCandidates(rawTurf.map((r) => resolveIdentityCandidate(r, turfIndex)));
  const weedsFromCall1 = dedupeCandidates(rawWeeds.map((r) => resolveIdentityCandidate(r, weedIndex)));
  const hostFromCall1 = dedupeCandidates(rawHost.map((r) => resolveIdentityCandidate(r, hostIndex)));
  const identityFromCall1 = [...turfFromCall1, ...weedsFromCall1, ...hostFromCall1];
  const identityCatalogCandidates = identityFromCall1.filter((c) => c.entry);

  let verifyResult = null;
  let verifyJson = null;
  let verifiedIdentity = identityFromCall1;
  if (identityCatalogCandidates.length) {
    verifyResult = await callIdentityVerify(images, identityContextFor(identityCatalogCandidates), legTimeoutMs(3));
    // Codex pre-push P1: VERIFY_A_SCHEMA was compiled but never applied — an
    // `ok:true` malformed verifier response could change confidence and
    // verify an identity unchecked. Ajv-validate before merging, same as
    // every other leg (schema rejection = a miss, contract §5).
    verifyJson = validJson(verifyResult, 'verifyA');
    verifiedIdentity = mergeIdentityVerify(identityFromCall1, verifyJson);
  }
  const verifiedTurf = verifiedIdentity.slice(0, turfFromCall1.length);
  const verifiedWeeds = verifiedIdentity.slice(turfFromCall1.length, turfFromCall1.length + weedsFromCall1.length);
  const verifiedHost = verifiedIdentity.slice(turfFromCall1.length + weedsFromCall1.length);
  const turfCandidates = dedupeCandidates(verifiedTurf);
  const weedCandidates = dedupeCandidates(verifiedWeeds);
  const hostCandidates = dedupeCandidates(verifiedHost);

  // The host slug feeding `conditionIndexFor`: the resolved (even if
  // unapproved) top host candidate, else the customer's own `plant_slug`
  // chip — either way, only used to look up common_problems/hosts, never to
  // NAME anything (naming stays gated by `isApproved` downstream).
  const hostSlugForIndex = subject === 'lawn'
    ? null
    : (hostCandidates[0]?.entry?.slug || chips.plant_slug || null);
  const conditionIndex = mode === 'identify' ? [] : conditionIndexFor(subject, hostSlugForIndex);
  const conditionIndexLines = conditionIndex.map((e) => buildConditionIndexLine(e, signatureFor(e)));

  let conditionsResult = null;
  let conditionsJson = null;
  let possibilitiesFromCall1 = [];
  let observedTerms = [];
  if (mode !== 'identify' && conditionIndex.length) {
    conditionsResult = await callConditionSelection(images, {
      indexLines: conditionIndexLines, chips, context, etMonth: currentMonth, subject,
    }, legTimeoutMs(2));
    conditionsJson = validJson(conditionsResult, 'conditions');
    possibilitiesFromCall1 = (conditionsJson?.candidates || [])
      .map((raw) => resolveConditionCandidate(raw, conditionIndex))
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence);
    observedTerms = conditionsJson?.observed_terms || [];
  }

  // ── escalation triggers (§5 Call D) ──
  const identityTop = verifiedIdentity.filter((c) => c.entry).sort((a, b) => b.confidence - a.confidence)[0] || null;
  const topConditionConfidence = possibilitiesFromCall1[0]?.confidence ?? null;
  const identityConfidence = identityTop?.confidence ?? null;
  const geminiMissed = [
    !candidatesJson,
    identityCatalogCandidates.length > 0 && !verifyJson,
    mode !== 'identify' && conditionIndex.length > 0 && !conditionsJson,
  ].includes(true);
  const lowConfidence = [identityConfidence, topConditionConfidence].some((c) => c !== null && c < escalateBelow());
  // A verify call whose top candidate disagrees with the candidates call's
  // own raw top (same self-contradiction shape pest-engine checks, applied
  // to identity only — conditions have no separate verify leg to contradict).
  const rawIdentityTop = [...rawTurf, ...rawWeeds, ...rawHost].sort((a, b) => clamp01(b.confidence) - clamp01(a.confidence))[0] || null;
  const selfContradiction = !!(rawIdentityTop?.slug && identityTop && identityTop.slug !== rawIdentityTop.slug);
  // NEW trigger (contract §5): the top two possibilities read different
  // outcome classes (no_cure/regulated vs. the rest) — potassium deficiency
  // vs. lethal bronzing, drought vs. chinch bug.
  const outcomeClassSplit = possibilitiesFromCall1.length >= 2
    && outcomeClassOf(possibilitiesFromCall1[0].sig) !== outcomeClassOf(possibilitiesFromCall1[1].sig);

  const escalationReasons = [
    [geminiMissed, 'gemini_missed'],
    [lowConfidence, 'low_confidence'],
    [selfContradiction, 'self_contradiction'],
    [outcomeClassSplit, 'different_outcome_classes'],
  ].filter(([applies]) => applies).map(([, reason]) => reason);
  const escalationTriggered = escalationReasons.length > 0;

  let finalIdentity = { turf: turfCandidates, weed: weedCandidates, host: hostCandidates };
  let finalPossibilities = possibilitiesFromCall1;
  let disagreed = false;
  let escalationResult = null;
  let escalationJson = null;
  let openaiAnswered = false;
  // Escalation uncertainty per slot — Codex pre-push P1 round 2: recorded
  // for `internal` before, but never reached either builder. An unanswered
  // trigger caps that slot's wording at `likely`; a disagreement blocks
  // naming it at all (see `identityEntryLevelAnswer` / `namedAnswerFor`).
  let turfDisagreed = false; let weedDisagreed = false; let hostDisagreed = false;
  let turfBlockPrettySure = false; let weedBlockPrettySure = false; let hostBlockPrettySure = false;
  let possibilitiesDisagreed = false; let possibilitiesBlockPrettySure = false;

  if (escalationTriggered) {
    escalationResult = await callEscalation(images, {
      subject,
      turfIndexText: indexTexts.turfIndexText,
      weedIndexText: indexTexts.weedIndexText,
      hostIndexText: indexTexts.hostIndexText,
      indexLines: conditionIndexLines,
      identityContext: identityContextFor(identityCatalogCandidates),
      conditionContext: possibilitiesFromCall1.map((p) => buildConditionIndexLine(p.entry, p.sig)),
      chips,
      context,
      etMonth: currentMonth,
    }, legTimeoutMs(1));
    escalationJson = validJson(escalationResult, 'escalation');
    if (escalationJson) {
      // Codex pre-push P1 round 2: each slot combines against its OWN index
      // only (never the merged one) — same reasoning as Call A's resolution.
      const turfCombined = combineIdentity(turfCandidates, escalationJson.turf, turfIndex);
      const weedCombined = combineIdentity(weedCandidates, escalationJson.weeds, weedIndex);
      const hostCombined = combineIdentity(hostCandidates, escalationJson.host, hostIndex);
      finalIdentity = { turf: turfCombined.candidates, weed: weedCombined.candidates, host: hostCombined.candidates };
      disagreed = turfCombined.disagreed || weedCombined.disagreed || hostCombined.disagreed;
      openaiAnswered = turfCombined.openaiAnswered || weedCombined.openaiAnswered || hostCombined.openaiAnswered;
      turfDisagreed = turfCombined.disagreed; weedDisagreed = weedCombined.disagreed; hostDisagreed = hostCombined.disagreed;
      turfBlockPrettySure = !turfCombined.openaiAnswered; weedBlockPrettySure = !weedCombined.openaiAnswered; hostBlockPrettySure = !hostCombined.openaiAnswered;

      const possibilitiesCombined = combinePossibilities(possibilitiesFromCall1, escalationJson.conditions, conditionIndex);
      finalPossibilities = possibilitiesCombined.possibilities;
      possibilitiesDisagreed = possibilitiesCombined.disagreed;
      possibilitiesBlockPrettySure = !possibilitiesCombined.openaiAnswered;
      if (escalationJson.observed_terms?.length) observedTerms = escalationJson.observed_terms;
    } else {
      // OpenAI unavailable (or answered something Ajv-invalid) entirely — no
      // disagreement is possible, but a trigger fired and got no real
      // second opinion, so nothing escalated may read `pretty_sure`.
      turfBlockPrettySure = true; weedBlockPrettySure = true; hostBlockPrettySure = true; possibilitiesBlockPrettySure = true;
    }
  }

  const attemptedLegs = [candidatesResult, verifyResult, conditionsResult, escalationResult].filter(Boolean);
  if (attemptedLegs.length && attemptedLegs.every((r) => r.reason === 'no_route')) {
    return { ok: false, reason: 'no_route' };
  }
  if ([candidatesJson, escalationJson].every((r) => !r)) {
    return { ok: false, reason: 'vision_unavailable' };
  }

  // Codex pre-push P1 round 2: the conditions leg's own photo-quality read
  // was dropped entirely before — every leg that could have reported one
  // now feeds the combine, so a `usable:false` from ANY of them gates
  // naming (see `buildWorkup`'s `qualityBlocksNaming`).
  const quality = combineQuality(candidatesJson?.quality, conditionsJson?.quality, escalationJson?.quality);

  let v2;
  if (mode === 'identify') {
    const identityCandidates = subject === 'lawn' ? finalIdentity.turf : finalIdentity.host;
    const identityDisagreed = subject === 'lawn' ? turfDisagreed : hostDisagreed;
    const identityBlockPrettySure = subject === 'lawn' ? turfBlockPrettySure : hostBlockPrettySure;
    const built = buildIdentityResult(identityCandidates, {
      subject, currentMonth, blockPrettySure: identityBlockPrettySure, disagreed: identityDisagreed,
    });
    v2 = {
      version: 2, kind: 'identity', subject_type: subject, tier: built.tier, answer: built.answer, entry: built.entry, candidates: built.candidates, next_photo: built.next_photo, quality,
    };
  } else {
    v2 = buildWorkup({
      subject,
      possibilities: finalPossibilities,
      turfCandidates: finalIdentity.turf,
      weedCandidates: finalIdentity.weed,
      hostCandidates: finalIdentity.host,
      turfDisagreed,
      weedDisagreed,
      hostDisagreed,
      turfBlockPrettySure,
      weedBlockPrettySure,
      hostBlockPrettySure,
      possibilitiesDisagreed,
      possibilitiesBlockPrettySure,
      observedTerms,
      currentMonth,
      chips,
      context,
      photosCount: images.length,
      quality,
    });
  }

  const internal = {
    models: {
      candidates: { ok: !!candidatesResult.ok, provider: candidatesResult.provider || null, reason: candidatesResult.ok ? null : (candidatesResult.reason || null) },
      verify: verifyResult ? { ok: !!verifyResult.ok, provider: verifyResult.provider || null, reason: verifyResult.ok ? null : (verifyResult.reason || null) } : null,
      conditions: conditionsResult ? { ok: !!conditionsResult.ok, provider: conditionsResult.provider || null, reason: conditionsResult.ok ? null : (conditionsResult.reason || null) } : null,
      escalation: escalationResult ? { ok: !!escalationResult.ok, provider: escalationResult.provider || null, reason: escalationResult.ok ? null : (escalationResult.reason || null) } : null,
    },
    escalation_triggered: escalationTriggered,
    escalation_reasons: escalationReasons,
    disagreed,
    openai_answered: openaiAnswered,
    account_turf: accountTurf?.slug || null,
  };

  return { ok: true, v2, internal };
}

module.exports = {
  identifyPlantV2,
  buildWorkup,
  buildIdentityResult,
  resolveAccountTurf,
  climbPlantLineage,
  // catalog access
  turfIndexFor,
  weedIndexFor,
  hostIndexFor,
  identityIndexFor,
  pestPossibilitiesForSubject,
  classTokensFor,
  conditionIndexFor,
  // deterministic pieces (unit-tested, contract §8)
  signatureFor,
  outcomeClassOf,
  isHardCapped,
  passesOwnSignatureGate,
  hasConflictingOutcomeClassAlt,
  namedAnswerFor,
  visibleStringsFor,
  notYetFor,
  localAnnotationsFor,
  settleItFor,
  nextStepHintFor,
  possibilityBlockFor,
  observedFor,
  symptomHeadlineFor,
  headlineColumnFor,
  identityEntryLevelAnswer,
  weedWordingLine,
  resolveConditionCandidate,
  resolveIdentityCandidate,
  mergeIdentityVerify,
  idCuesFor,
  toImages,
  // templates (exported per the contract's "one place" rule)
  RETAKE_TEXT,
  TECHNICIAN_CONFIRM_TEXT,
  LAB_CONFIRM_TEXT,
  REFERRAL_TEMPLATES,
  NEXT_STEP_TEMPLATES,
  SYMPTOM_HEADLINES,
  UNUSABLE_HEADLINE,
  OBSERVED_TERMS,
  escalateBelow,
  _test: {
    plantEvidenceFor, plantCandidatesBlockFor, plantNextPhotoFor, combineIdentity, combinePossibilities, combineQuality, validJson,
  },
};
