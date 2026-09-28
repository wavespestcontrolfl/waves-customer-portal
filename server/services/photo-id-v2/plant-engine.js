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
  dedupeCandidates, sameCandidateKey, deepestSharedNode,
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
// Host candidates at or above this verified confidence all feed the
// tree/shrub/palm condition index (Codex #5186 r1 P1).
const HOST_UNION_MIN = 0.20;
const SUBJECTS = ['lawn', 'tree_shrub', 'palm'];
// `quality.shows` when the providers disagreed on what the photos show.
const SHOWS_CONFLICTING = 'conflicting';
const DEFAULT_QUALITY = Object.freeze({ usable: true, issue: 'none', shows: null });

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

/** A model's cue citations for `entry`, cleaned against its real numbered
 * id cues: whole numbers in range, each once, and none cited as BOTH seen
 * and not seen — a self-contradicting citation supports neither side
 * (Codex #5186 r1 P1, same rule as the pest engine's
 * `cleanTraitCitations`). Everything downstream (`verified`, evidence,
 * contradiction) reads the cleaned lists. */
function cleanCueCitations(entry, visible, notVisible) {
  const count = idCuesFor(entry).length;
  const valid = (list) => [...new Set((Array.isArray(list) ? list : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= count))];
  const seen = valid(visible);
  const unseen = valid(notVisible);
  const both = new Set(seen.filter((n) => unseen.includes(n)));
  return { cuesVisible: seen.filter((n) => !both.has(n)), cuesNotVisible: unseen.filter((n) => !both.has(n)) };
}

/** A model's off-catalog `group_id`, kept only when it names a real
 * plant-section group that the slot's own index draws from (a turf slot
 * can only climb to `turfgrasses`, a host slot to its host groups) — the
 * same "free-form model output is checked against the catalog" rule the
 * pest engine applies to its own `group_id` (Codex #5186 r1 P2). */
function validSlotGroupId(rawGroupId, indexEntries) {
  const id = String(rawGroupId || '').trim();
  if (!id || !indexEntries.some((e) => e.group === id)) return null;
  const group = catalog.getGroup(id);
  return group && catalog.sectionOf(group) === 'plant' ? id : null;
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
  if (entry) {
    return {
      slug: entry.slug, offCatalogName: null, groupId: entry.group, confidence, entry, ...cleanCueCitations(entry, raw?.cues_visible, raw?.cues_not_visible), checked: false, verified: false,
    };
  }
  return {
    slug: null,
    offCatalogName: String(raw?.off_catalog_name || rawSlug || '').trim() || null,
    groupId: validSlotGroupId(raw?.group_id, indexEntries),
    confidence,
    entry: null,
    cuesVisible: [],
    cuesNotVisible: [],
    checked: false,
    verified: false,
  };
}

/** `verifyJson` is the Ajv-validated Call B response (or `null` on a miss) —
 * callers must validate before calling this (see `validJson(..., 'verifyA')`
 * at the call site), never the raw, unvalidated `dispatch()` result.
 *
 * `checked` — a real cue check produced this confidence; `verified` — that
 * check also cited at least one clean visible cue (what `pretty_sure`
 * requires). A catalog candidate an ANSWERED verify leg left out is marked
 * `uncovered` (Codex #5186 r1 P1): it was asked about and not checked, so it
 * cannot be named at all unless a checked escalation score replaces it (a
 * whole-leg miss leaves the candidate as it was — the escalation trigger and
 * its pretty_sure cap handle that case). */
function mergeIdentityVerify(candidates, verifyJson) {
  if (!Array.isArray(verifyJson?.candidates)) return candidates;
  const bySlug = new Map(verifyJson.candidates.map((v) => [String(v.slug), v]));
  return candidates.map((c) => {
    if (!c.entry) return c;
    const v = bySlug.get(c.slug);
    if (!v) return { ...c, uncovered: true };
    const cleaned = cleanCueCitations(c.entry, v.cues_visible, v.cues_not_visible);
    return {
      ...c, confidence: clamp01(v.confidence), ...cleaned, checked: true, verified: cleaned.cuesVisible.length > 0, uncovered: false,
    };
  });
}

/** Whether an answered verify leg returned a record for EVERY catalog
 * candidate it was asked about — anything less counts as a Gemini miss
 * (escalation), never a successful verification (Codex #5186 r1 P1). */
function verifyCoversAll(verifyJson, catalogCandidates) {
  if (!Array.isArray(verifyJson?.candidates)) return false;
  const covered = new Set(verifyJson.candidates.map((v) => String(v.slug)));
  return catalogCandidates.every((c) => covered.has(c.slug));
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
 * An `uncovered` top (an answered verify leg skipped it, and no checked
 * escalation score replaced it) is never named (Codex #5186 r1 P1).
 */
function identityEntryLevelAnswer(top, { blockPrettySure = false, disagreed = false } = {}) {
  if (disagreed || !top?.entry || top.uncovered || !isApproved(top.entry)) return null;
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
/** Contract §6.6: referrals look at the top 2 only, but ANY displayed
 * possibility needing inspection routes `inspection` (herbicide injury
 * ranked 3rd still does) — pre-push audit on #5186 r1. */
function inspectionCandidateAmong(possibilities) {
  return possibilities.slice(0, 3).find((p) => p.entry.service?.inspection_first || ['inspection', 'specialist'].includes(p.entry.action)) || null;
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
 * `mixed` never resolve to one specific grass. The account fact outranks
 * any photo guess whatever the entry's review status, but its catalog copy
 * reaches the customer only once the entry is owner-approved (see
 * `workupSubjectFor`). */
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

/** The look-alike that separates two of `candidates` — the first approved
 * candidate whose own `look_alikes` names another approved candidate in
 * the same list. */
function lookAlikeBetween(candidates) {
  const approved = candidates.filter((c) => c?.entry && isApproved(c.entry));
  const slugs = new Set(approved.map((c) => c.slug));
  for (const c of approved) {
    const la = (c.entry.look_alikes || []).find((l) => l.slug !== c.slug && slugs.has(l.slug));
    if (la) return la;
  }
  return null;
}

/** The look-alike pair that would settle THIS answer (Codex #5186 r1 P2):
 * the two providers' own tops on a disagreement; the named entry's own
 * first approved look-alike at `likely`; for a group-level answer, a pair
 * among the candidates that support the chosen node — never the global
 * top's look-alike when that top is not what the headline is about. */
function decisiveLookAlike({
  level, nodeId, candidates, disagreementPair,
}) {
  if (disagreementPair) return lookAlikeBetween(disagreementPair);
  if (level === 'entry') {
    const top = candidates[0];
    return (top.entry.look_alikes || []).find((l) => isApproved(catalog.getEntry(l.slug))) || null;
  }
  if (!nodeId) return null;
  const supporters = candidates.filter((c) => c.slug && catalog.lineage(c.slug).some((r) => r.id === nodeId));
  return lookAlikeBetween(supporters);
}

function plantNextPhotoFor(answer, candidates, subject, disagreementPair = null) {
  if (answer.wording === 'pretty_sure') return null;
  const la = decisiveLookAlike({
    level: answer.level, nodeId: answer.node_id, candidates, disagreementPair,
  });
  if (la) return { ask: la.next_photo || null, why: la.difference || null, photo_can_confirm: la.photo_can_confirm !== false };
  return { ask: RETAKE_TEXT[subject], why: 'A clearer photo helps us narrow it down.', photo_can_confirm: true };
}

/** What the combined photo-quality read allows (Codex #5186 r1 P1):
 * `unusable` — a leg flagged the photos unusable or said they show nothing
 * relevant (`combineShows` folds `nothing` into `usable:false`); `blocked` —
 * unusable, OR the providers disagreed on what the photos show (`plant` vs
 * `damage`), so nothing is named. */
function namingGateFor(quality = {}) {
  const unusable = quality.usable === false;
  return { unusable, blocked: unusable || quality.shows === SHOWS_CONFLICTING };
}

const UNKNOWN_IDENTITY_ANSWER = Object.freeze({
  level: 'unknown', node_id: null, wording: 'unknown', headline: UNUSABLE_HEADLINE, subhead: null,
});

function namedIdentityAnswer(named) {
  return {
    answer: {
      level: 'entry',
      node_id: named.entry.slug,
      wording: named.wording,
      headline: `${named.wording === 'pretty_sure' ? "We're pretty sure" : 'Likely'}: ${named.entry.common_name}`,
      subhead: named.entry.scientific_name || null,
    },
    entry: {
      slug: named.entry.slug,
      common_name: named.entry.common_name,
      scientific_name: named.entry.scientific_name || null,
      kind: named.entry.kind,
      verdict: named.entry.verdict,
      what_it_means: named.entry.copy?.what_it_means || null,
      fact: named.entry.copy?.fact || null,
    },
  };
}

/** An unnamed identity's group-level answer. A provider disagreement goes
 * to the two tops' deepest SHARED node (the pest engine's "disagree ->
 * shared node" rule) — never a confidence climb, which can pick a group
 * only one provider supports (Codex pre-push audit on #5186 r1: queen palm
 * vs citrus read "Looks like a palm"); otherwise the lineage climb. */
function groupLevelIdentityAnswer(candidates, disagreementPair) {
  const node = disagreementPair
    ? deepestSharedNode(candidateNodeIdPlant(disagreementPair[0]), candidateNodeIdPlant(disagreementPair[1]))
    : climbPlantLineage(candidates);
  if (!node) return { ...UNKNOWN_IDENTITY_ANSWER };
  return {
    level: node.level, node_id: node.id, wording: 'group_only', headline: `Looks like ${node.generic}`, subhead: null,
  };
}

/** Pure builder for `mode: "identify"` — Layer A only. `candidates` is the
 * final, already-combined (Gemini + OpenAI when escalated), ranked
 * identity-candidate list for ONE identity slot (turf, a weed, or a host
 * plant). An unusable or subject-conflicted photo (`namingGateFor`) gets
 * the unknown answer and a retake prompt, never a named or climbed one —
 * the same gate `buildWorkup` applies (Codex #5186 r1 P1). */
function buildIdentityResult(candidates, {
  subject, currentMonth, blockPrettySure = false, disagreed = false, disagreementPair = null, quality = DEFAULT_QUALITY,
}) {
  if (namingGateFor(quality).blocked) {
    return {
      answer: { ...UNKNOWN_IDENTITY_ANSWER },
      entry: null,
      evidence: { matches: [], still_need: [] },
      candidates: [],
      next_photo: plantNextPhotoFor(UNKNOWN_IDENTITY_ANSWER, [], subject),
      tier: 'needs_more_evidence',
    };
  }
  // A disagreement is never named (Codex pre-push P1 round 2); it resolves
  // to the two providers' shared node instead.
  const pair = disagreed ? disagreementPair : null;
  const named = identityEntryLevelAnswer(candidates[0] || null, { blockPrettySure, disagreed });
  const { answer, entry } = named ? namedIdentityAnswer(named) : { answer: groupLevelIdentityAnswer(candidates, pair), entry: null };
  return {
    answer,
    entry,
    evidence: plantEvidenceFor(candidates),
    candidates: plantCandidatesBlockFor(candidates, currentMonth),
    next_photo: plantNextPhotoFor(answer, candidates, subject, pair),
    tier: answer.level === 'entry' ? 'ai_suggestion' : 'needs_more_evidence',
  };
}

// ── deterministic workup builder (mode: "workup", §6.7) ────────────────────

/** Layer A for the workup: the account turf when on file, else the photo
 * ladder's own slot answer (never when naming is blocked), plus up to 2
 * named weeds. `identityFlags[slot]` carries that slot's escalation
 * uncertainty (Codex pre-push P1 round 2): a disagreement blocks naming it,
 * an unanswered trigger caps it at `likely`. */
function workupSubjectFor({
  subject, turfCandidates = [], weedCandidates = [], hostCandidates = [], context = {}, identityFlags = {},
}, namingBlocked) {
  const accountTurf = subject === 'lawn' ? resolveAccountTurf(context) : null;
  const slot = subject === 'lawn' ? 'turf' : 'host';
  let plant = null;
  if (accountTurf) {
    // Contract §4: unapproved entries are excluded from every answer — the
    // account fact is trusted, but unreviewed catalog copy is not shown
    // (pre-push audit on #5186 r1). An unapproved account turf still
    // outranks any photo guess, so the slot then stays empty.
    plant = isApproved(accountTurf) ? {
      slug: accountTurf.slug, common_name: accountTurf.common_name, scientific_name: accountTurf.scientific_name || null, source: 'account', wording: null,
    } : null;
  } else if (!namingBlocked) {
    const named = identityEntryLevelAnswer((subject === 'lawn' ? turfCandidates : hostCandidates)[0] || null, identityFlags[slot]);
    if (named) {
      plant = {
        slug: named.entry.slug, common_name: named.entry.common_name, scientific_name: named.entry.scientific_name || null, source: 'photo', wording: named.wording,
      };
    }
  }
  const weedFlags = identityFlags.weeds || {};
  const weeds = (subject === 'lawn' && !namingBlocked && !weedFlags.disagreed)
    ? weedCandidates.map((c) => identityEntryLevelAnswer(c, { blockPrettySure: weedFlags.blockPrettySure })).filter(Boolean).slice(0, 2).map((n) => weedWordingLine(n.entry, n.wording))
    : [];
  return { plant, weeds, accountTurf };
}

function workupAnswerFor(namedAnswer, observedTerms, subject) {
  if (namedAnswer) {
    return {
      level: 'entry',
      node_id: namedAnswer.entry.slug,
      wording: namedAnswer.wording,
      headline: `${namedAnswer.wording === 'pretty_sure' ? "We're pretty sure" : 'Likely'}: ${namedAnswer.entry.common_name}`,
      subhead: namedAnswer.entry.kind === 'disorder' ? null : (namedAnswer.entry.scientific_name || null),
      symptom: null,
    };
  }
  const term = observedTerms[0] || null;
  return {
    level: 'symptom', node_id: null, wording: null, headline: term ? symptomHeadlineFor(term, subject) : UNUSABLE_HEADLINE, subhead: null, symptom: term,
  };
}

/**
 * Pure deterministic workup builder. `ctx.possibilities` is the FINAL,
 * already-combined (Gemini + OpenAI when escalated) list of resolved
 * condition/pest candidates (`resolveConditionCandidate` shape), ranked by
 * confidence. See PLANT-ENGINE-CONTRACT.md §6.
 *
 * `ctx.identityFlags` / `ctx.conditionFlags` (`{ disagreed, blockPrettySure }`)
 * carry the escalation uncertainty into the answer (Codex pre-push P1
 * round 2) — a disagreement or an unanswered trigger changes the
 * customer-facing answer, not just an admin-only log line.
 */
function buildWorkup(ctx) {
  const {
    subject, possibilities = [], currentMonth, chips = {}, photosCount = 0, quality = DEFAULT_QUALITY, conditionFlags = {},
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
    .map((p) => ({ ...p, localCtx: { currentMonth, chips, context: ctx.context || {} } }));

  // An unusable photo (a leg said `usable:false` or `shows: nothing`) never
  // carries a named answer, a treatment-shaped next step, a term-based
  // headline or a confident tier; a subject-conflicted one (providers split
  // `plant` vs `damage`) names nothing but keeps its symptom workup.
  const gate = namingGateFor(quality);
  const { plant, weeds, accountTurf } = workupSubjectFor(ctx, gate.blocked);
  const namedAnswer = gate.blocked ? null : namedAnswerFor(allApprovedPossibilities, allApprovedPossibilities[0] || null, conditionFlags);
  const answer = workupAnswerFor(namedAnswer, gate.unusable ? [] : (ctx.observedTerms || []), subject);
  const { hint: nextStepHint, referral } = gate.unusable
    ? { hint: { kind: 'unclear', text: NEXT_STEP_TEMPLATES.unclear }, referral: null }
    : nextStepHintFor(approvedPossibilities);

  return {
    version: 2,
    kind: 'workup',
    catalog_version: catalog.CATALOG_VERSION,
    subject_type: subject,
    tier: answer.level === 'entry' ? 'ai_suggestion' : 'needs_more_evidence',
    subject: { plant, weeds },
    answer,
    observed: observedFor(approvedPossibilities),
    possibilities: approvedPossibilities.map(possibilityBlockFor),
    evidence: { photos: photosCount, chips, account: accountTurf ? { grass_type: accountTurf.slug } : {} },
    settle_it: settleItFor(approvedPossibilities, subject),
    next_step_hint: nextStepHint,
    referral,
    quality: { ...quality },
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

// ── identity slots (turf / weeds for lawn; host for tree_shrub/palm) ───────

const IDENTITY_SLOTS = ['turf', 'weeds', 'host'];
function mapSlots(fn) {
  return Object.fromEntries(IDENTITY_SLOTS.map((slot) => [slot, fn(slot)]));
}
function slotIndexesFor(subject) {
  if (subject === 'lawn') return { turf: turfIndexFor(), weeds: weedIndexFor(), host: [] };
  return { turf: [], weeds: [], host: hostIndexFor(subject) };
}
function byConfidenceDesc(a, b) {
  return b.confidence - a.confidence;
}

/** Escalation provenance for an OpenAI identity candidate (Codex #5186 r1
 * P1): its cue citations are a real check only for a slug OpenAI was GIVEN
 * a numbered cue list for (one Gemini raised — `contextSlugs`); any other
 * catalog slug's numbers index nothing it was shown, so they are dropped and
 * its score stays an unchecked guess. */
function withEscalationProvenance(candidate, contextSlugs) {
  if (!candidate.entry) return candidate;
  if (contextSlugs.has(candidate.slug)) return { ...candidate, checked: true, verified: candidate.cuesVisible.length > 0 };
  return {
    ...candidate, cuesVisible: [], cuesNotVisible: [], checked: false, verified: false,
  };
}

function scoreProvenanceOf(c) {
  return {
    confidence: c.confidence, cuesVisible: c.cuesVisible, cuesNotVisible: c.cuesNotVisible, checked: !!c.checked, verified: !!c.verified, uncovered: !!c.uncovered,
  };
}

/** Which agreeing top's score the combined answer carries (Codex #5186 r1
 * P1): a score whose cue check passed (`verified`) beats one whose did not;
 * between two verified scores, the higher; otherwise Gemini's own stands.
 * The score and its provenance always travel together — never `Math.max`
 * of a checked score with an unchecked one. */
function checkedScoreWinner(gemini, openai) {
  if (gemini.verified && openai.verified) return openai.confidence > gemini.confidence ? openai : gemini;
  return openai.verified ? openai : gemini;
}

const NO_IDENTITY_ESCALATION = Object.freeze({
  disagreed: false, openaiAnswered: false, disagreementPair: null, openaiTop: null,
});

function combineIdentity(geminiCandidates, escalationRaw, indexEntries, contextSlugs = new Set()) {
  if (!Array.isArray(escalationRaw)) return { ...NO_IDENTITY_ESCALATION, candidates: geminiCandidates };
  const openaiCandidates = dedupeCandidates(escalationRaw.map((raw) => withEscalationProvenance(resolveIdentityCandidate(raw, indexEntries), contextSlugs)));
  const openaiTop = openaiCandidates[0] || null;
  const geminiTop = geminiCandidates[0] || null;
  const base = { ...NO_IDENTITY_ESCALATION, openaiAnswered: !!openaiTop, openaiTop };
  if (!openaiTop) return { ...base, candidates: geminiCandidates };
  if (!geminiTop) return { ...base, candidates: openaiCandidates };
  if (sameCandidateKey(geminiTop, openaiTop)) {
    // Both providers' own top is the answer's top; a runner-up with a
    // higher raw number must not displace it.
    const agreed = { ...geminiTop, ...scoreProvenanceOf(checkedScoreWinner(geminiTop, openaiTop)) };
    const rest = dedupeCandidates([...geminiCandidates.slice(1), ...openaiCandidates.slice(1)]).filter((c) => !sameCandidateKey(c, agreed));
    return { ...base, candidates: [agreed, ...rest].slice(0, 3) };
  }
  return {
    ...base,
    candidates: dedupeCandidates([geminiTop, openaiTop, ...geminiCandidates.slice(1), ...openaiCandidates.slice(1)]),
    disagreed: true,
    disagreementPair: [geminiTop, openaiTop],
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
  return [...bySlug.values()].sort(byConfidenceDesc);
}

/** One provider's selected conditions, resolved against `indexEntries` and
 * ranked by confidence — the schema does not enforce descending order, so
 * nothing may read a provider's "top" before this sort. */
function resolvePossibilities(rawList, indexEntries) {
  return (Array.isArray(rawList) ? rawList : [])
    .map((raw) => resolveConditionCandidate(raw, indexEntries))
    .filter(Boolean)
    .sort(byConfidenceDesc);
}

/** Same "agree / disagree is uncertain" combination as `combineIdentity`,
 * for the condition/possibility list. `disagreed` means Gemini's and
 * OpenAI's OWN top pick differ — each provider's list is ranked FIRST
 * (Codex #5186 r1 P1: `[A@0.5, B@0.9]` read A as OpenAI's top), so the
 * agreement check and the merged ranking read the same tops. The contract's
 * escalation "disagree" rule (drop to uncertain, tier needs_more_evidence)
 * applies to conditions the same way it does to identity. */
function combinePossibilities(geminiPossibilities, escalationRaw, indexEntries) {
  if (!Array.isArray(escalationRaw)) return { possibilities: geminiPossibilities, disagreed: false, openaiAnswered: false };
  const geminiRanked = [...geminiPossibilities].sort(byConfidenceDesc);
  const openaiRanked = resolvePossibilities(escalationRaw, indexEntries);
  const geminiTop = geminiRanked[0] || null;
  const openaiTop = openaiRanked[0] || null;
  return {
    possibilities: dedupePossibilities([...geminiRanked, ...openaiRanked]),
    disagreed: !!(geminiTop && openaiTop && geminiTop.slug !== openaiTop.slug),
    openaiAnswered: !!openaiTop,
  };
}

/** Combined `shows` read across the legs that report one (candidates,
 * escalation) — Codex #5186 r1 P1. `nothing` from any leg wins; `both` is
 * compatible with either specific read (and yields to it); two different
 * specific reads (`plant` vs `damage`) are `conflicting`. */
function combineShows(...reads) {
  const present = reads.filter(Boolean);
  if (!present.length) return null;
  if (present.includes('nothing')) return 'nothing';
  const specific = [...new Set(present.filter((s) => s !== 'both'))];
  if (specific.length > 1) return SHOWS_CONFLICTING;
  return specific[0] || 'both';
}

/** Conservative combine across every leg that reported a photo-quality read
 * (candidates, conditions, escalation, a host re-run — Codex pre-push P1
 * round 2: the conditions leg's own read was dropped entirely before). Any
 * leg saying `usable:false` wins; `multiple_subjects` outranks any other
 * issue. A `shows: nothing` read makes the photos unusable too (Codex #5186
 * r1 P1), and the combined `shows` rides along as `quality.shows`. */
function combineQuality(qualityReads = [], showsReads = []) {
  const present = qualityReads.filter(Boolean);
  const shows = combineShows(...showsReads);
  const usable = present.every((q) => q.usable !== false) && shows !== 'nothing';
  const withIssue = present.find((q) => q.issue === 'multiple_subjects') || present.find((q) => q.issue && q.issue !== 'none');
  const fallbackIssue = shows === 'nothing' ? 'subject_unclear' : 'none';
  return { usable, issue: withIssue ? withIssue.issue : fallbackIssue, shows };
}

// ── orchestration (sequential: Gemini candidates -> verify -> Gemini
// conditions -> OpenAI escalation, only when a trigger fires) ──────────────

function runContextFor({
  images, subject, chips, context, now, mode,
}) {
  const deadline = Date.now() + totalBudgetMs();
  const indexes = slotIndexesFor(subject);
  return {
    images,
    subject,
    chips,
    context,
    mode,
    currentMonth: etParts(now).month,
    deadline,
    legTimeoutMs: (legsRemaining) => Math.max(MIN_LEG_TIMEOUT_MS, Math.ceil((deadline - Date.now()) / legsRemaining)),
    indexes,
    indexTexts: {
      turfIndexText: buildCatalogIndexText(indexes.turf),
      weedIndexText: buildCatalogIndexText(indexes.weeds),
      hostIndexText: buildCatalogIndexText(indexes.host),
    },
  };
}

/** Per-slot self-contradiction (Codex #5186 r1 P1): the candidates call's
 * own top pick for THIS slot vs. the verified top catalog candidate of the
 * same slot. Slots are independent — a turf/weed confidence swap is not a
 * contradiction, and a flipped turf answer is one even when a weed outranks
 * both. */
function slotFlipped(call1Slot, verifiedSlot) {
  const rawTop = call1Slot[0];
  const verifiedTop = verifiedSlot.find((c) => c.entry);
  return !!(rawTop?.slug && verifiedTop && verifiedTop.slug !== rawTop.slug);
}

/** Calls A (identity candidates) and B (identity verify). Each identity
 * SLOT resolves against ONLY its own index and is deduped/capped at 3
 * SEPARATELY (Codex pre-push P1, rounds 1-2: a shared capped dedupe let 3
 * higher-confidence weeds discard every turf candidate, and a merged index
 * let a weed slug become the turf identity). */
async function runIdentityLadder(run) {
  const candidatesResult = await callIdentityCandidates(run.images, run.subject, run.indexTexts, run.legTimeoutMs(4));
  const candidatesJson = validJson(candidatesResult, 'candidatesA');
  const call1 = mapSlots((slot) => dedupeCandidates((candidatesJson?.[slot] || []).map((r) => resolveIdentityCandidate(r, run.indexes[slot]))));
  const catalogCandidates = IDENTITY_SLOTS.flatMap((slot) => call1[slot].filter((c) => c.entry));
  const identity = {
    candidatesResult, candidatesJson, verifyResult: null, slots: call1, catalogCandidates, verifyMissed: false, selfContradiction: false,
  };
  if (!catalogCandidates.length) return identity;
  const verifyResult = await callIdentityVerify(run.images, identityContextFor(catalogCandidates), run.legTimeoutMs(3));
  // Codex pre-push P1: Ajv-validated before merging (schema rejection = a
  // miss, contract §5); Codex #5186 r1 P1: an answered verify leg that
  // leaves out a requested candidate is a miss too.
  const verifyJson = validJson(verifyResult, 'verifyA');
  const slots = mapSlots((slot) => dedupeCandidates(mergeIdentityVerify(call1[slot], verifyJson)));
  return {
    ...identity,
    verifyResult,
    slots,
    verifyMissed: !verifyCoversAll(verifyJson, catalogCandidates),
    selfContradiction: IDENTITY_SLOTS.some((slot) => slotFlipped(call1[slot], slots[slot])),
  };
}

/** Host slugs whose conditions enter the tree/shrub/palm condition index:
 * every catalog host candidate still reading >= 0.20 after verification,
 * plus the customer's own `plant_slug` chip (Codex #5186 r1 P1 — so an
 * OpenAI host correction among them is already covered by Call C and the
 * escalation prompt). Only ever used to look up common_problems/hosts,
 * never to NAME anything. */
function viableHostSlugs(run, hostCandidates) {
  if (run.subject === 'lawn') return [];
  const slugs = hostCandidates.filter((c) => c.entry && c.confidence >= HOST_UNION_MIN).map((c) => c.slug);
  if (run.chips.plant_slug) slugs.push(String(run.chips.plant_slug));
  return [...new Set(slugs)];
}

/** `conditionIndexFor` over the UNION of several hosts (no host = the
 * class index). */
function conditionIndexForHosts(subject, hostSlugs = []) {
  if (!hostSlugs.length) return conditionIndexFor(subject, null);
  const bySlug = new Map();
  for (const entry of hostSlugs.flatMap((slug) => conditionIndexFor(subject, slug))) bySlug.set(entry.slug, entry);
  return [...bySlug.values()];
}

function conditionPromptArgs(run, index) {
  return {
    indexLines: index.map((e) => buildConditionIndexLine(e, signatureFor(e))), chips: run.chips, context: run.context, etMonth: run.currentMonth, subject: run.subject,
  };
}

const NO_CONDITIONS = Object.freeze({
  index: [], hostUnion: [], result: null, json: null, possibilities: [], observedTerms: [],
});

/** Call C (condition selection), workup mode only. */
async function runConditionLadder(run, identity) {
  if (run.mode === 'identify') return NO_CONDITIONS;
  const hostUnion = viableHostSlugs(run, identity.slots.host);
  const index = conditionIndexForHosts(run.subject, hostUnion);
  if (!index.length) return { ...NO_CONDITIONS, hostUnion };
  const result = await callConditionSelection(run.images, conditionPromptArgs(run, index), run.legTimeoutMs(2));
  const json = validJson(result, 'conditions');
  return {
    index, hostUnion, result, json, possibilities: resolvePossibilities(json?.candidates, index), observedTerms: json?.observed_terms || [],
  };
}

const REASON_ORDER = ['gemini_missed', 'low_confidence', 'self_contradiction', 'different_outcome_classes'];
function reasonsFrom(pairs) {
  return pairs.filter(([applies]) => applies).map(([, reason]) => reason);
}

/** `low_confidence` is checked per populated slot, off-catalog tops
 * included (Codex pre-push audit on #5186 r1): a confident weed must not
 * suppress the second read an uncertain turf answer needs. */
function identityTriggerReasons(identity) {
  const lowSlot = IDENTITY_SLOTS.some((slot) => identity.slots[slot].length > 0 && identity.slots[slot][0].confidence < escalateBelow());
  return reasonsFrom([
    [!identity.candidatesJson || identity.verifyMissed, 'gemini_missed'],
    [lowSlot, 'low_confidence'],
    [identity.selfContradiction, 'self_contradiction'],
  ]);
}

/** Includes the contract's new trigger: the top two possibilities read
 * different outcome classes (no_cure/regulated vs. the rest — potassium
 * deficiency vs. lethal bronzing, drought vs. chinch bug). */
function conditionTriggerReasons(conditions) {
  const [first, second] = conditions.possibilities;
  return reasonsFrom([
    [conditions.index.length > 0 && !conditions.json, 'gemini_missed'],
    [!!first && first.confidence < escalateBelow(), 'low_confidence'],
    [!!second && outcomeClassOf(first.sig) !== outcomeClassOf(second.sig), 'different_outcome_classes'],
  ]);
}

function escalationPromptArgs(run, identity, conditions) {
  return {
    subject: run.subject,
    ...run.indexTexts,
    indexLines: conditionPromptArgs(run, conditions.index).indexLines,
    identityContext: identityContextFor(identity.catalogCandidates),
    conditionContext: conditions.possibilities.map((p) => buildConditionIndexLine(p.entry, p.sig)),
    chips: run.chips,
    context: run.context,
    etMonth: run.currentMonth,
  };
}

/** Escalation uncertainty for one slot or the condition list — Codex
 * pre-push P1 round 2: an unanswered trigger caps wording at `likely`, a
 * disagreement blocks naming (see `identityEntryLevelAnswer` /
 * `namedAnswerFor`). */
function flagsOf(combined) {
  return {
    disagreed: !!combined.disagreed, blockPrettySure: !combined.openaiAnswered, openaiAnswered: !!combined.openaiAnswered, disagreementPair: combined.disagreementPair || null,
  };
}
function uniformFlags(blockPrettySure) {
  const flags = {
    disagreed: false, blockPrettySure, openaiAnswered: false, disagreementPair: null,
  };
  return { identityFlags: mapSlots(() => ({ ...flags })), conditionFlags: { ...flags } };
}

/** Codex #5186 r1 P1: the tree/shrub/palm condition index is the union of
 * viable hosts, so an OpenAI host correction inside it was already covered.
 * A correction OUTSIDE it gets ONE more Call C against union + corrected
 * host, within what is left of the total budget, recombined with OpenAI's
 * own condition picks; no budget left or a miss falls back to the class
 * index (host-specific conditions for a host neither provider settled on
 * are dropped). */
async function reconcileCorrectedHost(run, conditions, hostCombined, escalationJson, combined) {
  const correctedHost = hostCombined.openaiTop?.entry?.slug || null;
  if (run.mode === 'identify' || !correctedHost || conditions.hostUnion.includes(correctedHost)) return { ...combined, rerun: null };
  const index = conditionIndexForHosts(run.subject, [...conditions.hostUnion, correctedHost]);
  const remainingMs = run.deadline - Date.now();
  const result = remainingMs >= MIN_LEG_TIMEOUT_MS ? await callConditionSelection(run.images, conditionPromptArgs(run, index), remainingMs) : null;
  const json = validJson(result, 'conditions');
  const rerun = { host: correctedHost, result, quality: json?.quality || null };
  if (!json) {
    const classSlugs = new Set(conditionIndexFor(run.subject, null).map((e) => e.slug));
    return { ...combined, possibilities: combined.possibilities.filter((p) => classSlugs.has(p.slug)), rerun };
  }
  // OpenAI's picks are resolved against the index it was actually shown
  // (`conditions.index`) — a condition only the re-run's expanded index
  // lists, and element numbers OpenAI never saw for it, are not evidence
  // (pre-push audit on #5186 r1). New conditions come only from the re-run.
  const recombined = combinePossibilities(resolvePossibilities(json.candidates, index), escalationJson.conditions, conditions.index);
  return { ...recombined, observedTerms: json.observed_terms, rerun };
}

/** Call D (OpenAI escalation) when any trigger fires, plus the per-slot and
 * condition combine. OpenAI unavailable (or Ajv-invalid) entirely: Gemini
 * stands, but nothing escalated may read `pretty_sure`. */
async function runEscalation(run, identity, conditions) {
  const reasons = { identity: identityTriggerReasons(identity), conditions: conditionTriggerReasons(conditions) };
  const base = {
    reasons,
    all: REASON_ORDER.filter((r) => reasons.identity.includes(r) || reasons.conditions.includes(r)),
    result: null,
    json: null,
    rerun: null,
    slots: identity.slots,
    possibilities: conditions.possibilities,
    observedTerms: conditions.observedTerms,
  };
  if (!base.all.length) return { ...base, ...uniformFlags(false) };
  const result = await callEscalation(run.images, escalationPromptArgs(run, identity, conditions), run.legTimeoutMs(1));
  const json = validJson(result, 'escalation');
  if (!json) return { ...base, result, ...uniformFlags(true) };
  const contextSlugs = new Set(identity.catalogCandidates.map((c) => c.slug));
  const combined = mapSlots((slot) => combineIdentity(identity.slots[slot], json[slot], run.indexes[slot], contextSlugs));
  const conditionCombined = await reconcileCorrectedHost(run, conditions, combined.host, json,
    combinePossibilities(conditions.possibilities, json.conditions, conditions.index));
  return {
    ...base,
    result,
    json,
    rerun: conditionCombined.rerun,
    slots: mapSlots((slot) => combined[slot].candidates),
    identityFlags: mapSlots((slot) => flagsOf(combined[slot])),
    conditionFlags: flagsOf(conditionCombined),
    possibilities: conditionCombined.possibilities,
    observedTerms: [json.observed_terms, conditionCombined.observedTerms, conditions.observedTerms].find((t) => t?.length) || [],
  };
}

/** Identify mode's one identity lane (Codex #5186 r1 P1): the host for
 * tree_shrub/palm; for a lawn, whichever of turf/weeds is populated, and
 * the higher verified top confidence when both are (turf on a tie). */
function identifyLaneFor(subject, slots) {
  if (subject !== 'lawn') return 'host';
  const [turfTop] = slots.turf;
  const [weedTop] = slots.weeds;
  if (!weedTop) return 'turf';
  if (!turfTop) return 'weeds';
  return weedTop.confidence > turfTop.confidence ? 'weeds' : 'turf';
}

function assembleIdentity(run, escalation, quality, lane) {
  const built = buildIdentityResult(escalation.slots[lane], {
    subject: run.subject, currentMonth: run.currentMonth, ...escalation.identityFlags[lane], quality,
  });
  return {
    version: 2,
    kind: 'identity',
    subject_type: run.subject,
    tier: built.tier,
    answer: built.answer,
    entry: built.entry,
    evidence: built.evidence,
    candidates: built.candidates,
    next_photo: built.next_photo,
    quality,
  };
}

function assembleWorkup(run, escalation, quality) {
  return buildWorkup({
    subject: run.subject,
    possibilities: escalation.possibilities,
    turfCandidates: escalation.slots.turf,
    weedCandidates: escalation.slots.weeds,
    hostCandidates: escalation.slots.host,
    identityFlags: escalation.identityFlags,
    conditionFlags: escalation.conditionFlags,
    observedTerms: escalation.observedTerms,
    currentMonth: run.currentMonth,
    chips: run.chips,
    context: run.context,
    photosCount: run.images.length,
    quality,
  });
}

function legFailureReason(identity, conditions, escalation) {
  const attempted = [identity.candidatesResult, identity.verifyResult, conditions.result, escalation.result, escalation.rerun?.result].filter(Boolean);
  if (attempted.length && attempted.every((r) => r.reason === 'no_route')) return 'no_route';
  if (!identity.candidatesJson && !escalation.json) return 'vision_unavailable';
  return null;
}

function photoReadFor(identity, conditions, escalation) {
  return combineQuality(
    [identity.candidatesJson?.quality, conditions.json?.quality, escalation.json?.quality, escalation.rerun?.quality],
    [identity.candidatesJson?.shows, escalation.json?.shows],
  );
}

function legInfo(result) {
  if (!result) return null;
  return { ok: !!result.ok, provider: result.provider || null, reason: result.ok ? null : (result.reason || null) };
}

/** Admin-only diagnostics (never merged into `v2`). `disagreed` /
 * `openai_answered` fold in the condition combiner too (Codex #5186 r1 P2),
 * so a symptom fallback caused by a condition disagreement is explained;
 * `identity` / `conditions` break the same flags out per scope with the
 * trigger reasons that scope raised. */
function internalFor(run, { identity, conditions, escalation }, lane) {
  const slotFlags = IDENTITY_SLOTS.map((slot) => escalation.identityFlags[slot]);
  const { conditionFlags } = escalation;
  return {
    models: {
      candidates: legInfo(identity.candidatesResult),
      verify: legInfo(identity.verifyResult),
      conditions: legInfo(conditions.result),
      escalation: legInfo(escalation.result),
      condition_rerun: legInfo(escalation.rerun?.result),
    },
    escalation_triggered: escalation.all.length > 0,
    escalation_reasons: escalation.all,
    disagreed: [...slotFlags, conditionFlags].some((f) => f.disagreed),
    openai_answered: [...slotFlags, conditionFlags].some((f) => f.openaiAnswered),
    identity: {
      ...mapSlots((slot) => ({ disagreed: escalation.identityFlags[slot].disagreed, openai_answered: escalation.identityFlags[slot].openaiAnswered })),
      trigger_reasons: escalation.reasons.identity,
      lane,
    },
    conditions: {
      disagreed: conditionFlags.disagreed,
      openai_answered: conditionFlags.openaiAnswered,
      trigger_reasons: escalation.reasons.conditions,
      host_union: conditions.hostUnion,
      corrected_host: escalation.rerun?.host || null,
    },
    account_turf: run.subject === 'lawn' ? (resolveAccountTurf(run.context)?.slug || null) : null,
  };
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
  if (!SUBJECTS.includes(subject)) return { ok: false, reason: 'invalid_subject' };

  const run = runContextFor({
    images, subject, chips, context, now, mode,
  });
  const identity = await runIdentityLadder(run);
  const conditions = await runConditionLadder(run, identity);
  const escalation = await runEscalation(run, identity, conditions);
  const failure = legFailureReason(identity, conditions, escalation);
  if (failure) return { ok: false, reason: failure };

  const quality = photoReadFor(identity, conditions, escalation);
  const lane = mode === 'identify' ? identifyLaneFor(subject, escalation.slots) : null;
  const v2 = lane ? assembleIdentity(run, escalation, quality, lane) : assembleWorkup(run, escalation, quality);
  return { ok: true, v2, internal: internalFor(run, { identity, conditions, escalation }, lane) };
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
  conditionIndexForHosts,
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
    plantEvidenceFor,
    plantCandidatesBlockFor,
    plantNextPhotoFor,
    combineIdentity,
    combinePossibilities,
    combineQuality,
    combineShows,
    identifyLaneFor,
    verifyCoversAll,
    validJson,
  },
};
