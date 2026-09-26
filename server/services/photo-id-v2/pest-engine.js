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
 * Model calls (steps 1–3): Gemini candidates → Gemini verify (only when ≥1
 * catalog candidate) → OpenAI escalation (only when a trigger fires),
 * SEQUENTIAL, never parallel, no Claude leg — the same deliberate departure
 * from the Claude-fallback rule as `lawn-visit-assessment.js`
 * (`MODELS.TEXT_POLICIES.photoIdVision`, added by PR #4865 — this module
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
const MAX_OUTPUT_TOKENS = 2048;
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
  report_fwc: 'This is protected wildlife. Please report it to the Florida Fish and Wildlife Conservation Commission (FWC) rather than handling it yourself.',
  report_fdacs: 'This may be a regulated pest of concern. Please report it to the Florida Department of Agriculture and Consumer Services (FDACS).',
  protected_leave_alone: 'This animal and its burrow are protected by Florida law. Please leave it undisturbed — no treatment is needed here.',
};

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
 */
function resolveCandidate(raw) {
  const rawSlug = String(raw?.slug || '').trim();
  const entry = rawSlug ? catalog.getEntry(rawSlug) : null;
  const confidence = clamp01(raw?.confidence);
  const traitsVisible = Array.isArray(raw?.traits_visible) ? raw.traits_visible.filter(Number.isFinite) : [];
  const traitsNotVisible = Array.isArray(raw?.traits_not_visible) ? raw.traits_not_visible.filter(Number.isFinite) : [];
  // Two orchestration flags, both false until a trait check runs:
  // `checked` — a real trait check produced this confidence (its score
  // replaces an unchecked guess, even when it found nothing supporting);
  // `verified` — that check also cited at least one visible trait, which
  // is what "pretty sure" requires (Codex round-0 P1, rounds 12–18).
  if (entry) {
    return {
      slug: entry.slug, offCatalogName: null, groupId: entry.group, confidence, entry, traitsVisible, traitsNotVisible, checked: false, verified: false,
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
  if (candidate.groupId && catalog.getGroup(candidate.groupId)) return candidate.groupId;
  return null;
}

// Contract delta 2026-09-26 #5: risk dimensions for escalation are sting,
// venom, structural, disease, inspection-first, toxic_to_pets, and (new)
// irritant — any of these, or an explicit "call" verdict, makes a candidate
// consequential for the look-alike-close escalation trigger and decision
// #2's harmless-plainly guard.
function isConsequential(entry) {
  if (!entry) return false;
  const s = entry.safety || {};
  return entry.verdict === 'call'
    || !!s.stings || !!s.venomous || !!s.structural || !!s.toxic_to_pets || !!s.irritant || !!s.disease_vector
    || !!entry.service?.inspection_first;
}

// Contract delta 2026-09-26 #1: the engine names an entry only when its
// catalog review is owner-approved AND fact-check-clean — an unreviewed or
// fact-check-pending entry can never be shown by name, whatever the models
// say. Confidence math and escalation triggers are unaffected; only naming
// (the `entry` level/block) is gated.
function isApproved(entry) {
  return !!entry && entry.review?.status === 'owner_approved' && Array.isArray(entry.verification) && entry.verification.length === 0;
}

function candidateContextFor(candidates) {
  return candidates.filter((c) => c.entry).map((c) => ({
    slug: c.slug,
    common_name: c.entry.common_name,
    traits: c.entry.traits || [],
    lookAlikeDifferences: (c.entry.look_alikes || []).map((la) => la.difference).filter(Boolean),
  }));
}

// ── model calls (sequential, no Claude leg) ────────────────────────────────

async function callWithProvider(route, payload) {
  if (!route || !route.provider || !route.model) return { ok: false, reason: 'no_route', provider: route?.provider || null, model: route?.model || null };
  const result = await dispatch(route, payload);
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

async function callCandidatesModel(images, catalogEntries, timeoutMs) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.primary;
  return callWithProvider(route, {
    system: buildCandidatesSystemPrompt(buildCatalogIndexText(catalogEntries)),
    text: `These ${images.length} photo(s) show the same subject from different angles. Identify it.`,
    images,
    jsonMode: true,
    jsonSchema: CANDIDATES_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    laneId: 'photo_id_v2_candidates',
    promptVersion: PROMPT_VERSION,
  });
}

async function callVerifyModel(images, candidateContext, timeoutMs) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.primary;
  return callWithProvider(route, {
    system: buildVerifySystemPrompt(candidateContext),
    text: 'Check each candidate above against these same photos.',
    images,
    jsonMode: true,
    jsonSchema: VERIFY_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs,
    laneId: 'photo_id_v2_verify',
    promptVersion: PROMPT_VERSION,
  });
}

async function callEscalationModel(images, catalogEntries, candidateContext, timeoutMs) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.fallback;
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
    const traitsVisible = v.traits_visible.filter(Number.isFinite);
    return {
      ...c,
      confidence: clamp01(v.confidence),
      traitsVisible,
      traitsNotVisible: v.traits_not_visible.filter(Number.isFinite),
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
    for (const rung of catalog.lineage(nodeId)) {
      if (rung.level === 'entry') continue;
      const key = `${rung.level}:${rung.id}`;
      if (!byKey.has(key)) byKey.set(key, rung);
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
    if (sum >= LINEAGE_CLIMB_MIN && sum > bestSum) { best = rung; bestSum = sum; }
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
  return catalogCandidates.map((c) => {
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
    };
  });
}

// Contract delta 2026-09-26 #3: a curated pair's OWN `photo_can_confirm`
// (false when no single photo separates the pair — the pair's `next_photo`
// text says what DOES confirm it instead) rides on the object; a node-level
// prompt (no specific pair) is always `photo_can_confirm: true`.
/** The curated pair between two entries, looked up in either direction —
 * catalog look-alikes are sometimes one-way (bigheaded ant lists fire ant,
 * not the reverse; Codex #4916 r3). A reverse pair is returned with `slug`
 * pointing at `other`, so callers can treat it like `entry`'s own. */
function pairBetween(entry, other) {
  if (!entry || !other) return null;
  const own = (entry.look_alikes || []).find((l) => l.slug === other.slug);
  if (own) return own;
  const reverse = (other.look_alikes || []).find((l) => l.slug === entry.slug);
  return reverse ? { ...reverse, slug: other.slug } : null;
}

function pairIfBothApproved(entry, other) {
  const pair = pairBetween(entry, other);
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
function governingPair(top, second) {
  return (second?.entry && pairBetween(top?.entry, second.entry)) || (top?.entry?.look_alikes || [])[0] || null;
}

function firstApprovedLookAlike(entry) {
  return (entry.look_alikes || []).find((la) => isApproved(catalog.getEntry(la.slug))) || null;
}

function nextPhotoFor(wording, candidates, level, nodeId) {
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
  if (top?.entry && second?.entry && isApproved(top.entry) && isApproved(second.entry)) {
    const pair = pairIfBothApproved(top.entry, second.entry);
    if (pair) return { ask: pair.next_photo || null, why: pair.difference || null, photo_can_confirm: pair.photo_can_confirm !== false };
  }
  // Entry level with no usable second-candidate pair: the SAME fallback
  // `catalog.nextPhoto` uses internally for a bare entry (its own first
  // look-alike WHOSE OWN TARGET IS APPROVED) — read directly so
  // `photo_can_confirm` survives (`catalog.nextPhoto`'s wrapper drops it).
  if (level === 'entry' && top?.entry) {
    const governing = governingPair(top, second);
    if (governing && !isApproved(catalog.getEntry(governing.slug))) {
      // Its prose names the unapproved look-alike, so it can't be shown.
      // A pair no photo can settle gets fixed technician guidance (the
      // group's photo prompt would contradict it); otherwise the group's
      // generic prompt stands in.
      if (governing.photo_can_confirm === false) return { ...NO_PHOTO_CONFIRMS };
      const np = catalog.nextPhoto(top.entry.group);
      return { ask: np?.ask || null, why: np?.why || null, photo_can_confirm: true };
    }
    const fallbackPair = firstApprovedLookAlike(top.entry);
    return fallbackPair
      ? { ask: fallbackPair.next_photo || null, why: fallbackPair.difference || null, photo_can_confirm: fallbackPair.photo_can_confirm !== false }
      : null;
  }
  // Node level (group/subgroup/category): the catalog's own authored
  // prompt has no per-pair confirmability of its own — always
  // photo_can_confirm: true (contract delta #3).
  const np = nodeId ? catalog.nextPhoto(nodeId) : null;
  return np ? { ask: np.ask || null, why: np.why || null, photo_can_confirm: true } : null;
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
function entryLevelAnswer(candidates, top, blockPrettySure) {
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
  const applicablePair = (second?.entry && pairIfBothApproved(top.entry, second.entry)) || firstApprovedLookAlike(top.entry);
  const unconfirmablePair = applicablePair?.photo_can_confirm === false
    || governingPair(top, second)?.photo_can_confirm === false;
  // Codex round-0 P1 (rounds 10–15): "pretty sure" is only ever earned by a
  // confidence a real trait check produced. One gate here, instead of each
  // merge path proving it never lets an unchecked number through.
  const blocked = blockPrettySure || !top.verified;
  const named = (wording) => ({
    level: 'entry', wording, nodeId: top.slug, subhead: top.entry.scientific_name || null,
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

/**
 * Pure deterministic answer builder. `ctx.candidates` is the FINAL,
 * already-combined (Gemini + OpenAI, when escalated) candidate list, ranked
 * by confidence, capped at 3. See V2-CONTRACT.md engine step 4.
 */
function buildAnswer(ctx) {
  const {
    candidates, disagreed, disagreementNode, escalationTriggered, openaiAnswered, openaiStoodInAlone,
    qualityUsable, qualityIssue, subjectConflict, currentMonth,
  } = ctx;
  const unansweredTrigger = escalationTriggered && !openaiAnswered;
  // Codex round-0 P1 (round 10): an OpenAI candidate that stood in ALONE
  // because Gemini gave us nothing was never checked against a single
  // numbered trait by either provider (its own escalation prompt tells it
  // to report empty trait arrays in that case) — same pretty_sure cap as
  // an unanswered trigger, for the same underlying reason: no real
  // verification happened.
  const blockPrettySure = unansweredTrigger || !!openaiStoodInAlone;
  const top = candidates[0] || null;

  const picked = disagreed
    ? climbedOrDisagreedAnswer(candidates, true, disagreementNode)
    : (entryLevelAnswer(candidates, top, blockPrettySure) || climbedOrDisagreedAnswer(candidates, false, null));
  const { level, wording, nodeId, subhead, headline, entry } = picked;

  const group = groupBlockFor(level, nodeId, entry);
  const evidence = evidenceFor(candidatesSupporting(candidates, level, nodeId));
  const candidatesBlock = candidatesBlockFor(candidates, currentMonth);
  const nextPhoto = nextPhotoFor(wording, candidates, level, nodeId);

  // Contract delta 2026-09-26 #3: a chosen pair no single photo can settle
  // keeps the tier at needs_more_evidence even at entry level (`likely`) —
  // added to the same-effect checks the original contract already listed
  // (quality, subject conflict, disagreement, above-entry-level).
  const tier = (!qualityUsable || qualityIssue === 'multiple_subjects' || subjectConflict || disagreed || level !== 'entry'
    || nextPhoto?.photo_can_confirm === false)
    ? 'needs_more_evidence'
    : 'ai_suggestion';

  return {
    answer: { level, node_id: nodeId, wording, headline, subhead },
    group,
    entry: entry ? buildEntryBlock(entry) : null,
    evidence,
    candidatesBlock,
    nextPhoto,
    referral: entry ? referralFor(entry) : null,
    tier,
    topEntrySlug: entry ? entry.slug : null,
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

/** The v1 slug for a v2 node: its own legacy mapping, else the nearest
 * ancestor's (`aedes-mosquito` -> the `mosquitoes` group -> v1 `mosquito`).
 * Every v1 slug mapped at a group/subgroup carries a generic v1 label
 * ("Mosquitoes", "Widow Spiders"), so this never over-claims a species
 * (Codex #4916 r2 P2). */
function v1SlugFor(v2Slug) {
  if (!v2Slug) return null;
  const rungs = catalog.lineage(v2Slug).slice().reverse();
  for (const rung of rungs) {
    const v1 = V2_TO_V1_SLUG.get(rung.id);
    if (v1) return v1;
  }
  return null;
}

function categoryForV2Slug(slug) {
  const entry = catalog.getEntry(slug);
  const group = entry ? catalog.getGroup(entry.group) : null;
  return (group && group.category) || 'other';
}

function v1SafetyFallback(entry) {
  const s = entry?.safety || {};
  return {
    stinging: !!s.stings, venomous: !!s.venomous, disease_vector: !!s.disease_vector, structural_threat: !!s.structural,
  };
}

const DEFAULT_SAFETY = { stinging: false, venomous: false, disease_vector: false, structural_threat: false };

/**
 * Map the built v2 answer to the v1 columns the route still writes
 * (`species_slug`, `category`, `service_line`, `urgency`, a v1-shaped
 * `report_contract`) so admin pages, the history list's `pestHeadline`, and
 * `pestNextStepKindFromRow`/`pestReserviceLane` — all of which read
 * `report_contract` through v1's OWN `PEST_LIBRARY`/`GROUP_GENERIC`
 * vocabulary — keep working unchanged. When the v2 entry has no v1 legacy
 * slug (a new catalog entry v1 never had), this degrades exactly the way
 * v1's own unmatched-identification path already does: `identification.slug
 * = null`, generic category/service, `inspection_required: true` — never a
 * fabricated v1 identity.
 */
function mapToV1(built) {
  const topEntrySlug = built.topEntrySlug;
  const v1Slug = v1SlugFor(topEntrySlug);
  const v1Item = v1Slug ? V1_BY_SLUG.get(v1Slug) : null;
  const v2Entry = topEntrySlug ? catalog.getEntry(topEntrySlug) : null;

  const category = v1Item ? v1Item.category : (topEntrySlug ? categoryForV2Slug(topEntrySlug) : 'other');
  const confidence = built.answer.wording === 'pretty_sure' ? 'high' : (built.answer.wording === 'likely' ? 'moderate' : 'low');
  const contested = built.tier === 'needs_more_evidence' && !!built.disagreed;

  const safety = v1Item ? v1Item.safety : (v2Entry ? v1SafetyFallback(v2Entry) : DEFAULT_SAFETY);
  const serviceLine = v1Item ? v1Item.service_line : (v2Entry ? (v2Entry.service?.line || 'pest') : 'pest');
  const serviceKey = v1Item ? v1Item.service_key : null;
  const serviceLabel = v1Item ? v1Item.service_label : 'Pest Consultation';
  const inspectionRequired = v1Item ? v1Item.inspection_required : (v2Entry ? !!v2Entry.service?.inspection_first : true);
  const urgency = v1Item ? v1Item.urgency : (v2Entry ? (v2Entry.urgency || 'low') : 'low');
  const group = v1Item ? v1Item.group : null;
  const label = v1Item ? v1Item.label : null;

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
      .map((c) => v1SlugFor(c.slug))
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

function combineEscalation(geminiCandidates, escalationResult, contextSlugs) {
  // Codex round-0 P1 (round 4): `dispatch()` does not locally validate a
  // provider's JSON against the requested schema — an `ok:true` response
  // whose `candidates` field isn't an array (or is missing) must be
  // treated as a failed/unavailable leg, never consumed as-is (it would
  // throw on `.map` below, breaking the engine's never-throws contract).
  if (!validLegJson(escalationResult, 'escalation')) {
    // OpenAI unavailable (or answered something invalid) — Gemini's result
    // stands, capped from reading pretty_sure by `unansweredTrigger` inside
    // `buildAnswer`.
    return { finalCandidates: geminiCandidates, disagreed: false, disagreementNode: null, openaiAnswered: false, openaiStoodInAlone: false };
  }
  const openaiCandidates = dedupeCandidates(
    sanitizedCandidatesOf(validLegJson(escalationResult, 'escalation')).filter(isValidEscalationCandidate).map(resolveCandidate)
      .map((c) => stripUncontextedTraits(c, contextSlugs)),
  );
  const openaiTop = openaiCandidates[0] || null;
  const geminiTop = geminiCandidates[0] || null;
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
    return { finalCandidates: geminiCandidates, disagreed: false, disagreementNode: null, openaiAnswered, openaiStoodInAlone: false };
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
      finalCandidates: [bumped, ...dedupeCandidates([...geminiCandidates.slice(1), ...openaiCandidates.slice(1)])
        .filter((c) => !sameCandidateKey(c, bumped))].slice(0, 3),
      disagreed: false,
      disagreementNode: null,
      openaiAnswered,
      openaiStoodInAlone: false,
    };
  }
  return {
    finalCandidates: dedupeCandidates([geminiTop, openaiTop, ...geminiCandidates.slice(1), ...openaiCandidates.slice(1)]),
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
async function identifyPestV2(photos = []) {
  const images = toImages(photos);
  if (!images.length) return { ok: false, reason: 'no_photos' };

  const catalogEntries = catalog.listEntries();
  // One overall wall-clock budget across the (up to three) SEQUENTIAL
  // provider legs, so a stalled candidates or verify call can never starve
  // escalation of its share (Codex round-0 P1, round 4).
  const deadline = Date.now() + totalBudgetMs();
  const legTimeoutMs = (legsRemaining) => Math.max(MIN_LEG_TIMEOUT_MS, Math.ceil((deadline - Date.now()) / legsRemaining));

  const candidatesResult = await callCandidatesModel(images, catalogEntries, legTimeoutMs(3));
  // An `ok:true` response whose shape doesn't match what was requested is
  // treated the same as a failed leg — see `hasCandidatesArray`.
  const candidatesJson = validLegJson(candidatesResult, 'candidates');
  const candidatesFromCall1 = candidatesJson ? dedupeCandidates(sanitizedCandidatesOf(candidatesJson).map(resolveCandidate)) : [];
  const catalogCandidates1 = candidatesFromCall1.filter((c) => c.entry);

  let verifyResult = null;
  let verifiedCandidates = candidatesFromCall1;
  if (catalogCandidates1.length) {
    verifyResult = await callVerifyModel(images, candidateContextFor(catalogCandidates1), legTimeoutMs(2));
    verifiedCandidates = mergeVerify(candidatesFromCall1, verifyResult);
  }

  const geminiMissed = !candidatesJson
    || (catalogCandidates1.length > 0 && !verifyCoversAllCandidates(verifyResult, catalogCandidates1));
  const contradicted = catalogCandidates1.length > 0 && detectSelfContradiction(candidatesJson, verifiedCandidates);
  const lookAlikeClose = consequentialLookAlikeClose(verifiedCandidates);
  // Only a candidate that resolves to a catalog node can vouch for the
  // read; an unresolvable name's confidence must not suppress escalation.
  const verifiedTop = dedupeCandidates(verifiedCandidates.filter((c) => candidateNodeId(c)))[0] || null;
  const topConfidenceForTrigger = verifiedTop ? verifiedTop.confidence : 0;

  const escalationReasons = [];
  if (geminiMissed) escalationReasons.push('gemini_missed');
  if (contradicted) escalationReasons.push('self_contradiction');
  if (lookAlikeClose) escalationReasons.push('consequential_lookalike_close');
  if (topConfidenceForTrigger < escalateBelow()) escalationReasons.push('low_confidence');
  const escalationTriggered = escalationReasons.length > 0;

  let finalCandidates = dedupeCandidates(verifiedCandidates);
  let disagreed = false;
  let disagreementNode = null;
  let escalationResult = null;
  // Codex round-0 P1 (round 2): "OpenAI answered" must mean it actually
  // named a candidate, not merely that the HTTP call succeeded — an ok
  // response with an empty candidates list confirms nothing and must cap
  // pretty_sure the same as an unavailable leg (see `combineEscalation`).
  let openaiAnswered = false;
  let openaiStoodInAlone = false;

  if (escalationTriggered) {
    escalationResult = await callEscalationModel(images, catalogEntries, candidateContextFor(catalogCandidates1), legTimeoutMs(1));
    const contextSlugs = new Set(catalogCandidates1.map((c) => c.slug));
    ({
      finalCandidates, disagreed, disagreementNode, openaiAnswered, openaiStoodInAlone,
    } = combineEscalation(finalCandidates, escalationResult, contextSlugs));
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
  const everyAttemptedLegUnconfigured = candidatesResult.reason === 'no_route'
    && (!verifyResult || verifyResult.reason === 'no_route')
    && (!escalationResult || escalationResult.reason === 'no_route');
  if (everyAttemptedLegUnconfigured) {
    return { ok: false, reason: 'no_route' };
  }

  const escalationJson = validLegJson(escalationResult, 'escalation');
  // Neither vision leg produced a valid envelope (keys missing, timeouts,
  // provider errors, malformed output): nobody analyzed the photos, so
  // this is a failure, not an "unknown" read. A valid envelope with an
  // empty candidates list still is a genuine unknown (Codex #4916 r2 P1).
  if (!candidatesJson && !escalationJson) {
    return { ok: false, reason: 'vision_unavailable' };
  }
  const quality = combineQuality(candidatesJson?.quality, escalationJson?.quality);
  // A leg that names a candidate while reporting the photos show nothing
  // contradicts itself; one such read (or two agreeing ones) is as weak as
  // two legs that disagree (pre-push audit on Codex #4916 r1).
  const subjectConflict = showsConflict(candidatesJson?.shows, escalationJson?.shows)
    || candidatesJson?.shows === 'nothing' || escalationJson?.shows === 'nothing';
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
  };

  const v1 = mapToV1({ ...built, disagreed });

  const internal = {
    models: {
      candidates: legInfo(candidatesResult),
      verify: legInfo(verifyResult),
      escalation: legInfo(escalationResult),
    },
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
  escalateBelow,
  toImages,
  _test: { candidateContextFor, mergeVerify, combineEscalation, showsConflict, V2_TO_V1_SLUG },
};
