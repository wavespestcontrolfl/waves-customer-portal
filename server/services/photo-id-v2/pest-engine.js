/**
 * Photo ID v2 pest engine (PR-2a of the Waves photo ID v2 upgrade).
 *
 * Pure orchestration + deterministic answer builder over the species catalog
 * (`../species-catalog.js`, PR-1). NOTHING here has a runtime caller yet — no
 * route, no gate — see `~/photo-id-v2-build-20260926/V2-CONTRACT.md` for the
 * full spec this module implements (engine steps 1–4, hard rules, the `v2`
 * response shape, and the v1-column mapping). PR-2b wires this into
 * `server/routes/photo-id.js` behind `GATE_PHOTO_ID_V2`.
 *
 * Model calls: by default (owner 2026-10-01) Gemini candidates alone, with
 * OpenAI only when Gemini returns nothing (see `geminiOnly`). With
 * PHOTO_ID_V2_LADDER=full (steps 1–3): Gemini candidates → Gemini verify
 * (only when ≥1 catalog candidate) → OpenAI escalation (only when a trigger
 * fires),
 * SEQUENTIAL, never parallel, no Claude leg — the same deliberate departure
 * from the Claude-fallback rule as `lawn-visit-assessment.js`
 * (`MODELS.TEXT_POLICIES.photoIdPestV2`, else `photoIdVision` — this module
 * reads it at call time so it builds and tests independently of whichever
 * lane lands first; an absent policy degrades every leg to `no_route`,
 * exactly like `dispatch()` already handles a missing route).
 *
 * The answer builder (step 4) is a pure function of already-resolved
 * candidate data — no model prose reaches it, and nothing it returns is
 * model prose either: every customer-visible string is a catalog field, a
 * fixed template (verdict labels, referral text, headline templates), or a
 * cited catalog trait. `internal` (which models answered, why escalation
 * did or didn't fire) is a SEPARATE return value from `v2` and must never be
 * merged into it — PR-2b stores `internal` server-side only.
 */

'use strict';

const MODELS = require('../../config/models');
const catalog = require('../species-catalog');
const { isApproved } = require('../species-catalog-approval');
const { dispatch } = require('../llm/call');
const { etParts } = require('../../utils/datetime-et');
const { PEST_LIBRARY } = require('../pest-identification');
const Ajv = require('ajv');
const {
  CANDIDATES_SCHEMA,
  VERIFY_SCHEMA,
  ESCALATION_SCHEMA,
  buildCatalogIndexText,
  buildCandidatesSystemPrompt,
  buildVerifySystemPrompt,
  buildEscalationSystemPrompt,
} = require('./pest-engine-prompts');

const PROMPT_VERSION = 'photo-id-v2-pest-1';
// Gemini 3.x Flash always thinks, and its reasoning shares this budget with
// the JSON answer. At 2048 a customer's chinch bug photo came back cut off
// (gemini_incomplete, 2026-10-01), so the read fell to OpenAI alone and
// climbed to "a true bug". Same cap as the v1 engine's vision leg.
const MAX_OUTPUT_TOKENS = 8192;
// Gemini thinks at MEDIUM by default. On the same chinch bug photo
// (2026-10-01) MEDIUM spent 5–7k reasoning tokens and ~30 s on the
// candidates leg alone; LOW answered in ~2 s with the same top read. The
// customer waits on every leg, and OpenAI escalation is the second look.
const GEMINI_THINKING_LEVEL = 'LOW';
const SITE_BASE_URL = 'https://www.wavespestcontrol.com/pest-identifier/';
const PRETTY_SURE_MIN = 0.80;
const HARMLESS_PRETTY_SURE_MIN = 0.70;
const LIKELY_MIN = 0.55;
const LINEAGE_CLIMB_MIN = 0.60;
const CONSEQUENTIAL_ALT_MIN = 0.20;
const LOOK_ALIKE_CLOSE_SPREAD = 0.25;

const VERDICT_LABELS = {
  ally: 'Helpful — leave it',
  harmless: 'Harmless',
  watch: 'Keep an eye on it',
  call: 'Worth a pro look',
};

// Contract delta 2026-09-26 #2 — fixed labels for the new catalog
// role/risk/action fields, added to `v2.entry`. Never model output.
const ROLE_LABELS = {
  beneficial: 'Beneficial',
  harmless_visitor: 'Harmless visitor',
  nuisance: 'Nuisance',
  plant_pest: 'Plant pest',
  lawn_pest: 'Lawn pest',
  structural_pest: 'Structural pest',
  health_pest: 'Health pest',
  stinging_pest: 'Stinging pest',
  wildlife: 'Wildlife',
  protected_wildlife: 'Protected wildlife',
};
const RISK_LABELS = {
  low: 'Low risk when left alone',
  defensive: 'Can bite or sting if handled or disturbed',
  irritant: 'Can irritate skin or eyes',
  medical: 'Can cause a medically significant reaction',
};
const ACTION_LABELS = {
  leave_alone: 'Leave it alone',
  monitor: 'Keep an eye on it',
  fix_conditions: 'Fix the conditions that draw it',
  inspection: 'Get an inspection',
  specialist: 'Call a specialist',
  report: 'Report it',
};

// Fixed template text per referral kind (V2-CONTRACT.md "referral: null or
// { kind, text } ... fixed template text per kind") — never model output.
const REFERRAL_TEMPLATES = {
  bee_relocation: "Honey bees are protected pollinators we don't spray. We refer you to a licensed bee removal/relocation specialist who can safely relocate the colony.",
  wildlife_trapper: 'This is a wildlife visitor, not something pest control treats. We refer you to a licensed nuisance wildlife trapper for safe removal.',
  report_fwc: 'Please report this sighting to the Florida Fish and Wildlife Conservation Commission (FWC) rather than handling it yourself.',
  report_fdacs: 'This may be a regulated pest of concern. Please report it to the Florida Department of Agriculture and Consumer Services (FDACS).',
  protected_leave_alone: 'This animal and its burrow are protected by Florida law. Please leave it undisturbed — no treatment is needed here.',
  // CDC: bites, scratches, or waking with a bat in the room need prompt
  // medical/public-health assessment. FWC: exclusion is Florida's only legal
  // removal method and is restricted during maternity season.
  bat_exclusion: 'Bats can carry rabies. If you are bitten or scratched, or wake up with a bat in the room, contact a healthcare professional or local health department right away. Do not try to touch, trap, or handle it yourself. In Florida, exclusion is the only legal removal method and is restricted during maternity season; we refer you to a licensed wildlife professional.',
};

const DEFAULT_GENERIC_COMPATIBILITY = Object.freeze({
  safety: Object.freeze({ stinging: false, venomous: false, disease_vector: false, structural_threat: false }),
  serviceLine: 'pest',
  serviceKey: null,
  serviceLabel: 'Pest Consultation',
  inspectionRequired: true,
  urgency: 'low',
});

// An answer that names no approved entry (an unreviewed species, a spread of
// candidates, or an unknown) shows ONLY these fixed templates: customer text
// comes from owner-approved entries or from here, never from group prose. A
// group's prose would have to stay right for every species under it,
// reviewed or not, and each new species broke a different group's text.
// The line is assembled from fixed hazard-class clauses, each chosen when
// ANY entry under the answered node carries that hazard, so a node is
// always triaged for its worst member (Codex #5106 r1).
const UNNAMED_SAFETY_CLAUSES = Object.freeze({
  base: "Until we know exactly what this is, keep your distance, don't touch it, and keep kids and pets away.",
  // Venomous biters (snakes, widows, recluse): a bite needs care now.
  venomousBite: 'If anyone is bitten, call 911 or get emergency medical care right away, even if it seems minor at first; for a sting or scratch, wash the area and call a doctor, and call 911 for trouble breathing or a severe reaction.',
  general: 'If anyone is bitten, stung or scratched, wash the area and call a doctor; call 911 for trouble breathing or a severe reaction.',
  // Wild mammals that bite (raccoons, bats, squirrels, opossums).
  rabies: 'Wild mammals can carry rabies: if one bites or scratches anyone, wash the wound with soap and water and see a doctor or call the health department right away.',
  // CDC: a bat bite can go unnoticed, so possible contact needs assessment.
  bat: 'A bat bite can be too small to notice: if anyone wakes up with a bat in the room or may have touched one, call a doctor or the health department right away, even without a visible bite.',
  irritant: 'If it touches bare skin or anything from it gets in the eyes, wash the skin with soap and water or rinse the eyes with clean water right away, and call a doctor if pain, redness or vision trouble lasts.',
  allergen: 'People with allergies or asthma can react more strongly; call 911 for trouble breathing.',
  vector: 'Wash your hands after any contact, and if anyone gets sick after a bite or contact, tell their doctor about it.',
  pets: 'If a pet bites, licks or mouths it, call your vet right away.',
  protected: "It may be protected by law, so don't harm, trap or move it or its nest or burrow.",
});
const UNNAMED_SAFETY_LINE = `${UNNAMED_SAFETY_CLAUSES.base} ${UNNAMED_SAFETY_CLAUSES.general}`;
const UNNAMED_NEXT_PHOTO = Object.freeze({
  ask: "From a safe distance, zoom in so it fills the frame and take one more photo in good light. Don't move closer or touch it.",
  why: 'A sharper photo helps us narrow it down.',
  photo_can_confirm: true,
});

// Every catalog entry under each node (entries, subgroups, groups and
// categories), reviewed or not: an unnamed answer's safety line and v1
// columns are derived from all of them, never from one group's own text.
const NODE_MEMBERS = (() => {
  const members = new Map();
  for (const entry of catalog.listEntries({ section: 'pest' })) {
    for (const { id } of catalog.lineage(entry.slug)) {
      if (!members.has(id)) members.set(id, []);
      members.get(id).push(entry);
    }
  }
  return members;
})();

function keepsDistance(entry) {
  return (!!entry.risk && entry.risk !== 'low') || !!entry.safety?.protected
    || entry.role === 'wildlife' || entry.role === 'protected_wildlife';
}

function isVenomousBiter(entry) {
  const safety = entry.safety || {};
  return !!safety.venomous && !!safety.bites && !safety.stings && entry.risk === 'medical';
}

function isRabiesRisk(entry) {
  return !!entry.safety?.bites && catalog.lineage(entry.slug).some((rung) => rung.id === 'wild-mammals');
}

// Each hazard an entry can carry, and the fixed clause that covers it. A
// node's line includes every clause any member triggers, so no exposure a
// draft entry's own prose would have covered goes unanswered.
const HAZARD_CLAUSES = [
  ['rabies', isRabiesRisk],
  ['bat', (entry) => catalog.lineage(entry.slug).some((rung) => rung.id === 'bats')],
  ['irritant', (entry) => !!entry.safety?.irritant],
  ['allergen', (entry) => !!entry.safety?.allergen],
  ['vector', (entry) => !!entry.safety?.disease_vector],
  ['pets', (entry) => !!entry.safety?.toxic_to_pets],
  ['protected', (entry) => !!entry.safety?.protected],
];

function clausesFor(entry) {
  return HAZARD_CLAUSES.filter(([, applies]) => applies(entry)).map(([key]) => key);
}

// The entries an unnamed answer's safety line is triaged for: the catalog
// species the models named under the answered node, plus each one's catalog
// look-alikes. Owner 2026-10-01: a "true bug" climb from a chinch bug read
// told the customer to call 911 because kissing and wheel bugs share the
// group; a sibling no model named and the catalog never pairs with the read
// does not set the warning. Any supporting read that is not a catalog entry
// (an off-catalog name) could be anything under the node, so the node's
// whole membership applies, as it does when nothing supports the node.
// Look-alike pairs are authored one way (little fire ant lists pharaoh ant,
// not the reverse), so the triage reads both directions.
const LOOK_ALIKES_EITHER_WAY = (() => {
  const edges = new Map();
  const link = (a, b) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a).add(b);
  };
  for (const entry of catalog.listEntries()) {
    for (const la of entry.look_alikes || []) {
      link(entry.slug, la.slug);
      link(la.slug, entry.slug);
    }
  }
  return edges;
})();

function safetyMembersFor(nodeId, supporting = []) {
  const all = NODE_MEMBERS.get(nodeId) || [];
  if (!supporting.length || supporting.some((c) => !c.entry)) return all;
  const slugs = new Set();
  for (const c of supporting) {
    slugs.add(c.entry.slug);
    for (const slug of LOOK_ALIKES_EITHER_WAY.get(c.entry.slug) || []) slugs.add(slug);
  }
  return [...slugs].map((slug) => catalog.getEntry(slug)).filter(Boolean);
}

// An unknown answer (no node) could be anything, so it is triaged for the
// whole catalog.
function unnamedSafetyLineFor(nodeId, supporting = []) {
  const members = nodeId ? safetyMembersFor(nodeId, supporting) : catalog.listEntries({ section: 'pest' });
  const extra = new Set(members.flatMap(clausesFor));
  if (nodeId && !extra.size && !members.some(keepsDistance)) return null;
  return [
    UNNAMED_SAFETY_CLAUSES.base,
    members.some(isVenomousBiter) ? UNNAMED_SAFETY_CLAUSES.venomousBite : UNNAMED_SAFETY_CLAUSES.general,
    ...HAZARD_CLAUSES.filter(([key]) => extra.has(key)).map(([key]) => UNNAMED_SAFETY_CLAUSES[key]),
  ].join(' ');
}

const URGENCY_ORDER = ['low', 'moderate', 'high'];

/** The v1 columns for an unnamed answer, derived from every entry under the
 * answered node: any hazard one of them carries, the most urgent urgency,
 * and a service line/key/label only when they all share it. Inspection stays
 * v1's own unmatched default (confirm in person first). No node (unknown) is
 * that default throughout. */
function derivedNodeCompatibility(nodeId) {
  const members = nodeId ? (NODE_MEMBERS.get(nodeId) || []) : [];
  if (!members.length) return { ...DEFAULT_GENERIC_COMPATIBILITY, safety: { ...DEFAULT_GENERIC_COMPATIBILITY.safety } };
  const shared = (pick, fallback) => {
    const values = new Set(members.map(pick));
    return values.size === 1 ? [...values][0] : fallback;
  };
  const safety = {};
  for (const key of Object.keys(DEFAULT_GENERIC_COMPATIBILITY.safety)) {
    safety[key] = members.some((entry) => v1SafetyFallback(entry)[key]);
  }
  return {
    ...DEFAULT_GENERIC_COMPATIBILITY,
    safety,
    serviceLine: shared((e) => e.service?.line || null, null) || DEFAULT_GENERIC_COMPATIBILITY.serviceLine,
    serviceKey: shared((e) => e.service?.key || null, null),
    serviceLabel: shared((e) => e.service?.label || null, null) || DEFAULT_GENERIC_COMPATIBILITY.serviceLabel,
    urgency: URGENCY_ORDER[Math.max(...members.map((e) => URGENCY_ORDER.indexOf(e.urgency)), 0)],
  };
}

// Owner 2026-10-01 ("lets just use Gemini for this"): Photo ID answers from
// Gemini's one read. No verify leg, no OpenAI second opinion; OpenAI stands
// in only when Gemini returns nothing usable (outage, cut-off reply), so a
// customer never gets an error for a Gemini miss. Without a trait check the
// answer tops out at "Likely". PHOTO_ID_V2_LADDER=full restores the
// 2026-09-26 Gemini → verify → OpenAI ladder without a deploy.
// A Gemini-only read uses the app engine's own policy (photoIdPestV2, else
// photoIdVision when it is not registered); the full ladder keeps
// photoIdVision, so visit-prep reads are unchanged (Codex #5560 r3 P1).
function photoIdPolicy(singleRead) {
  return (singleRead && MODELS.TEXT_POLICIES?.photoIdPestV2) || MODELS.TEXT_POLICIES?.photoIdVision;
}

// Only a caller that asks for it (the customer app route) gets the
// Gemini-only read; PHOTO_ID_V2_LADDER=full puts that caller back on the
// full ladder too. Every other caller keeps the full ladder.
function geminiOnly(ladder) {
  return ladder === 'gemini_only' && process.env.PHOTO_ID_V2_LADDER !== 'full';
}

function escalateBelow() {
  const raw = Number(process.env.PHOTO_ID_ESCALATE_BELOW);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.80;
}

// Codex round-0 P1 (round 4): `dispatch()`'s `ok:true` only means the
// provider answered with SOME parseable JSON — it is not validated against
// the request's `jsonSchema` locally. Every call site that reads a
// `candidates` array must check this first, or a shape like
// `{candidates: {}}` throws on `.map`/`.filter` instead of degrading like
// any other provider miss.
function hasCandidatesArray(json) {
  return !!json && Array.isArray(json.candidates);
}

// Codex #4916 r1 P1: a leg counts as answered only when its whole envelope
// matches the contract — `quality`, `shows` and a `candidates` array. A
// response like `{ candidates: [{ slug, confidence }] }` never classified
// the photos, so it must not reach a named result through combineQuality's
// "no quality read" default. Candidates are then checked one at a time
// against the item schema and malformed ones dropped (the round-5 rule:
// one bad element does not sink the leg's valid candidates).
const ajv = new Ajv({ strict: false, allErrors: false });
const envelopeOf = (schema) => ({
  type: 'object',
  required: ['quality', 'shows', 'candidates'],
  properties: { quality: schema.properties.quality, shows: schema.properties.shows, candidates: { type: 'array' } },
});
// Items: the fields the engine reads must be present and typed (slug,
// confidence in 0..1); the rest are type-checked when present. Escalation
// trait arrays are enforced by isValidEscalationCandidate.
const itemOf = (schema) => {
  const props = schema.properties.candidates.items.properties;
  return { type: 'object', required: ['slug', 'confidence'], properties: props };
};
const LEG_CONTRACT = {
  candidates: { envelope: ajv.compile(envelopeOf(CANDIDATES_SCHEMA)), item: ajv.compile(itemOf(CANDIDATES_SCHEMA)) },
  escalation: { envelope: ajv.compile(envelopeOf(ESCALATION_SCHEMA)), item: ajv.compile(itemOf(ESCALATION_SCHEMA)) },
};

/** A candidate names something only with a slug, or — off-catalog — with
 * both its own name and a group. `{ slug: '', confidence: 0.95 }` names
 * nothing, and its confidence must never suppress escalation (Codex #4916
 * r2 P1). */
function namesAnIdentity(c) {
  const filled = (v) => typeof v === 'string' && v.trim().length > 0;
  return filled(c?.slug) || (filled(c?.off_catalog_name) && filled(c?.group_id));
}

/** The leg's JSON when its envelope matches `kind`'s contract, else null;
 * the returned object's `candidates` holds only schema-valid items that
 * name an identity. */
function validLegJson(result, kind) {
  if (!result?.ok || !result.json || !LEG_CONTRACT[kind].envelope(result.json)) return null;
  return { ...result.json, candidates: result.json.candidates.filter((c) => LEG_CONTRACT[kind].item(c) && namesAnIdentity(c)) };
}

/** The `candidates` array, with any non-object element (a raw provider
 * array can legally contain `[null, {...}]` and still pass
 * `hasCandidatesArray`) dropped before anything reads a field off it. */
function sanitizedCandidatesOf(json) {
  return hasCandidatesArray(json) ? json.candidates.filter((v) => v && typeof v === 'object') : [];
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// ── image payload ─────────────────────────────────────────────────────────

function toImages(photos) {
  return (photos || []).filter((p) => p && p.data).map((p, i) => ({
    data: p.data,
    mimeType: String(p.mimeType || 'image/jpeg').toLowerCase(),
    label: p.label || `Photo ${i + 1}`,
  }));
}

// ── candidate normalization ──────────────────────────────────────────────

/**
 * Resolve a model's raw candidate against the catalog by SLUG ONLY — the
 * model was handed exact slugs in the prompt, so this is a citation check,
 * never the fuzzy free-text matching `species-catalog.resolveName` does for
 * a human's typed text. An unresolvable/hallucinated slug degrades to an
 * off-catalog candidate rather than being dropped, so it still contributes
 * its confidence/group signal to the lineage climb.
 *
 * Codex #5143 r1 P2: the candidates/escalation prompts only LIST pest-section
 * entries, but nothing stopped a resolved slug from a DIFFERENT section
 * (once plant/condition content lands) from being treated as a real pest
 * identity — the prompt filter alone doesn't bound what the model can
 * return. A slug that resolves to a non-pest node is rejected here, at the
 * one place every model-returned identifier becomes a catalog node
 * (candidates, verify's merge-by-slug, and escalation all route through
 * this function) — treated exactly like an off-catalog/unresolved slug,
 * never a v2 entry answer.
 */
function resolveCandidate(raw) {
  const rawSlug = String(raw?.slug || '').trim();
  const rawEntry = rawSlug ? catalog.getEntry(rawSlug) : null;
  const entry = rawEntry && catalog.sectionOf(rawEntry) === 'pest' ? rawEntry : null;
  const confidence = clamp01(raw?.confidence);
  const traitsVisible = Array.isArray(raw?.traits_visible) ? raw.traits_visible.filter(Number.isFinite) : [];
  const traitsNotVisible = Array.isArray(raw?.traits_not_visible) ? raw.traits_not_visible.filter(Number.isFinite) : [];
  // Two orchestration flags, both false until a trait check runs:
  // `checked` — a real trait check produced this confidence (its score
  // replaces an unchecked guess, even when it found nothing supporting);
  // `verified` — that check also cited at least one visible trait, which
  // is what "pretty sure" requires (Codex round-0 P1, rounds 12–18).
  if (entry) {
    const cleaned = cleanTraitCitations(entry, traitsVisible, traitsNotVisible);
    return {
      slug: entry.slug, offCatalogName: null, groupId: entry.group, confidence, entry, ...cleaned, checked: false, verified: false,
    };
  }
  return {
    slug: null,
    offCatalogName: String(raw?.off_catalog_name || rawSlug || '').trim() || null,
    groupId: String(raw?.group_id || '').trim() || null,
    confidence,
    entry: null,
    traitsVisible,
    traitsNotVisible,
    checked: false,
    verified: false,
  };
}

/** Dedupe by slug (catalog) or name+group (off-catalog), keep the higher
 * confidence instance, then rank by confidence and cap at 3 — "up to 3
 * candidates" everywhere the contract specifies it. */
function dedupeCandidates(list) {
  const seen = new Map();
  for (const c of list) {
    const key = c.slug ? `slug:${c.slug}` : `off:${c.offCatalogName || ''}:${c.groupId || ''}`;
    const existing = seen.get(key);
    // A completed check's score beats an unchecked guess for the same
    // candidate, whatever the numbers — even a check that found nothing
    // supporting it (Codex round-0 P1, rounds 15 and 18); between two of
    // the same kind, the higher wins.
    if (!existing || (!!c.checked === !!existing.checked ? c.confidence > existing.confidence : !!c.checked)) {
      seen.set(key, c);
    }
  }
  // Ranking stays by confidence: `verified` gates wording and evidence, never
  // which identity a provider put first (Codex round-0 P1, round 16).
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

function sameCandidateKey(a, b) {
  if (!a || !b) return false;
  if (a.slug || b.slug) return a.slug === b.slug;
  return !!a.groupId && a.groupId === b.groupId;
}

function candidateNodeId(candidate) {
  if (!candidate) return null;
  if (candidate.slug) return candidate.slug;
  // Codex #5143 r1 P2: `group_id` is free-form model output — the same
  // section guard `resolveCandidate` applies to a resolved slug applies
  // here too, or an off-catalog answer naming e.g. `group_id: "turfgrasses"`
  // (or, before this PR, the assay-only "nematodes") would still climb to a
  // named group-level pest answer.
  if (candidate.groupId) {
    const group = catalog.getGroup(candidate.groupId);
    if (group && catalog.sectionOf(group) === 'pest') return candidate.groupId;
  }
  return null;
}

// Contract delta 2026-09-26 #5: risk dimensions for escalation are sting,
// venom, structural, disease, inspection-first, toxic_to_pets, allergen,
// irritant, protected status, and an explicit medical risk — any of these,
// or a "call" verdict,
// makes a candidate
// consequential for the look-alike-close escalation trigger and decision
// #2's harmless-plainly guard.
function isConsequential(entry) {
  if (!entry) return false;
  const s = entry.safety || {};
  return entry.verdict === 'call'
    || entry.risk === 'medical'
    || !!s.stings || !!s.venomous || !!s.structural || !!s.toxic_to_pets || !!s.allergen || !!s.irritant || !!s.disease_vector || !!s.protected
    || !!entry.service?.inspection_first;
}

// Contract delta 2026-09-26 #1: the engine names an entry only when its
// catalog review is owner-approved, fact-check-clean, AND its stored approval
// hash still matches every authored field. Unreviewed, changed-after-approval,
// or fact-check-pending entries can never be shown by name, whatever the
// models say. Confidence math and escalation triggers are unaffected; only
// naming (the `entry` level/block) is gated.
function candidateContextFor(candidates) {
  return candidates.filter((c) => c.entry).map((c) => ({
    slug: c.slug,
    common_name: c.entry.common_name,
    traits: c.entry.traits || [],
    lookAlikeDifferences: (c.entry.look_alikes || []).map((la) => la.difference).filter(Boolean),
  }));
}

// ── model calls (sequential, no Claude leg) ────────────────────────────────

// thinkingLevel is a Gemini 3.x setting; any other route (an override to
// another provider or an older Gemini) never receives it (Codex #5560 r1).
function supportsThinkingLevel(route) {
  return route.provider === 'gemini' && /^gemini-3/.test(String(route.model));
}

async function callWithProvider(route, payload) {
  if (!route || !route.provider || !route.model) return { ok: false, reason: 'no_route', provider: route?.provider || null, model: route?.model || null };
  const { thinkingLevel, ...rest } = payload;
  const sent = thinkingLevel && supportsThinkingLevel(route) ? { ...rest, thinkingLevel } : rest;
  const result = await dispatch(route, sent);
  return { ...result, provider: route.provider, model: result.model || route.model };
}

// Codex round-0 P1 (round 4): a plain `dispatch()` call (unlike
// `dispatchWithFallback`) installs no abort/timeout on its own — three
// SEQUENTIAL vision calls with no `timeoutMs` could each ride the
// adapter's own 10-minute default, so one stalled leg could block
// escalation indefinitely on a customer-facing request. `identifyPestV2`
// passes each leg a bounded share of one overall wall-clock budget.
const DEFAULT_TOTAL_BUDGET_MS = 4 * 60 * 1000;
function totalBudgetMs() {
  const raw = Number(process.env.PHOTO_ID_V2_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOTAL_BUDGET_MS;
}
// A floor so a nearly-exhausted budget still gets a short bounded attempt
// rather than 0 (which `callGemini`/`callOpenAI` treat as "no timeout at
// all" — the opposite of what an exhausted budget should mean).
const MIN_LEG_TIMEOUT_MS = 1000;

async function callCandidatesModel(images, catalogEntries, timeoutMs, singleRead = false) {
  const route = photoIdPolicy(singleRead)?.primary;
  return callWithProvider(route, {
    system: buildCandidatesSystemPrompt(buildCatalogIndexText(catalogEntries)),
    text: `These ${images.length} photo(s) show the same subject from different angles. Identify it.`,
    images,
    jsonMode: true,
    jsonSchema: CANDIDATES_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    thinkingLevel: GEMINI_THINKING_LEVEL,
    laneId: 'photo_id_v2_candidates',
    promptVersion: PROMPT_VERSION,
  });
}

async function callVerifyModel(images, candidateContext, timeoutMs) {
  const route = photoIdPolicy(false)?.primary;
  return callWithProvider(route, {
    system: buildVerifySystemPrompt(candidateContext),
    text: 'Check each candidate above against these same photos.',
    images,
    jsonMode: true,
    jsonSchema: VERIFY_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    thinkingLevel: GEMINI_THINKING_LEVEL,
    laneId: 'photo_id_v2_verify',
    promptVersion: PROMPT_VERSION,
  });
}

async function callEscalationModel(images, catalogEntries, candidateContext, timeoutMs, singleRead = false) {
  const route = photoIdPolicy(singleRead)?.fallback;
  return callWithProvider(route, {
    system: buildEscalationSystemPrompt(buildCatalogIndexText(catalogEntries), candidateContext),
    text: `These ${images.length} photo(s) show the same subject from different angles. Identify it and check any candidates already raised.`,
    images,
    jsonMode: true,
    jsonSchema: ESCALATION_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    laneId: 'photo_id_v2_escalation',
    promptVersion: PROMPT_VERSION,
  });
}

// ── escalation triggers (V2-CONTRACT.md engine step 3) ────────────────────

/** Codex round-0 P1: a verify call that came back `ok: true` but omitted one
 * of the candidates it was asked to check (empty `candidates: []`, or just
 * missing that slug) must NOT leave that candidate's original candidates-
 * call confidence standing unverified — that is exactly the "empty or
 * invalid JSON" miss the contract already treats as `gemini_missed`. */
// Codex round-0 P1 (round 8): a verify record naming the right slug but
// missing its required fields (no numeric confidence, or no trait arrays
// at all) is not a real verification — accepting it let a candidate reach
// `pretty_sure` having cited zero evidence. Both `mergeVerify` and
// `verifyCoversAllCandidates` require this shape before trusting a record.
function isValidVerifyRecord(v) {
  return !!v && typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1
    && Array.isArray(v.traits_visible) && Array.isArray(v.traits_not_visible);
}

function verifyCoversAllCandidates(verifyResult, catalogCandidates) {
  if (!verifyResult?.ok || !Array.isArray(verifyResult.json?.candidates)) return false;
  const bySlug = new Map();
  for (const v of verifyResult.json.candidates) {
    if (v?.slug) bySlug.set(String(v.slug), v);
  }
  return catalogCandidates.every((c) => isValidVerifyRecord(bySlug.get(c.slug)));
}

/** A trait check only counts as one when it cites at least one of the
 * entry's real numbered traits as visible — a score with nothing seen
 * behind it (empty or out-of-range citations) is still a guess (Codex
 * round-0 P1, round 15). */
function citesARealTrait(entry, traitsVisible) {
  const count = entry?.traits?.length || 0;
  return (traitsVisible || []).some((n) => Number.isInteger(n) && n >= 1 && n <= count);
}

/** A provider's trait citations, cleaned against the entry's real traits:
 * whole numbers in range, each once, and none cited as BOTH seen and not
 * seen — a self-contradicting citation supports neither side (Codex #4916
 * r4). Everything downstream (verified, evidence, contradiction) reads the
 * cleaned lists. */
function cleanTraitCitations(entry, visible, notVisible) {
  const count = entry?.traits?.length || 0;
  const valid = (list) => [...new Set((list || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= count))];
  const seen = valid(visible);
  const unseen = valid(notVisible);
  const both = new Set(seen.filter((n) => unseen.includes(n)));
  return { traitsVisible: seen.filter((n) => !both.has(n)), traitsNotVisible: unseen.filter((n) => !both.has(n)) };
}

function mergeVerify(candidates, verifyResult) {
  const bySlug = new Map();
  if (verifyResult?.ok && Array.isArray(verifyResult.json?.candidates)) {
    for (const v of verifyResult.json.candidates) {
      if (v?.slug && isValidVerifyRecord(v)) bySlug.set(String(v.slug), v);
    }
  }
  return candidates.map((c) => {
    if (!c.entry) return c;
    const v = bySlug.get(c.slug);
    // No VALID verify record — the candidate's original candidates-call
    // confidence stands unverified, and `verifyCoversAllCandidates`
    // already flags this as `gemini_missed` so escalation runs and
    // `unansweredTrigger` caps it below pretty_sure if OpenAI doesn't
    // answer either.
    if (!v) return c;
    const { traitsVisible, traitsNotVisible } = cleanTraitCitations(c.entry, v.traits_visible, v.traits_not_visible);
    return {
      ...c,
      confidence: clamp01(v.confidence),
      traitsVisible,
      traitsNotVisible,
      checked: true,
      verified: citesARealTrait(c.entry, traitsVisible),
    };
  });
}

/** Candidates-call top entry vs. verify-call top entry rank a different top
 * entry, OR the verify call marks most of the top entry's traits not
 * visible. */
function detectSelfContradiction(candidatesJson, verifiedCandidates) {
  // Codex round-0 P1 (round 5): `hasCandidatesArray` only proves the field
  // IS an array, not that every element is an object — a raw provider array
  // like `[null, {slug:'fire-ant', confidence:0.9}]` still throws on
  // `b.confidence` in the sort below unless non-object elements are
  // dropped first (`sanitizedCandidatesOf`).
  const rawList = sanitizedCandidatesOf(candidatesJson);
  if (!rawList.length) return false;
  const rawTop = [...rawList].sort((a, b) => clamp01(b.confidence) - clamp01(a.confidence))[0];
  const rawTopSlug = rawTop && rawTop.slug ? String(rawTop.slug) : null;
  const verifiedTop = verifiedCandidates.filter((c) => c.entry).sort((a, b) => b.confidence - a.confidence)[0] || null;
  if (rawTopSlug && verifiedTop && verifiedTop.slug !== rawTopSlug) return true;
  if (verifiedTop) {
    const visible = verifiedTop.traitsVisible.length;
    const notVisible = verifiedTop.traitsNotVisible.length;
    if (notVisible > 0 && notVisible > visible) return true;
  }
  return false;
}

/** Top two catalog candidates within 0.25 of each other, and exactly one of
 * them is "consequential" (verdict call, or stings/venomous/structural/
 * toxic_to_pets). */
function consequentialLookAlikeClose(candidates) {
  const catalogOnly = candidates.filter((c) => c.entry).sort((a, b) => b.confidence - a.confidence);
  if (catalogOnly.length < 2) return false;
  const [top, second] = catalogOnly;
  if (Math.abs(top.confidence - second.confidence) > LOOK_ALIKE_CLOSE_SPREAD) return false;
  return isConsequential(top.entry) !== isConsequential(second.entry);
}

// ── lineage climb ──────────────────────────────────────────────────────────

function sumConfidenceAtNode(candidates, level, id) {
  return candidates.reduce((sum, c) => {
    const nodeId = candidateNodeId(c);
    if (!nodeId) return sum;
    const hit = catalog.lineage(nodeId).find((r) => r.level === level && r.id === id);
    return hit ? sum + c.confidence : sum;
  }, 0);
}

// Every distinct (level, id) rung reachable from ANY candidate's own
// lineage — not just the top candidate's. Codex round-0 P1 (round 3): a
// tortoise@0.40 (its own group alone under 0.60) plus two ants@0.35+0.30
// (group sum 0.65) must climb to "an ant", not "unknown" — the top
// candidate by confidence is not necessarily the candidate whose lineage
// carries the group with the most support.
function allLineageRungs(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const nodeId = candidateNodeId(c);
    if (!nodeId) continue;
    for (const [depth, rung] of catalog.lineage(nodeId).entries()) {
      if (rung.level === 'entry') continue;
      const key = `${rung.level}:${rung.id}`;
      if (!byKey.has(key)) byKey.set(key, { ...rung, depth });
    }
  }
  return [...byKey.values()];
}

/** The best-supported rung at one level (highest summed confidence among
 * those clearing 0.60), or null if none clears it at that level. */
function bestRungAtLevel(candidates, rungs, level) {
  let best = null;
  let bestSum = 0;
  for (const rung of rungs) {
    if (rung.level !== level) continue;
    const sum = sumConfidenceAtNode(candidates, level, rung.id);
    if (sum >= LINEAGE_CLIMB_MIN
      && (sum > bestSum || (sum === bestSum && (rung.depth || 0) > (best?.depth || 0)))) {
      best = rung;
      bestSum = sum;
    }
  }
  return best;
}

/** Deepest subgroup/group whose summed candidate confidence >= 0.60, across
 * ALL candidates' lineages (ties broken by higher sum); else the
 * best-supported category >= 0.60; else null (unknown). */
function climbLineage(candidates) {
  const rungs = allLineageRungs(candidates);
  return bestRungAtLevel(candidates, rungs, 'subgroup')
    || bestRungAtLevel(candidates, rungs, 'group')
    || bestRungAtLevel(candidates, rungs, 'category')
    || null;
}

function deepestSharedNode(idA, idB) {
  if (!idA || !idB) return null;
  const lineageA = catalog.lineage(idA);
  const lineageB = catalog.lineage(idB);
  let shared = null;
  const len = Math.min(lineageA.length, lineageB.length);
  for (let i = 0; i < len; i += 1) {
    if (lineageA[i].level === lineageB[i].level && lineageA[i].id === lineageB[i].id) shared = lineageA[i];
    else break;
  }
  return shared;
}

// ── deterministic answer builder (V2-CONTRACT.md engine step 4) ───────────

function isHarmlessOrAlly(entry) {
  return !!entry && (entry.verdict === 'ally' || entry.verdict === 'harmless');
}

/** Any OTHER catalog candidate at >= 0.20 confidence that IS consequential —
 * decision #2: name a harmless/ally species plainly only when no
 * consequential look-alike is close. */
function consequentialAltClose(candidates, top) {
  return candidates.some((c) => c !== top && c.entry && c.confidence >= CONSEQUENTIAL_ALT_MIN && isConsequential(c.entry));
}

function buildEntryBlock(entry) {
  return {
    slug: entry.slug,
    common_name: entry.common_name,
    scientific_name: entry.scientific_name || null,
    kind: entry.kind,
    verdict: entry.verdict,
    verdict_label: VERDICT_LABELS[entry.verdict] || null,
    role: entry.role || null,
    role_label: ROLE_LABELS[entry.role] || null,
    risk: entry.risk || null,
    risk_label: RISK_LABELS[entry.risk] || null,
    action: entry.action || null,
    action_label: ACTION_LABELS[entry.action] || null,
    safety_line: entry.safety_line || null,
    what_it_means: entry.copy?.what_it_means || null,
    fact: entry.copy?.fact || null,
    site_url: entry.links?.site_page ? `${SITE_BASE_URL}${entry.slug}/` : null,
    // Codex round-0 P1 (round 2): a look-alike's own catalog identity is
    // gated by ITS OWN review approval, same as any other candidate — an
    // approved entry's page must not out an unapproved look-alike by
    // name/slug, OR indirectly through the comparison PROSE (`difference`
    // routinely names both species by common name), just because it
    // happens to be listed here.
    look_alikes: catalog.lookAlikes(entry.slug)
      .filter((la) => la.node && isApproved(la.node))
      .map((la) => ({ slug: la.slug, common_name: la.node.common_name, difference: la.difference || null })),
  };
}

// Codex round-0 P1 (round 8): traits are catalog-authored strings, same
// naming-risk class as look-alike `difference` prose — an unapproved
// entry's traits must not be cited as evidence just because it happens to
// be the top candidate. No fallback to an unapproved entry: if nothing
// approved is on the list, there is no entry being named, so there is
// nothing to cite evidence FOR either.
/** The candidates that actually sit under the chosen answer node — the
 * named entry itself, or every candidate whose own lineage passes through
 * the climbed/disagreed group, subgroup or category. Everything the card
 * cites as support must come from this list: the lineage climb can pick a
 * group other than the top candidate's (a tortoise@0.40 over two ants
 * summing to "an ant"), and the tortoise's "domed shell" is not evidence
 * for an ant (Codex round-0 P1, round 14). An unknown answer has none. */
function candidatesSupporting(candidates, level, nodeId) {
  if (!nodeId) return [];
  if (level === 'entry') return candidates.filter((c) => c.slug === nodeId);
  return candidates.filter((c) => {
    const id = candidateNodeId(c);
    return !!id && catalog.lineage(id).some((r) => r.level === level && r.id === nodeId);
  });
}

function evidenceFor(candidates) {
  const top = candidates.find((c) => c.entry && isApproved(c.entry)) || null;
  if (!top) return { matches: [], still_need: [] };
  const traits = top.entry.traits || [];
  const pick = (nums) => [...new Set(nums)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= traits.length)
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map((n) => traits[n - 1]);
  return { matches: pick(top.traitsVisible), still_need: pick(top.traitsNotVisible) };
}

function differenceFromTop(candidate, top) {
  if (!top || candidate === top || !candidate.entry || !top.entry) return null;
  const forward = catalog.lookAlikes(top.entry.slug).find((l) => l.slug === candidate.entry.slug);
  if (forward) return forward.difference || null;
  const backward = catalog.lookAlikes(candidate.entry.slug).find((l) => l.slug === top.entry.slug);
  return backward ? (backward.difference || null) : null;
}

function localLabel(entry, currentMonth) {
  if (entry.range === 'common' && Array.isArray(entry.active_months) && entry.active_months.includes(currentMonth)) return 'common_here_now';
  if (entry.range === 'rare') return 'uncommon_here';
  return null;
}

// Contract delta 2026-09-26 #1: an unapproved catalog candidate is listed
// only by its group generic — never its name — in the "other possibilities"
// block, even though it still occupies a ranked slot and still carries a
// `strength`/`local` read (neither reveals identity).
function candidatesBlockFor(candidates, currentMonth) {
  const catalogCandidates = candidates.filter((c) => c.entry).slice(0, 3);
  const top = catalogCandidates.find((c) => isApproved(c.entry)) || catalogCandidates[0] || null;
  const masked = catalogCandidates.map((c) => {
    const approved = isApproved(c.entry);
    const group = catalog.getGroup(c.entry.group);
    return {
      slug: approved ? c.entry.slug : null,
      common_name: approved ? c.entry.common_name : (group ? group.generic : null),
      scientific_name: approved ? (c.entry.scientific_name || null) : null,
      strength: c.confidence >= LINEAGE_CLIMB_MIN ? 'strong' : 'possible',
      // Codex round-0 P1 (round 2): the difference prose names BOTH sides
      // by common name — never computed unless the REFERENCE top is also
      // approved (an unapproved `top` fallback must not leak its identity
      // through an approved candidate's `difference_from_top` either).
      difference_from_top: approved && top?.entry && isApproved(top.entry) ? differenceFromTop(c, top) : null,
      local: localLabel(c.entry, currentMonth),
      // A named alternative carries its own catalog warning — "Other
      // possibilities" must not name brown recluse without its bite line
      // (the plant engine's #5250 r6 rule). A masked row names nothing.
      safety_line: approved ? (c.entry.safety_line || null) : null,
    };
  });
  const visible = new Map();
  for (const candidate of masked) {
    const key = candidate.slug || `masked:${candidate.common_name}`;
    const existing = visible.get(key);
    if (!existing) {
      visible.set(key, candidate);
      continue;
    }
    // Collapsing indistinguishable masks must not add their confidences or
    // imply that a hidden species' seasonal range applies to the whole group.
    if (candidate.strength === 'possible') existing.strength = 'possible';
    if (candidate.local !== existing.local) existing.local = null;
  }
  return [...visible.values()];
}

// Contract delta 2026-09-26 #3: a curated pair's OWN `photo_can_confirm`
// (false when no single photo separates the pair — the pair's `next_photo`
// text says what DOES confirm it instead) rides on the object; a node-level
// prompt (no specific pair) is always `photo_can_confirm: true`.
/** The curated pair between two entries, looked up in either direction —
 * catalog look-alikes are sometimes one-way (bigheaded ant lists fire ant,
 * not the reverse; Codex #4916 r3). A reverse pair is returned with `slug`
 * pointing at `other`, so callers can treat it like `entry`'s own. */
function vetoAppliesToPhoto(edge, shownKind) {
  if (edge?.photo_can_confirm !== false) return false;
  return !edge.photo_veto_applies_to || !shownKind || edge.photo_veto_applies_to === shownKind;
}

function edgeAppliesToPhoto(edge, shownKind) {
  return !!edge && (!edge.photo_veto_applies_to || !shownKind || edge.photo_veto_applies_to === shownKind);
}

function pairBetween(entry, other, shownKind = null) {
  if (!entry || !other) return null;
  const own = (entry.look_alikes || []).find((l) => l.slug === other.slug);
  const reverse = (other.look_alikes || []).find((l) => l.slug === entry.slug);
  if (!own && !reverse) return null;
  // If EITHER direction says no photo can settle the pair, it can't — from
  // whichever side is on top (southern house spider over brown recluse must
  // not read "pretty sure"; Codex #4974 r2).
  // The edge that supplies the veto also supplies the wording: its
  // next_photo/difference carry the "a photo can't settle this" guidance,
  // which the other side's tip (e.g. "a close-up of the violin marking")
  // would contradict (Codex #4974 r6).
  const vetoing = vetoAppliesToPhoto(own, shownKind) ? own : (vetoAppliesToPhoto(reverse, shownKind) ? reverse : null);
  if (vetoing) return { ...vetoing, slug: other.slug, photo_can_confirm: false };
  const selected = [own, reverse].find((edge) => edgeAppliesToPhoto(edge, shownKind));
  return selected ? { ...selected, slug: other.slug } : null;
}

function pairIfBothApproved(entry, other, shownKind = null) {
  const pair = pairBetween(entry, other, shownKind);
  return pair && isApproved(catalog.getEntry(pair.slug)) ? pair : null;
}

/** The entry's own first look-alike whose TARGET is also approved (the
 * same "no second candidate to pair against" fallback `nextPhotoFor` uses),
 * shared with `entryLevelAnswer`'s photo-confirmability guard so both apply
 * the SAME fallback pair consistently. */
// Shown when the governing look-alike pair can't be settled by any photo
// and its own (curated) wording can't be shown because it names an
// unapproved species (pre-push audit on Codex #4916 r2).
const NO_PHOTO_CONFIRMS = Object.freeze({
  ask: 'A technician can confirm this one on site or from a sample.',
  why: 'It has a close look-alike that a photo alone can\'t rule out.',
  photo_can_confirm: false,
});

/** The look-alike pair that governs whether a photo can confirm `top`:
 * its curated pair against the second candidate, else its own first
 * look-alike — read WITHOUT the approval filter. `photo_can_confirm: false`
 * is a fact about the pair, not about whether the other side's page is
 * published yet (Codex round-0 P1, round 19: bed bug vs a still-planned
 * bat bug). Callers must not surface an unapproved target's identity. */
/** Every look-alike relationship `entry` has, from EITHER side: its own
 * edges, plus edges other entries point at it with. Each is normalized by
 * `pairBetween`, so a "no photo can settle this" on either side wins.
 * Every single-entry fallback reads this one list, so a reverse-only veto
 * (brown recluse -> southern house spider) can't be missed on any path
 * (Codex #4974 r2-r4). Own edges come first, in authored order. */
function lookAlikeEdges(entry, shownKind = null) {
  if (!entry) return [];
  const others = [
    ...(entry.look_alikes || []).map((la) => la.slug),
    ...catalog.listEntries({ section: 'pest' }).filter((o) => (o.look_alikes || []).some((la) => la.slug === entry.slug)).map((o) => o.slug),
  ];
  const seen = new Set();
  const edges = [];
  for (const slug of others) {
    if (seen.has(slug) || slug === entry.slug) continue;
    seen.add(slug);
    const pair = pairBetween(entry, catalog.getEntry(slug) || { slug, look_alikes: [] }, shownKind);
    if (pair) edges.push(pair);
  }
  return edges;
}

function governingPair(top, second, shownKind = null) {
  // Any look-alike no photo can separate governs first, whoever the
  // runner-up is: a confirmable runner-up pair must not mask a different
  // unconfirmable one (Formosan vs. Asian subterranean termite behind a
  // Formosan/subterranean result; Codex #4974 r5). Prefer the runner-up's
  // own pair when it is the unconfirmable one.
  const edges = lookAlikeEdges(top?.entry, shownKind);
  const runnerUp = second?.entry ? pairBetween(top?.entry, second.entry, shownKind) : null;
  if (runnerUp?.photo_can_confirm === false) return runnerUp;
  const veto = edges.find((e) => e.photo_can_confirm === false);
  if (veto) return veto;
  return runnerUp || edges[0] || null;
}

function firstApprovedLookAlike(entry, shownKind = null) {
  const edges = lookAlikeEdges(entry, shownKind).filter((e) => isApproved(catalog.getEntry(e.slug)));
  return edges.find((e) => e.photo_can_confirm === false) || edges[0] || null;
}

/** A curated comparison's photo prompt. The pair names its look-alike, which
 * need not be among the shown candidates, so that entry's own warning rides
 * along (the plant engine's #5250 r7 rule). Callers pass only pairs whose
 * target is approved. */
function pairPrompt(pair, photoCanConfirm) {
  const safetyLine = catalog.getEntry(pair.slug)?.safety_line || null;
  return {
    ask: pair.next_photo || null, why: pair.difference || null, photo_can_confirm: photoCanConfirm, ...(safetyLine ? { safety_line: safetyLine } : {}),
  };
}

function nextPhotoFor(wording, candidates, level, nodeId, shownKind = null) {
  if (wording === 'pretty_sure') return null;
  const top = candidates[0] || null;
  const second = candidates[1] || null;
  // A curated pair between the top two candidates. Read the raw
  // `look_alikes` entry directly (not the `lookAlikes()` convenience
  // wrapper, which does not pass through `photo_can_confirm`) so a pair
  // explicitly marked unconfirmable-by-photo is honored. Codex round-0 P1
  // (round 2): the pair's `ask`/`why` prose routinely names BOTH species by
  // common name, so this is only used when both sides are approved — an
  // unapproved look-alike must not surface even indirectly through it.
  // A look-alike no photo can separate outranks the runner-up pair's photo
  // tip: say so instead (Codex #4974 r5).
  // Computed at every level: an unapproved top candidate climbs to a node,
  // but a pair no photo can separate still vetoes a retake prompt there
  // (only its prose is withheld). Codex #5106 r1.
  const governing = top?.entry ? governingPair(top, second, shownKind) : null;
  if (governing?.photo_can_confirm === false) {
    if (level !== 'entry' || !isApproved(catalog.getEntry(governing.slug))) return { ...NO_PHOTO_CONFIRMS };
    return pairPrompt(governing, false);
  }
  if (top?.entry && second?.entry && isApproved(top.entry) && isApproved(second.entry)) {
    const pair = pairIfBothApproved(top.entry, second.entry, shownKind);
    if (pair) return pairPrompt(pair, pair.photo_can_confirm !== false);
  }
  // Entry level with no usable second-candidate pair: the entry's own first
  // look-alike WHOSE OWN TARGET IS APPROVED, read directly so
  // `photo_can_confirm` survives.
  if (level === 'entry' && top?.entry) {
    if (governing && !isApproved(catalog.getEntry(governing.slug))) {
      // Its prose names the unapproved look-alike, so it can't be shown.
      // A pair no photo can settle gets fixed technician guidance (a retake
      // prompt would contradict it); otherwise the fixed safe retake does.
      if (governing.photo_can_confirm === false) return { ...NO_PHOTO_CONFIRMS };
      return { ...UNNAMED_NEXT_PHOTO };
    }
    const fallbackPair = firstApprovedLookAlike(top.entry, shownKind);
    if (fallbackPair) {
      return pairPrompt(fallbackPair, fallbackPair.photo_can_confirm !== false);
    }
    // No usable approved pair: the fixed safe retake prompt, so an
    // uncertain entry answer always carries guidance (pre-push audit on
    // Codex #4916 r5).
    return { ...UNNAMED_NEXT_PHOTO };
  }
  // Node level (group/subgroup/category) or unknown: the fixed safe retake
  // prompt, never a group's own prose (see UNNAMED_NEXT_PHOTO).
  return { ...UNNAMED_NEXT_PHOTO };
}

function referralFor(entry) {
  const kind = entry?.service?.referral;
  if (!kind || !REFERRAL_TEMPLATES[kind]) return null;
  return { kind, text: REFERRAL_TEMPLATES[kind] };
}

// One of the three entry-level naming rules (pretty_sure/pretty_sure via the
// harmless bar/likely), or null when none clears its bar — in which case
// `buildAnswer` climbs the lineage instead. Split out of `buildAnswer` to
// keep each rule's condition readable on its own line (lint: complexity).
function entryLevelAnswer(candidates, top, blockPrettySure, shownKind = null) {
  if (!top?.entry || !isApproved(top.entry)) return null;
  const second = candidates[1] || null;
  // Codex round-0 P1 (rounds 5–6): a curated pair the catalog marks
  // `photo_can_confirm: false` must never resolve as pretty_sure, however
  // high the model's own confidence — that flag exists precisely because
  // NO photo can settle it. Applies whether the model itself returned a
  // second candidate to pair against, or (a SINGLE confident candidate)
  // the entry's own first-approved look-alike is the applicable pair —
  // same fallback `nextPhotoFor` uses. Falling through to the `likely` bar
  // instead (still allowed) leaves `nextPhotoFor` + the tier check to
  // surface the pair's own confirmation instructions and force
  // needs_more_evidence, rather than a confident answer with
  // `next_photo: null`.
  // Codex round-0 P1 (round 7): mirrors `nextPhotoFor`'s OWN fallthrough
  // exactly — a second candidate with no curated pair against the top
  // (unapproved, or simply not each other's look-alike) still falls back
  // to the top entry's own first-approved look-alike, the same as having
  // no second candidate at all.
  const applicablePair = (second?.entry && pairIfBothApproved(top.entry, second.entry, shownKind)) || firstApprovedLookAlike(top.entry, shownKind);
  const unconfirmablePair = applicablePair?.photo_can_confirm === false
    || governingPair(top, second, shownKind)?.photo_can_confirm === false;
  // Codex round-0 P1 (rounds 10–15): "pretty sure" is only ever earned by a
  // confidence a real trait check produced. One gate here, instead of each
  // merge path proving it never lets an unchecked number through.
  const blocked = blockPrettySure || !top.verified;
  const named = (wording) => ({
    // A sign has no species of its own to name in the subhead (Codex #4974 r8).
    level: 'entry', wording, nodeId: top.slug, subhead: top.entry.kind === 'sign' ? null : (top.entry.scientific_name || null),
    headline: `${wording === 'pretty_sure' ? "We're pretty sure" : 'Likely'}: ${top.entry.common_name}`,
    entry: top.entry,
  });
  if (top.confidence >= PRETTY_SURE_MIN && !blocked && !unconfirmablePair) return named('pretty_sure');
  if (isHarmlessOrAlly(top.entry) && top.confidence >= HARMLESS_PRETTY_SURE_MIN
    && !consequentialAltClose(candidates, top) && !blocked && !unconfirmablePair) return named('pretty_sure');
  if (top.confidence >= LIKELY_MIN) return named('likely');
  return null;
}

// The climbed (group_only/unknown) or disagreed (group_only-at-shared-node/
// unknown) answer — used whenever `entryLevelAnswer` returns null.
function climbedOrDisagreedAnswer(candidates, disagreed, disagreementNode) {
  const node = disagreed ? disagreementNode : climbLineage(candidates);
  return {
    level: node ? node.level : 'unknown',
    wording: node ? 'group_only' : 'unknown',
    nodeId: node ? node.id : null,
    subhead: node && node.level === 'subgroup' ? (catalog.getSubgroup(node.id)?.scientific || null) : null,
    headline: node ? `Looks like ${node.generic}` : "We couldn't tell from these photos",
    entry: null,
  };
}

function groupBlockFor(level, nodeId, entry) {
  if (level === 'entry' && entry) return groupBlockFor('group', entry.group, null) || null;
  if (level === 'subgroup' && nodeId) {
    const sg = catalog.getSubgroup(nodeId);
    return sg ? groupBlockFor('group', sg.group, null) : null;
  }
  if (level === 'group' && nodeId) {
    const g = catalog.getGroup(nodeId);
    return g ? { id: g.id, label: g.label, generic: g.generic } : null;
  }
  return null;
}

// One evidence-kind decision is shared by escalation gating, candidate
// combination, and the final customer answer. Mixed reads remain unfiltered;
// an explicit `both` still reaches pair-level photo-veto rules.
function normalizeEvidenceKind(...reads) {
  const present = reads.filter(Boolean);
  if (present.length && present.every((value) => value === 'sign')) {
    return { shownKind: 'sign', hiddenKind: 'organism' };
  }
  if (present.length && present.every((value) => value === 'organism')) {
    return { shownKind: 'organism', hiddenKind: 'sign' };
  }
  return { shownKind: present.includes('both') ? 'both' : null, hiddenKind: null };
}

/**
 * Pure deterministic answer builder. `ctx.candidates` is the FINAL,
 * already-combined (Gemini + OpenAI, when escalated) candidate list, ranked
 * by confidence, capped at 3. See V2-CONTRACT.md engine step 4.
 */
function buildAnswer(ctx) {
  const {
    candidates, disagreed, disagreementNode, escalationTriggered, openaiAnswered, openaiStoodInAlone,
    qualityUsable, qualityIssue, subjectConflict, evidenceKind = {}, currentMonth,
  } = ctx;
  const unansweredTrigger = Boolean(escalationTriggered) && !openaiAnswered;
  // Codex round-0 P1 (round 10): an OpenAI candidate that stood in ALONE
  // because Gemini gave us nothing was never checked against a single
  // numbered trait by either provider (its own escalation prompt tells it
  // to report empty trait arrays in that case) — same pretty_sure cap as
  // an unanswered trigger, for the same underlying reason: no real
  // verification happened.
  // Anything that forces needs_more_evidence also rules out "pretty sure":
  // an unusable or multi-subject photo, or legs that disagree on what the
  // photos show (Codex #4916 r4). Otherwise the answer read "pretty sure"
  // with a needs-more-evidence tier, no next photo, and high v1 confidence.
  const evidenceBlocked = [!qualityUsable, qualityIssue === 'multiple_subjects', Boolean(subjectConflict)].includes(true);
  const blockPrettySure = [unansweredTrigger, Boolean(openaiStoodInAlone), evidenceBlocked].includes(true);
  // A sign-only read never names or lists an organism (the photos show mud
  // tubes, not a termite, and several species make them), and an
  // organism-only read never names or lists a sign (Codex #4974 r7, r10).
  // The contradicted kind is filtered out FIRST, so the best remaining
  // candidate can still be the answer (r11). If nothing remains, the
  // answer climbs the full list's lineage but names nothing.
  const { hiddenKind = null, shownKind = null } = evidenceKind;
  const shownCandidates = candidates.filter((candidate) => candidate.entry?.kind !== hiddenKind);
  const answerCandidates = shownCandidates.length ? shownCandidates : candidates;
  const top = shownCandidates[0];
  let picked;
  if (disagreed) {
    picked = climbedOrDisagreedAnswer(candidates, true, disagreementNode);
  } else {
    picked = entryLevelAnswer(shownCandidates, top, blockPrettySure, shownKind)
      || climbedOrDisagreedAnswer(answerCandidates, false, null);
  }
  const { level, wording, nodeId, subhead, headline, entry } = picked;

  const group = groupBlockFor(level, nodeId, entry);
  // Evidence and other possibilities come from the same filtered list
  // (Codex #4974 r8-r9).
  const evidence = evidenceFor(candidatesSupporting(shownCandidates, level, nodeId));
  // On a sign-only read the photos show no animal, so no organism is listed
  // as another possibility either (Codex #4974 r8).
  const candidatesBlock = candidatesBlockFor(shownCandidates, currentMonth);
  const nextPhoto = nextPhotoFor(wording, answerCandidates, level, nodeId, shownKind);

  // Contract delta 2026-09-26 #3: a chosen pair no single photo can settle
  // keeps the tier at needs_more_evidence even at entry level (`likely`) —
  // added to the same-effect checks the original contract already listed
  // (quality, subject conflict, disagreement, above-entry-level).
  const needsMoreEvidence = [evidenceBlocked, disagreed, level !== 'entry', nextPhoto?.photo_can_confirm === false].includes(true);
  const tier = needsMoreEvidence ? 'needs_more_evidence' : 'ai_suggestion';

  return {
    answer: { level, node_id: nodeId, wording, headline, subhead },
    group,
    entry: entry ? buildEntryBlock(entry) : null,
    evidence,
    candidatesBlock,
    nextPhoto,
    // A referral is an approved entry's own routing; an unnamed answer goes
    // to the team (or an inspection) instead of borrowing a group's.
    referral: referralFor(entry),
    genericCompatibility: entry ? { safety: {} } : derivedNodeCompatibility(nodeId),
    genericSafetyLine: entry ? null : unnamedSafetyLineFor(nodeId, candidatesSupporting(candidates, level, nodeId)),
    tier,
    topEntrySlug: entry?.slug || null,
  };
}

// ── v1 column mapping (route still writes these — admin/history/issues) ───

const V1_BY_SLUG = new Map(PEST_LIBRARY.map((e) => [e.slug, e]));

function buildV2ToV1Map() {
  const index = catalog._index();
  const map = new Map();
  for (const [v1Slug, mapped] of Object.entries(index.legacy_slug_map || {})) {
    if (mapped && mapped.node && V1_BY_SLUG.has(v1Slug) && !map.has(mapped.node)) {
      map.set(mapped.node, v1Slug);
    }
  }
  return map;
}

const V2_TO_V1_SLUG = buildV2ToV1Map();

// v1 slugs whose (generic) label is true of EVERY species under the node
// they're mapped to, so a named descendant may inherit them: any mosquito
// is "Mosquitoes", any widow is "Widow Spiders". Not "honey-bee" (its
// node, bees, also holds carpenter and bumble bees) or "aphid-scale"
// (tiny plant pests also holds mites and thrips) — pre-push audit on
// Codex #4916 r3.
const V1_INHERITABLE = new Set(['mosquito', 'black-widow', 'flea', 'tick', 'rodent', 'whitefly', 'sod-webworm', 'millipede']);
// Named entries a non-inheritable v1 slug still describes exactly.
const V1_BY_ENTRY = new Map([['honey-bee-swarm', 'honey-bee'], ['honey-bee-wall-colony', 'honey-bee']]);

/** The v1 slug for a v2 node: its own legacy mapping, an explicit entry
 * mapping, else the nearest ancestor mapped to an inheritable v1 slug
 * (`aedes-mosquito` -> `mosquitoes` -> v1 "mosquito"). Anything else stays
 * unmatched rather than borrowing a v1 identity that isn't true of it. */
function v1IdentityFor(v2Slug, { inheritableDirectOnly = false } = {}) {
  if (!v2Slug) return null;
  const own = V2_TO_V1_SLUG.get(v2Slug) || V1_BY_ENTRY.get(v2Slug);
  if (own && V1_BY_SLUG.has(own) && (!inheritableDirectOnly || V1_INHERITABLE.has(own))) {
    return { slug: own, inherited: false };
  }
  const ancestors = catalog.lineage(v2Slug).slice().reverse().slice(1);
  for (const rung of ancestors) {
    const v1 = V2_TO_V1_SLUG.get(rung.id);
    if (v1 && V1_INHERITABLE.has(v1)) return { slug: v1, inherited: true };
  }
  return null;
}

function categoryForV2Slug(slug) {
  const category = catalog.lineage(slug).find((rung) => rung.level === 'category');
  return category?.id || 'other';
}

function v1SafetyFallback(entry) {
  const s = entry?.safety || {};
  return {
    stinging: !!s.stings, venomous: !!s.venomous, disease_vector: !!s.disease_vector, structural_threat: !!s.structural,
  };
}

/**
 * Map the built v2 answer to the v1 columns the route still writes
 * (`species_slug`, `category`, `service_line`, `urgency`, a v1-shaped
 * `report_contract`) so admin pages, the history list's `pestHeadline`, and
 * `pestNextStepKindFromRow`/`pestReserviceLane` — all of which read
 * `report_contract` through v1's OWN `PEST_LIBRARY`/`GROUP_GENERIC`
 * vocabulary — keep working unchanged. When the v2 entry has no v1 legacy
 * slug (a new catalog entry v1 never had), this keeps the selected catalog
 * node's category while otherwise degrading exactly the way v1's own
 * unmatched-identification path does: `identification.slug = null`, generic
 * service, `inspection_required: true` — never a fabricated v1 identity.
 */
function mapToV1(built) {
  // A climbed node may use a generic legacy identity only when that v1 label
  // is true of every descendant. Thus widow-spiders -> "Widow Spiders" and
  // aedes -> "Mosquitoes", while bees never becomes "Honey Bees" and the
  // whole tiny-plant-pests group never becomes "Aphids / Scale Insects".
  const topEntrySlug = built.topEntrySlug;
  const selectedNodeId = topEntrySlug || built.answer.node_id;
  const v1Identity = v1IdentityFor(selectedNodeId, { inheritableDirectOnly: !topEntrySlug }) || {};
  const v1Slug = v1Identity.slug || null;
  const v1Item = v1Slug ? V1_BY_SLUG.get(v1Slug) : null;
  const v2Entry = catalog.getEntry(topEntrySlug);
  const legacyItem = v1Item || {};
  const namedEntry = v2Entry || { service: {} };
  const namedService = namedEntry.service || {};
  const inheritIdentityOnly = Boolean(v1Identity.inherited && v2Entry);
  const namedServiceIdentity = inheritIdentityOnly
    ? { serviceKey: namedService.key, serviceLabel: namedService.label }
    : { serviceKey: null, serviceLabel: 'Pest Consultation' };
  const genericCompatibility = Object(built.genericCompatibility);

  const category = legacyItem.category || categoryForV2Slug(selectedNodeId);
  const wordingConfidence = { pretty_sure: 'high', likely: 'moderate' }[built.answer.wording] || 'low';
  let confidence = wordingConfidence;
  if (built.tier === 'needs_more_evidence' && confidence === 'high') confidence = 'moderate';
  // A tier that needs more evidence is never stored as settled in v1: the
  // v1 consumers (public label, history, next steps) read `contested` and
  // `confidence` to decide whether to hedge (Codex #4916 r4).
  const contested = built.tier === 'needs_more_evidence';

  const compatibilityKind = v1Item && !inheritIdentityOnly ? 'legacy' : (v2Entry ? 'named' : 'generic');
  const compatibility = {
    legacy: {
      serviceLine: legacyItem.service_line,
      serviceKey: legacyItem.service_key,
      serviceLabel: legacyItem.service_label,
      inspectionRequired: legacyItem.inspection_required,
      urgency: legacyItem.urgency,
      ...genericCompatibility,
      safety: { ...legacyItem.safety, ...genericCompatibility.safety },
    },
    named: {
      safety: v1SafetyFallback(namedEntry),
      serviceLine: namedService.line,
      ...namedServiceIdentity,
      inspectionRequired: inheritIdentityOnly ? !!namedService.inspection_first : true,
      urgency: namedEntry.urgency,
    },
    generic: {
      ...DEFAULT_GENERIC_COMPATIBILITY,
      ...genericCompatibility,
      safety: { ...DEFAULT_GENERIC_COMPATIBILITY.safety, ...genericCompatibility.safety },
    },
  }[compatibilityKind];
  const {
    safety, serviceLine, serviceKey, serviceLabel, inspectionRequired, urgency,
  } = compatibility;
  const group = legacyItem.group || null;
  const label = legacyItem.label || null;

  const reportContract = {
    contract_version: 'pest_id_v1',
    identification: { slug: v1Slug, label, group, category, confidence, contested },
    safety,
    urgency,
    service: { line: serviceLine, key: serviceKey, label: serviceLabel, inspection_required: inspectionRequired },
    observations: built.evidence.matches,
    distinguishing_features: built.evidence.still_need,
    // Codex #4916 r1 P2: the stored contract is pest_id_v1, and the admin
    // differential resolves each alternate through the v1 library — so
    // alternates are mapped like the primary; v2-only entries are dropped.
    // With no named primary (a climb or disagreement), the leading
    // candidate is a differential too — only the primary itself is
    // filtered out (Codex #4916 r2 P2).
    alternate_slugs: [...new Set(built.candidatesBlock
      .map((c) => v1IdentityFor(c.slug)?.slug)
      .filter((v) => v && v !== v1Slug))],
  };

  return { species_slug: v1Slug, category, service_line: serviceLine, urgency, report_contract: reportContract };
}

// ── orchestration ──────────────────────────────────────────────────────────

/**
 * Combine Gemini's (post-verify) candidates with an OpenAI escalation
 * result, per V2-CONTRACT.md engine step 3's "Combining" rule. Split out of
 * `identifyPestV2` to keep that function's own sequencing readable (lint:
 * complexity) — this piece is pure given its three inputs.
 */
// Codex round-0 P1 (round 9): an escalation (OpenAI) candidate item gets
// NO less scrutiny than a Gemini verify record before it's allowed to
// count as a real answer — a record naming only a slug (no confidence, or
// a catalog candidate with no trait arrays) must not lift the pretty_sure
// cap or "agree" its way into bumping Gemini's own unverified confidence.
function isValidEscalationCandidate(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) return false;
  if (!namesAnIdentity(raw)) return false;
  const hasSlug = typeof raw.slug === 'string' && raw.slug.trim().length > 0;
  if (hasSlug && (!Array.isArray(raw.traits_visible) || !Array.isArray(raw.traits_not_visible))) return false;
  return true;
}

/** Trait numbers OpenAI reports for a slug it was never GIVEN a numbered
 * list for (any catalog candidate outside `contextSlugs` — a candidate
 * Gemini never raised, or a brand-new one OpenAI names on its own) are not
 * a real check against anything; `evidenceFor` would otherwise cite the
 * catalog's real trait strings at those numbers as if they had been
 * observed. Codex round-0 P1 (round 11). */
function stripUncontextedTraits(candidate, contextSlugs) {
  if (!candidate.entry) return candidate;
  // In context: it had a real numbered-trait list to check its citations
  // against, and already passed `isValidEscalationCandidate`'s array-shape
  // requirement — a genuine check, `verified: true` (used by
  // combineEscalation's agreement branch, Codex round-0 P1).
  if (contextSlugs.has(candidate.slug)) {
    return { ...candidate, checked: true, verified: citesARealTrait(candidate.entry, candidate.traitsVisible) };
  }
  return { ...candidate, traitsVisible: [], traitsNotVisible: [], checked: false, verified: false };
}

/** Prefer whichever candidate's confidence was actually verified (a real
 * trait check applied); between two verified numbers, the higher one;
 * between two unverified guesses, `a` (the caller's default/fallback
 * side) — there is no real evidence either way to prefer `b` over it. */
function pickVerifiedWinner(a, b) {
  // `checked`, not `verified`: a completed check that found no supporting
  // trait still replaces an unchecked guess (Codex round-0 P1, round 18).
  const aVerified = !!a.checked;
  const bVerified = !!b.checked;
  if (aVerified && bVerified) return b.confidence > a.confidence ? b : a;
  if (bVerified) return b;
  return a;
}

function combineEscalation(geminiCandidates, escalationResult, contextSlugs, hiddenKind = null) {
  const visibleGeminiCandidates = hiddenKind
    ? geminiCandidates.filter((candidate) => candidate.entry?.kind !== hiddenKind)
    : geminiCandidates;
  // Codex round-0 P1 (round 4): `dispatch()` does not locally validate a
  // provider's JSON against the requested schema — an `ok:true` response
  // whose `candidates` field isn't an array (or is missing) must be
  // treated as a failed/unavailable leg, never consumed as-is (it would
  // throw on `.map` below, breaking the engine's never-throws contract).
  if (!validLegJson(escalationResult, 'escalation')) {
    // OpenAI unavailable (or answered something invalid) — Gemini's result
    // stands, capped from reading pretty_sure by `unansweredTrigger` inside
    // `buildAnswer`.
    return { finalCandidates: visibleGeminiCandidates, disagreed: false, disagreementNode: null, openaiAnswered: false, openaiStoodInAlone: false };
  }
  const openaiCandidates = dedupeCandidates(
    sanitizedCandidatesOf(validLegJson(escalationResult, 'escalation')).filter(isValidEscalationCandidate).map(resolveCandidate)
      .map((c) => stripUncontextedTraits(c, contextSlugs)),
  ).filter((c) => !hiddenKind || c.entry?.kind !== hiddenKind);
  const openaiTop = openaiCandidates[0] || null;
  const geminiTop = visibleGeminiCandidates[0] || null;
  // Codex round-0 P1 (round 2): the provider answered (HTTP ok, valid
  // JSON) but named NO candidate at all — that is not confirmation of
  // anything. Treat it the same as "unavailable" for the pretty_sure cap,
  // even though there is nothing to combine either way.
  const openaiAnswered = !!openaiTop;

  if (openaiTop && !geminiTop) {
    // Codex round-0 P1 (round 10): Gemini gave us NOTHING (no catalog
    // candidate at all), so `candidateContextFor` handed OpenAI no
    // numbered traits for anything — its own escalation prompt explicitly
    // tells it to report empty trait arrays in that case. OpenAI's answer
    // stands in as the ONLY candidate, but it was never actually verified
    // against a single numbered trait by either provider — `buildAnswer`
    // must not let this read pretty_sure however high its own confidence.
    return { finalCandidates: openaiCandidates, disagreed: false, disagreementNode: null, openaiAnswered, openaiStoodInAlone: true };
  }
  if (!openaiTop || !geminiTop) {
    // Neither side has a top candidate, or OpenAI found nothing new —
    // Gemini's (already below-threshold/contested) result stands.
    return { finalCandidates: visibleGeminiCandidates, disagreed: false, disagreementNode: null, openaiAnswered, openaiStoodInAlone: false };
  }
  if (sameCandidateKey(geminiTop, openaiTop)) {
    // Codex round-0 P1 (rounds 12–13): "the higher of the two" only makes
    // sense between two numbers that were both actually CHECKED — a raw,
    // never-verified candidates-call guess (Gemini's verify missed, which
    // is exactly why low_confidence/gemini_missed escalated in the first
    // place) is not a real confidence to compare via Math.max. Prefer
    // whichever side is `verified` (mergeVerify only sets it once a valid
    // trait check actually applied; stripUncontextedTraits sets it for an
    // escalation candidate only when it had real numbered-trait context);
    // when both are verified, THEN take the higher; when neither is,
    // there is nothing to bump to, so Gemini's (already-capped-elsewhere)
    // reading stands rather than inventing agreement out of two guesses.
    const winner = pickVerifiedWinner(geminiTop, openaiTop);
    const bumped = {
      ...geminiTop,
      confidence: winner.confidence,
      traitsVisible: winner.traitsVisible,
      traitsNotVisible: winner.traitsNotVisible,
      checked: !!(geminiTop.checked || openaiTop.checked),
      verified: !!winner.verified,
    };
    return {
      // Both providers' own top is the answer's top; a stale runner-up with
      // a higher raw number must not displace it (Codex round-0 P1, round 15).
      finalCandidates: [bumped, ...dedupeCandidates([...visibleGeminiCandidates.slice(1), ...openaiCandidates.slice(1)])
        .filter((c) => !sameCandidateKey(c, bumped))].slice(0, 3),
      disagreed: false,
      disagreementNode: null,
      openaiAnswered,
      openaiStoodInAlone: false,
    };
  }
  return {
    finalCandidates: dedupeCandidates([geminiTop, openaiTop, ...visibleGeminiCandidates.slice(1), ...openaiCandidates.slice(1)]),
    disagreed: true,
    disagreementNode: deepestSharedNode(candidateNodeId(geminiTop), candidateNodeId(openaiTop)),
    openaiAnswered,
    openaiStoodInAlone: false,
  };
}

// Codex round-0 P1 (round 3): Gemini's photo-quality read must not silently
// win over a real problem OpenAI reports on the SAME photos — an unusable/
// multiple_subjects finding from EITHER leg has to force needs_more_evidence
// (combineQuality is conservative: unusable/multiple_subjects wins).
function combineQuality(geminiQuality, openaiQuality) {
  if (!geminiQuality && !openaiQuality) return { usable: true, issue: 'none' };
  if (!geminiQuality) return openaiQuality;
  if (!openaiQuality) return geminiQuality;
  const usable = geminiQuality.usable !== false && openaiQuality.usable !== false;
  let issue = 'none';
  if (geminiQuality.issue === 'multiple_subjects' || openaiQuality.issue === 'multiple_subjects') issue = 'multiple_subjects';
  else if (geminiQuality.issue && geminiQuality.issue !== 'none') issue = geminiQuality.issue;
  else if (openaiQuality.issue && openaiQuality.issue !== 'none') issue = openaiQuality.issue;
  return { usable, issue };
}

// Codex #4916 r1 P1: two legs that agree on a name but not on what the
// photos contain (an organism vs only a sign, or nothing at all) have not
// agreed on the evidence. `both` overlaps either read; `nothing` overlaps
// only itself. A single read (no escalation) cannot conflict.
const SHOWS_READS = { organism: ['organism'], sign: ['sign'], both: ['organism', 'sign'], nothing: [] };
function showsConflict(a, b) {
  if (!a || !b || a === b) return false;
  const left = SHOWS_READS[a] || [];
  const right = SHOWS_READS[b] || [];
  return !left.some((v) => right.includes(v));
}

function legInfo(result) {
  if (!result) return null;
  return { ok: !!result.ok, provider: result.provider || null, model: result.model || null, reason: result.ok ? null : (result.reason || null) };
}

/**
 * Identify a pest/organism from a customer's photos. Never throws —
 * `{ ok: false, reason }` on no usable photos; otherwise
 * `{ ok: true, v2, v1, internal }`. `v2` is the customer-facing object
 * (V2-CONTRACT.md), `v1` is `{ species_slug, category, service_line,
 * urgency, report_contract }` for the columns the route still writes, and
 * `internal` (which models answered, escalation reasons) must never reach
 * the customer.
 */
async function identifyPestV2(photos = [], { ladder = 'full' } = {}) {
  const images = toImages(photos);
  if (!images.length) return { ok: false, reason: 'no_photos' };

  const catalogEntries = catalog.listEntries({ section: 'pest' });
  // One overall wall-clock budget across the (up to three) SEQUENTIAL
  // provider legs, so a stalled candidates or verify call can never starve
  // escalation of its share (Codex round-0 P1, round 4).
  const deadline = Date.now() + totalBudgetMs();
  const legTimeoutMs = (legsRemaining) => Math.max(MIN_LEG_TIMEOUT_MS, Math.ceil((deadline - Date.now()) / legsRemaining));

  const singleRead = geminiOnly(ladder);
  const candidatesResult = await callCandidatesModel(images, catalogEntries, legTimeoutMs(3), singleRead);
  // An `ok:true` response whose shape doesn't match what was requested is
  // treated the same as a failed leg — see `hasCandidatesArray`.
  const candidatesJson = validLegJson(candidatesResult, 'candidates');
  const candidatesEnvelope = candidatesJson || {};
  const candidatesShows = candidatesEnvelope.shows;
  const candidatesFromCall1 = candidatesJson ? dedupeCandidates(sanitizedCandidatesOf(candidatesJson).map(resolveCandidate)) : [];
  const catalogCandidates1 = candidatesFromCall1.filter((c) => c.entry);

  let verifyResult = null;
  let verifiedCandidates = candidatesFromCall1;
  if (catalogCandidates1.length && !singleRead) {
    verifyResult = await callVerifyModel(images, candidateContextFor(catalogCandidates1), legTimeoutMs(2));
    verifiedCandidates = mergeVerify(candidatesFromCall1, verifyResult);
  }

  // A high-confidence sign cannot suppress a second provider when this
  // leg says the photo shows an organism (or vice versa). Apply the same
  // evidence-kind rule used by the final answer to every escalation trigger.
  let evidenceKind = normalizeEvidenceKind(candidatesShows);
  const matchesShownKind = candidate => !evidenceKind.hiddenKind || candidate.entry?.kind !== evidenceKind.hiddenKind;
  const triggerCandidates = verifiedCandidates.filter(matchesShownKind);
  const triggerCatalogCandidates = catalogCandidates1.filter(matchesShownKind);
  const triggerJson = {
    ...candidatesEnvelope,
    candidates: sanitizedCandidatesOf(candidatesJson).filter(candidate => matchesShownKind(resolveCandidate(candidate))),
  };
  const missingVerification = triggerCatalogCandidates.length > 0
    && !verifyCoversAllCandidates(verifyResult, triggerCatalogCandidates);
  const geminiMissed = [!candidatesJson, missingVerification].includes(true);
  const contradicted = detectSelfContradiction(triggerJson, triggerCandidates);
  const lookAlikeClose = consequentialLookAlikeClose(triggerCandidates);
  // Only a candidate that resolves to a catalog node can vouch for the
  // read; an unresolvable name's confidence must not suppress escalation.
  const verifiedTop = dedupeCandidates(triggerCandidates.filter((c) => candidateNodeId(c)))[0] || null;
  const topConfidenceForTrigger = verifiedTop ? verifiedTop.confidence : 0;

  // Gemini-only: a reply whose candidate items were all malformed is a miss
  // too, not an unknown; a valid empty list is still a genuine unknown
  // (Codex #5560 r3 P2).
  const rawCandidateCount = hasCandidatesArray(candidatesResult?.json) ? candidatesResult.json.candidates.length : 0;
  const noUsableRead = !candidatesJson || (rawCandidateCount > 0 && candidatesFromCall1.length === 0);
  const escalationReasons = (singleRead ? [[noUsableRead, 'gemini_missed']] : [
    [geminiMissed, 'gemini_missed'],
    [contradicted, 'self_contradiction'],
    [lookAlikeClose, 'consequential_lookalike_close'],
    [topConfidenceForTrigger < escalateBelow(), 'low_confidence'],
  ]).filter(([applies]) => applies).map(([, reason]) => reason);
  const escalationTriggered = escalationReasons.length > 0;

  let finalCandidates = dedupeCandidates(verifiedCandidates);
  let disagreed = false;
  let disagreementNode = null;
  let escalationResult = null;
  let escalationJson = null;
  let escalationShows = null;
  // Codex round-0 P1 (round 2): "OpenAI answered" must mean it actually
  // named a candidate, not merely that the HTTP call succeeded — an ok
  // response with an empty candidates list confirms nothing and must cap
  // pretty_sure the same as an unavailable leg (see `combineEscalation`).
  let openaiAnswered = false;
  let openaiStoodInAlone = false;

  if (escalationTriggered) {
    escalationResult = await callEscalationModel(images, catalogEntries, candidateContextFor(catalogCandidates1), legTimeoutMs(1), singleRead);
    escalationJson = validLegJson(escalationResult, 'escalation');
    escalationShows = (escalationJson || {}).shows;
    evidenceKind = normalizeEvidenceKind(candidatesShows, escalationShows);
    const contextSlugs = new Set(catalogCandidates1.map((c) => c.slug));
    ({
      finalCandidates, disagreed, disagreementNode, openaiAnswered, openaiStoodInAlone,
    } = combineEscalation(finalCandidates, escalationResult, contextSlugs, evidenceKind.hiddenKind));
  }

  // Codex round-0 P1 (PR-2b wiring round 1): `no_route` means the model
  // POLICY was never registered (MODELS.TEXT_POLICIES.photoIdVision
  // missing/misconfigured) — a permanent misconfiguration, not a transient
  // provider miss. If EVERY leg that was actually attempted came back
  // `no_route`, no photo was ever analyzed by anyone; degrading to a
  // deterministic "unknown" answer would let the route persist a
  // misleadingly `status: 'analyzed'` row and a confident-looking 200 for
  // a feature that is completely unconfigured. Fail the same way `identifyPest`
  // (v1) already does on a total vision miss — `{ok:false}`, a 503 at the
  // route — instead of a silent, empty "we couldn't tell" degrade.
  const attemptedLegs = [candidatesResult, verifyResult, escalationResult].filter(Boolean);
  const everyAttemptedLegUnconfigured = attemptedLegs.every((result) => result.reason === 'no_route');
  if (everyAttemptedLegUnconfigured) {
    return { ok: false, reason: 'no_route' };
  }

  // Neither vision leg produced a valid envelope (keys missing, timeouts,
  // provider errors, malformed output): nobody analyzed the photos, so
  // this is a failure, not an "unknown" read. A valid envelope with an
  // empty candidates list still is a genuine unknown (Codex #4916 r2 P1).
  if ([candidatesJson, escalationJson].every((result) => !result)) {
    return { ok: false, reason: 'vision_unavailable' };
  }
  const quality = combineQuality(candidatesEnvelope.quality, (escalationJson || {}).quality);
  // A leg that names a candidate while reporting the photos show nothing
  // contradicts itself; one such read (or two agreeing ones) is as weak as
  // two legs that disagree (pre-push audit on Codex #4916 r1).
  const subjectConflict = showsConflict(candidatesShows, escalationShows)
    || [candidatesShows, escalationShows].includes('nothing');
  const currentMonth = etParts(new Date()).month;

  const built = buildAnswer({
    candidates: finalCandidates,
    disagreed,
    disagreementNode,
    escalationTriggered,
    openaiAnswered,
    openaiStoodInAlone,
    qualityUsable: !!quality.usable,
    qualityIssue: quality.issue || 'none',
    subjectConflict,
    evidenceKind,
    currentMonth,
  });

  const v2 = {
    version: 2,
    catalog_version: catalog.CATALOG_VERSION,
    tier: built.tier,
    answer: built.answer,
    group: built.group,
    entry: built.entry,
    evidence: built.evidence,
    candidates: built.candidatesBlock,
    next_photo: built.nextPhoto,
    referral: built.referral,
    generic_safety_line: built.genericSafetyLine,
  };

  const v1 = mapToV1({ ...built, disagreed });

  const internal = {
    models: {
      candidates: legInfo(candidatesResult),
      verify: legInfo(verifyResult),
      escalation: legInfo(escalationResult),
    },
    ladder: singleRead ? 'gemini_only' : 'full',
    escalation_triggered: escalationTriggered,
    escalation_reasons: escalationReasons,
    disagreed,
  };

  return { ok: true, v2, v1, internal };
}

module.exports = {
  identifyPestV2,
  // Pure helpers, exported for unit tests (V2-CONTRACT.md engine step 4 is
  // "heavily unit-tested" per the build brief).
  buildAnswer,
  mapToV1,
  resolveCandidate,
  dedupeCandidates,
  sameCandidateKey,
  candidateNodeId,
  isConsequential,
  detectSelfContradiction,
  consequentialLookAlikeClose,
  climbLineage,
  deepestSharedNode,
  evidenceFor,
  candidatesBlockFor,
  nextPhotoFor,
  referralFor,
  isApproved,
  VERDICT_LABELS,
  ROLE_LABELS,
  RISK_LABELS,
  ACTION_LABELS,
  REFERRAL_TEMPLATES,
  UNNAMED_SAFETY_LINE,
  UNNAMED_SAFETY_CLAUSES,
  UNNAMED_NEXT_PHOTO,
  NO_PHOTO_CONFIRMS,
  HAZARD_CLAUSES,
  escalateBelow,
  toImages,
  _test: {
    candidateContextFor, mergeVerify, combineEscalation, showsConflict, normalizeEvidenceKind,
    V2_TO_V1_SLUG, v1IdentityFor, pairBetween, unnamedSafetyLineFor,
  },
};
