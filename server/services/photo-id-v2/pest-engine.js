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
  if (entry) {
    return { slug: entry.slug, offCatalogName: null, groupId: entry.group, confidence, entry, traitsVisible, traitsNotVisible };
  }
  return {
    slug: null,
    offCatalogName: String(raw?.off_catalog_name || rawSlug || '').trim() || null,
    groupId: String(raw?.group_id || '').trim() || null,
    confidence,
    entry: null,
    traitsVisible,
    traitsNotVisible,
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
    if (!existing || c.confidence > existing.confidence) seen.set(key, c);
  }
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

async function callCandidatesModel(images, catalogEntries) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.primary;
  return callWithProvider(route, {
    system: buildCandidatesSystemPrompt(buildCatalogIndexText(catalogEntries)),
    text: `These ${images.length} photo(s) show the same subject from different angles. Identify it.`,
    images,
    jsonMode: true,
    jsonSchema: CANDIDATES_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    laneId: 'photo_id_v2_candidates',
    promptVersion: PROMPT_VERSION,
  });
}

async function callVerifyModel(images, candidateContext) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.primary;
  return callWithProvider(route, {
    system: buildVerifySystemPrompt(candidateContext),
    text: 'Check each candidate above against these same photos.',
    images,
    jsonMode: true,
    jsonSchema: VERIFY_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    laneId: 'photo_id_v2_verify',
    promptVersion: PROMPT_VERSION,
  });
}

async function callEscalationModel(images, catalogEntries, candidateContext) {
  const route = MODELS.TEXT_POLICIES?.photoIdVision?.fallback;
  return callWithProvider(route, {
    system: buildEscalationSystemPrompt(buildCatalogIndexText(catalogEntries), candidateContext),
    text: `These ${images.length} photo(s) show the same subject from different angles. Identify it and check any candidates already raised.`,
    images,
    jsonMode: true,
    jsonSchema: ESCALATION_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
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
function verifyCoversAllCandidates(verifyResult, catalogCandidates) {
  if (!verifyResult?.ok || !Array.isArray(verifyResult.json?.candidates)) return false;
  const verifiedSlugs = new Set(verifyResult.json.candidates.filter((v) => v?.slug).map((v) => String(v.slug)));
  return catalogCandidates.every((c) => verifiedSlugs.has(c.slug));
}

function mergeVerify(candidates, verifyResult) {
  const bySlug = new Map();
  if (verifyResult?.ok && Array.isArray(verifyResult.json?.candidates)) {
    for (const v of verifyResult.json.candidates) {
      if (v && v.slug) bySlug.set(String(v.slug), v);
    }
  }
  return candidates.map((c) => {
    if (!c.entry) return c;
    const v = bySlug.get(c.slug);
    if (!v) return c;
    return {
      ...c,
      confidence: clamp01(v.confidence),
      traitsVisible: Array.isArray(v.traits_visible) ? v.traits_visible.filter(Number.isFinite) : [],
      traitsNotVisible: Array.isArray(v.traits_not_visible) ? v.traits_not_visible.filter(Number.isFinite) : [],
    };
  });
}

/** Candidates-call top entry vs. verify-call top entry rank a different top
 * entry, OR the verify call marks most of the top entry's traits not
 * visible. */
function detectSelfContradiction(candidatesJson, verifiedCandidates) {
  const rawList = Array.isArray(candidatesJson?.candidates) ? candidatesJson.candidates : [];
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

/** Deepest subgroup/group whose summed candidate confidence >= 0.60; else
 * category >= 0.60; else null (unknown). */
function climbLineage(candidates) {
  const top = candidates[0];
  const topNodeId = top ? candidateNodeId(top) : null;
  if (!topNodeId) return null;
  const lineage = catalog.lineage(topNodeId);
  const nonCategoryRungs = lineage.filter((r) => r.level === 'subgroup' || r.level === 'group').reverse();
  for (const rung of nonCategoryRungs) {
    if (sumConfidenceAtNode(candidates, rung.level, rung.id) >= LINEAGE_CLIMB_MIN) return rung;
  }
  const categoryRung = lineage.find((r) => r.level === 'category');
  if (categoryRung && sumConfidenceAtNode(candidates, 'category', categoryRung.id) >= LINEAGE_CLIMB_MIN) return categoryRung;
  return null;
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
    // Codex round-0 P1: a look-alike's own catalog identity is gated by ITS
    // OWN review approval, same as any other candidate — an approved
    // entry's page must not out an unapproved look-alike by name/slug just
    // because it happens to be listed here.
    look_alikes: catalog.lookAlikes(entry.slug).map((la) => ({
      slug: la.node && isApproved(la.node) ? la.slug : null,
      common_name: la.node && isApproved(la.node) ? la.node.common_name : null,
      difference: la.difference || null,
    })),
  };
}

function evidenceFor(candidates) {
  const top = candidates.find((c) => c.entry) || null;
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
      difference_from_top: approved ? differenceFromTop(c, top) : null,
      local: localLabel(c.entry, currentMonth),
    };
  });
}

// Contract delta 2026-09-26 #3: a curated pair's OWN `photo_can_confirm`
// (false when no single photo separates the pair — the pair's `next_photo`
// text says what DOES confirm it instead) rides on the object; a node-level
// prompt (no specific pair) is always `photo_can_confirm: true`.
function nextPhotoFor(wording, candidates, level, nodeId) {
  if (wording === 'pretty_sure') return null;
  const top = candidates[0] || null;
  const second = candidates[1] || null;
  // A curated pair between the top two candidates. Read the raw
  // `look_alikes` entry directly (not the `lookAlikes()` convenience
  // wrapper, which does not pass through `photo_can_confirm`) so a pair
  // explicitly marked unconfirmable-by-photo is honored.
  if (top?.entry && second?.entry) {
    const pair = (top.entry.look_alikes || []).find((l) => l.slug === second.entry.slug);
    if (pair) return { ask: pair.next_photo || null, why: pair.difference || null, photo_can_confirm: pair.photo_can_confirm !== false };
  }
  // Entry level with no second-candidate pair match: the SAME fallback
  // `catalog.nextPhoto` uses internally for a bare entry (its own first
  // look-alike) — read directly, same reason as above (Codex round-0 P1:
  // `catalog.nextPhoto`'s wrapper was silently dropping `photo_can_confirm`
  // here too, always reading as confirmable).
  if (level === 'entry' && top?.entry) {
    const fallbackPair = (top.entry.look_alikes || [])[0];
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
function entryLevelAnswer(candidates, top, unansweredTrigger) {
  if (!top?.entry || !isApproved(top.entry)) return null;
  const named = (wording) => ({
    level: 'entry', wording, nodeId: top.slug, subhead: top.entry.scientific_name || null,
    headline: `${wording === 'pretty_sure' ? "We're pretty sure" : 'Likely'}: ${top.entry.common_name}`,
    entry: top.entry,
  });
  if (top.confidence >= PRETTY_SURE_MIN && !unansweredTrigger) return named('pretty_sure');
  if (isHarmlessOrAlly(top.entry) && top.confidence >= HARMLESS_PRETTY_SURE_MIN
    && !consequentialAltClose(candidates, top) && !unansweredTrigger) return named('pretty_sure');
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
    candidates, disagreed, disagreementNode, escalationTriggered, openaiAnswered,
    qualityUsable, qualityIssue, currentMonth,
  } = ctx;
  const unansweredTrigger = escalationTriggered && !openaiAnswered;
  const top = candidates[0] || null;

  const picked = disagreed
    ? climbedOrDisagreedAnswer(candidates, true, disagreementNode)
    : (entryLevelAnswer(candidates, top, unansweredTrigger) || climbedOrDisagreedAnswer(candidates, false, null));
  const { level, wording, nodeId, subhead, headline, entry } = picked;

  const group = groupBlockFor(level, nodeId, entry);
  const evidence = evidenceFor(candidates);
  const candidatesBlock = candidatesBlockFor(candidates, currentMonth);
  const nextPhoto = nextPhotoFor(wording, candidates, level, nodeId);

  // Contract delta 2026-09-26 #3: a chosen pair no single photo can settle
  // keeps the tier at needs_more_evidence even at entry level (`likely`) —
  // added to the same-effect checks the original contract already listed
  // (quality, subject conflict, disagreement, above-entry-level).
  const tier = (!qualityUsable || qualityIssue === 'multiple_subjects' || disagreed || level !== 'entry'
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
  const v1Slug = topEntrySlug ? (V2_TO_V1_SLUG.get(topEntrySlug) || null) : null;
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
    alternate_slugs: built.candidatesBlock.slice(1).map((c) => c.slug).filter(Boolean),
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
function combineEscalation(geminiCandidates, escalationResult) {
  if (!escalationResult?.ok) {
    // OpenAI unavailable — Gemini's result stands, capped from reading
    // pretty_sure by `unansweredTrigger` inside `buildAnswer`.
    return { finalCandidates: geminiCandidates, disagreed: false, disagreementNode: null };
  }
  const openaiCandidates = dedupeCandidates((escalationResult.json?.candidates || []).map(resolveCandidate));
  const openaiTop = openaiCandidates[0] || null;
  const geminiTop = geminiCandidates[0] || null;

  if (openaiTop && !geminiTop) {
    return { finalCandidates: openaiCandidates, disagreed: false, disagreementNode: null };
  }
  if (!openaiTop || !geminiTop) {
    // Neither side has a top candidate, or OpenAI found nothing new —
    // Gemini's (already below-threshold/contested) result stands.
    return { finalCandidates: geminiCandidates, disagreed: false, disagreementNode: null };
  }
  if (sameCandidateKey(geminiTop, openaiTop)) {
    const bumped = { ...geminiTop, confidence: Math.max(geminiTop.confidence, openaiTop.confidence) };
    return {
      finalCandidates: dedupeCandidates([bumped, ...geminiCandidates.slice(1), ...openaiCandidates.slice(1)]),
      disagreed: false,
      disagreementNode: null,
    };
  }
  return {
    finalCandidates: dedupeCandidates([geminiTop, openaiTop, ...geminiCandidates.slice(1), ...openaiCandidates.slice(1)]),
    disagreed: true,
    disagreementNode: deepestSharedNode(candidateNodeId(geminiTop), candidateNodeId(openaiTop)),
  };
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
  const candidatesResult = await callCandidatesModel(images, catalogEntries);
  const candidatesJson = candidatesResult.ok ? candidatesResult.json : null;
  const candidatesFromCall1 = candidatesJson ? dedupeCandidates((candidatesJson.candidates || []).map(resolveCandidate)) : [];
  const catalogCandidates1 = candidatesFromCall1.filter((c) => c.entry);

  let verifyResult = null;
  let verifiedCandidates = candidatesFromCall1;
  if (catalogCandidates1.length) {
    verifyResult = await callVerifyModel(images, candidateContextFor(catalogCandidates1));
    verifiedCandidates = mergeVerify(candidatesFromCall1, verifyResult);
  }

  const geminiMissed = !candidatesResult.ok
    || (catalogCandidates1.length > 0 && !verifyCoversAllCandidates(verifyResult, catalogCandidates1));
  const contradicted = catalogCandidates1.length > 0 && detectSelfContradiction(candidatesJson, verifiedCandidates);
  const lookAlikeClose = consequentialLookAlikeClose(verifiedCandidates);
  const verifiedTop = dedupeCandidates(verifiedCandidates)[0] || null;
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

  if (escalationTriggered) {
    escalationResult = await callEscalationModel(images, catalogEntries, candidateContextFor(catalogCandidates1));
    ({ finalCandidates, disagreed, disagreementNode } = combineEscalation(finalCandidates, escalationResult));
  }

  const quality = candidatesJson?.quality
    || (escalationResult?.ok ? escalationResult.json?.quality : null)
    || { usable: true, issue: 'none' };
  const currentMonth = etParts(new Date()).month;

  const built = buildAnswer({
    candidates: finalCandidates,
    disagreed,
    disagreementNode,
    escalationTriggered,
    openaiAnswered: !!escalationResult?.ok,
    qualityUsable: !!quality.usable,
    qualityIssue: quality.issue || 'none',
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
  _test: { candidateContextFor, mergeVerify, V2_TO_V1_SLUG },
};
