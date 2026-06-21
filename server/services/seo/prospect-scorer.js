/**
 * Prospect scorer — replaces the Brain's "domain-rating only" priority with a
 * composite of RELEVANCE + LEAD-VALUE + CONTACTABILITY (DR is a tiebreaker), and
 * gates outreach-intent prospects that expose no way to reach a human.
 *
 * Why: the board was being filled with high-DR national directories and HARO
 * platforms (moz.com, clutch.co, helpareporter.com) pointed at the homepage —
 * raw DR surfaces authority, not fit. For a local home-services business the
 * best links are also referral partners (realtor/WDO/property-management vendor
 * pages), so we weight local dual-ROI above DR.
 *
 *   classifyBatch(candidates)  → LLM (FAST tier) intent/relevance/lead-value,
 *                                with a heuristic fallback when the LLM is
 *                                unavailable (offline, no key, parse error).
 *   scoreProspect(c, cls, ct)  → { score, tier, priority, gate, ... }
 *   scoreCandidates(cands, …)  → orchestrates contact-find + classify + score.
 *
 * No circular import on backlink-monitor: the link-type heuristic is duplicated
 * here (it's tiny) so backlink-monitor can require THIS module for priority.
 */

const MODELS = require('../../config/models');
const logger = require('../logger');
const { findContact } = require('./contact-finder');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ── Constants ────────────────────────────────────────────────────────────────

// Intents that require a real contact path before we'll queue an email pitch.
const OUTREACH_INTENTS = new Set(['editorial', 'resource', 'guest_post']);
// Signup/aggregator lane — no email needed (the worker signs up), so exempt.
const SIGNUP_INTENTS = new Set(['directory', 'citation', 'social']);

// The only link_types link-prospect-worker can claim. A stored prospect MUST use
// one of these or it strands in 'prospect' forever.
const CLAIMABLE_LINK_TYPES = new Set(['editorial', 'resource', 'guest_post', 'haro', 'directory', 'citation', 'social']);

// HARO-class platforms: you JOIN them, you don't cold-email them. Flagged so the
// drafter never wastes a send pitching helpareporter.com itself.
const HARO_PLATFORMS = new Set([
  'helpareporter.com', 'haro.com', 'featured.com', 'qwoted.com', 'sourcebottle.com',
  'terkel.io', 'help.featured.com', 'responsesource.com', 'pressplugs.com',
]);

const SWFL_TERMS = ['sarasota', 'bradenton', 'venice', 'manatee', 'parrish', 'palmetto', 'north port', 'northport', 'lakewood ranch', 'lakewoodranch', 'osprey', 'nokomis', 'ellenton', 'lwr', 'srq', 'swfl', 'gulf coast', 'charlotte county'];
const TRADE_TERMS = ['pest', 'exterminat', 'termite', 'mosquito', 'rodent', 'wildlife', 'lawn', 'turf', 'wdo', 'home service', 'home-service', 'realt', 'property manage', 'home inspect', 'hoa', 'pool', 'landscap', 'pressure wash'];

// Tier (1 best dual-ROI … 5 baseline) → lead-value points.
const TIER_POINTS = { 1: 100, 2: 80, 3: 55, 4: 30, 5: 15 };
const WEIGHTS = { relevance: 0.40, leadValue: 0.30, contact: 0.20, dr: 0.10 };

const WAVES_CONTEXT = `Waves Pest Control & Lawn Care — family-owned, serving SW Florida (Manatee, Sarasota, Charlotte counties: Bradenton, Sarasota, Venice, Parrish, Palmetto, North Port, Lakewood Ranch). Services: pest control, lawn care, termite, WDO (wood-destroying organism) inspections for real-estate closings, mosquito, rodent/wildlife. The highest-value backlink partners are LOCAL businesses that also refer revenue: real-estate agents/brokerages (WDO wedge), property & HOA management, home inspectors, and complementary non-competing home services. Money-page topics: general (homepage), pest, lawn, termite, wdo, mosquito, rodent.`;

// ── Link-type heuristic (standalone; mirrors backlink-monitor.classifyLinkType) ─

function classifyLinkType(domain = '', url = '') {
  const d = String(domain).toLowerCase();
  const u = String(url).toLowerCase();
  const directories = ['yelp.com', 'bbb.org', 'angi.com', 'thumbtack.com', 'yellowpages.com', 'mapquest.com', 'manta.com', 'hotfrog.com', 'homeadvisor.com', 'houzz.com', 'porch.com', 'nextdoor.com', 'expertise.com', 'threebestrated.com', 'clutch.co', 'provenexpert.com'];
  const citations = ['fpma.org', 'npma.org', 'qualitypro.org', 'pestworld.org', 'fdacs.gov'];
  const social = ['facebook.com', 'linkedin.com', 'instagram.com', 'alignable.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com'];
  if (HARO_PLATFORMS.has(d)) return 'haro';
  if (directories.some((x) => d.includes(x)) || /\/directory|\/listing|\/business/i.test(u)) return 'directory';
  if (citations.some((x) => d.includes(x))) return 'citation';
  if (social.some((x) => d.includes(x))) return 'social';
  if (/\/resources|\/partners|\/links|\/preferred|\/vendor/i.test(u)) return 'resource';
  if (/herald|tribune|patch\.com|gondolier|magazine|news|wwsb|abc7/i.test(d)) return 'editorial';
  if (/\/blog/i.test(u)) return 'editorial';
  return 'unknown';
}

// ── Heuristic classifier (LLM fallback) ───────────────────────────────────────

function heuristicClassify(candidate) {
  const domain = String(candidate.domain || '').toLowerCase();
  const url = String(candidate.source_url || candidate.target_url || '').toLowerCase();
  const blob = `${domain} ${url} ${(candidate.sample_anchors || []).join(' ')}`.toLowerCase();
  const intent = classifyLinkType(domain, url);
  const isLocal = SWFL_TERMS.some((t) => blob.includes(t));
  const tradeHit = TRADE_TERMS.some((t) => blob.includes(t));

  let relevance = 25;
  if (tradeHit) relevance = 70;
  if (intent === 'editorial') relevance = Math.max(relevance, 55);
  if (intent === 'directory' || intent === 'citation') relevance = Math.min(relevance, 35);
  if (isLocal) relevance = Math.min(100, relevance + 18);

  let tier = 0;
  if (/realt|realty|broker|property\s?manage|home\s?inspect|hoa\b/.test(blob)) tier = 1;
  else if (intent === 'editorial') tier = 2;
  else if (/chamber|sponsor|charit|nonprofit|little league|festival/.test(blob)) tier = 3;
  else if (intent === 'directory' || intent === 'citation') tier = 4;
  else if (intent === 'social') tier = 5;

  return {
    domain,
    intent_class: intent,
    relevance_0_100: relevance,
    is_local_swfl: isLocal,
    lead_value_tier: tier,
    is_haro_platform: HARO_PLATFORMS.has(domain) || intent === 'haro',
    target_topic: 'general',
    suggested_anchor: null,
    reason: 'heuristic',
  };
}

// ── LLM classifier ────────────────────────────────────────────────────────────

function parseJsonArray(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function classifyChunk(chunk, { anthropic }) {
  const list = chunk.map((c, i) => ({
    i,
    domain: c.domain,
    domain_rating: c.domain_rating ?? null,
    sample_anchors: (c.sample_anchors || []).slice(0, 3),
    links_to_competitors: c.links_to_competitors || [],
  }));

  const prompt = `${WAVES_CONTEXT}

Classify each candidate backlink source below for a LOCAL link-building program. Return ONLY a JSON array, one object per input, SAME ORDER, each:
{"i":<index>,"domain":"<domain>","intent_class":"editorial|resource|guest_post|haro|directory|citation|social|unknown","relevance_0_100":<int>,"is_local_swfl":<bool>,"lead_value_tier":<1-5 or 0>,"is_haro_platform":<bool>,"target_topic":"general|pest|lawn|termite|wdo|mosquito|rodent","suggested_anchor":"<short anchor or null>","reason":"<≤12 words>"}

Scoring guidance:
- relevance_0_100: topical/geographic fit to a SWFL pest & lawn company. A local realtor or home-services site = high; a generic national directory or unrelated tech site = low.
- lead_value_tier: 1 = local referral partner (realtor/brokerage, property/HOA management, home inspector, complementary local home service). 2 = local media/PR/editorial. 3 = civic/chamber/sponsorship. 4 = industry/national directory. 5 = social/citation baseline. 0 = none/irrelevant.
- is_haro_platform: true for HARO-style query services you JOIN (helpareporter, featured, qwoted, sourcebottle) — NOT a cold-email target.

Candidates:
${JSON.stringify(list)}`;

  const resp = await anthropic.messages.create({
    model: MODELS.FAST,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp?.content?.map((b) => b.text || '').join('') || '';
  const arr = parseJsonArray(text);
  if (!Array.isArray(arr)) throw new Error('classifier returned non-array');
  // Map back by index defensively (model may drop/reorder).
  return chunk.map((c, idx) => {
    const hit = arr.find((o) => o && (o.i === idx || String(o.domain).toLowerCase() === String(c.domain).toLowerCase()));
    if (!hit) return heuristicClassify(c);
    return {
      domain: c.domain,
      intent_class: hit.intent_class || classifyLinkType(c.domain, c.source_url),
      relevance_0_100: Math.max(0, Math.min(100, Number(hit.relevance_0_100) || 0)),
      is_local_swfl: !!hit.is_local_swfl,
      lead_value_tier: Number(hit.lead_value_tier) || 0,
      is_haro_platform: !!hit.is_haro_platform || HARO_PLATFORMS.has(String(c.domain).toLowerCase()),
      target_topic: hit.target_topic || 'general',
      suggested_anchor: hit.suggested_anchor || null,
      reason: hit.reason || 'llm',
    };
  });
}

/**
 * classifyBatch — returns one classification per candidate (same order).
 * Falls back to the heuristic for the whole batch on any LLM problem.
 */
async function classifyBatch(candidates, { anthropic, chunkSize = 25 } = {}) {
  if (!candidates.length) return [];
  let client = anthropic;
  if (!client && Anthropic && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  if (!client) {
    logger.info('[prospect-scorer] No Anthropic client — heuristic classification');
    return candidates.map(heuristicClassify);
  }

  const out = [];
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    try {
      out.push(...await classifyChunk(chunk, { anthropic: client }));
    } catch (err) {
      logger.warn(`[prospect-scorer] LLM classify failed (${err.message}) — heuristic for ${chunk.length}`);
      out.push(...chunk.map(heuristicClassify));
    }
  }
  return out;
}

// ── Scoring + gating ──────────────────────────────────────────────────────────

function contactScoreOf(contact) {
  if (!contact) return 0;
  if (contact.contact_email) return 100;
  if (contact.has_contact_path) return 60;
  return 0;
}

function tierFor(classification) {
  const t = Number(classification.lead_value_tier);
  if (t >= 1 && t <= 5) return t;
  switch (classification.intent_class) {
    case 'editorial': case 'resource': case 'guest_post': case 'haro': return 2;
    case 'directory': case 'citation': return 4;
    case 'social': return 5;
    default: return 5;
  }
}

/**
 * Contactability gate. Returns { ok, lane, reason }.
 *  - haro platforms → ok, lane 'haro_platform' (join, don't email)
 *  - signup intents (directory/citation/social) → ok, lane 'signup' (exempt)
 *  - outreach intents → require a contact path
 *  - unknown/other → require a contact path (conservative)
 */
function contactGate(classification, contact) {
  if (classification.is_haro_platform || classification.intent_class === 'haro') {
    return { ok: true, lane: 'haro_platform', reason: 'HARO platform — sign up, do not email' };
  }
  if (SIGNUP_INTENTS.has(classification.intent_class)) {
    return { ok: true, lane: 'signup', reason: null };
  }
  if (contact && contact.has_contact_path) {
    return { ok: true, lane: 'outreach', reason: null };
  }
  return { ok: false, lane: 'outreach', reason: 'no contact path found' };
}

function scoreProspect(candidate, classification, contact) {
  const relevance = Math.max(0, Math.min(100, Number(classification.relevance_0_100) || 0));
  const tier = tierFor(classification);
  const leadValue = TIER_POINTS[tier] ?? 10;
  const cScore = contactScoreOf(contact);
  const dr = Math.max(0, Math.min(100, Number(candidate.domain_rating) || 0));

  let score = WEIGHTS.relevance * relevance + WEIGHTS.leadValue * leadValue + WEIGHTS.contact * cScore + WEIGHTS.dr * dr;
  if (classification.is_local_swfl) score = Math.min(100, score + 10); // local dual-ROI is the whole point
  score = Math.round(score * 10) / 10;

  const priority = score >= 68 ? 'high' : score >= 45 ? 'medium' : 'low';
  const gate = contactGate(classification, contact);

  // The stored link_type MUST be one the worker can claim. classifyLinkType (or
  // the model) can return 'unknown'/'forum'/'comment'; persisting that as
  // link_type would strand a high-scoring prospect forever, since
  // link-prospect-worker only claims the 7 canonical types. Coerce: a passing
  // outreach target becomes 'resource' (a partner/resource link), signup → 'directory'.
  let linkType = classification.intent_class;
  if (!CLAIMABLE_LINK_TYPES.has(linkType)) linkType = gate.lane === 'signup' ? 'directory' : 'resource';

  return {
    score,
    tier,
    priority,
    intent_class: linkType,
    raw_intent_class: classification.intent_class,
    target_topic: classification.target_topic || 'general',
    suggested_anchor: classification.suggested_anchor || null,
    relevance_0_100: relevance,
    lead_value_tier: tier,
    is_local_swfl: !!classification.is_local_swfl,
    contact: contact || null,
    gate,
  };
}

// Small concurrency pool so a few hundred contact fetches don't run serially.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * scoreCandidates — classify, contact-find (only where the gate needs it), and
 * score a batch. Returns one enriched result per candidate.
 * candidate: { domain, domain_rating, spam_score, source_url, sample_anchors[], links_to_competitors[] }
 */
async function scoreCandidates(candidates, { anthropic, fetchFn, findContactFn = findContact, concurrency = 5 } = {}) {
  // NB: fetchFn is intentionally left undefined unless a test injects one, so
  // findContact falls back to its SSRF-pinned nodeFetch default. Defaulting it to
  // global fetch here would bypass the connection-level private-IP check.
  if (!candidates.length) return [];
  const classifications = await classifyBatch(candidates, { anthropic });

  // Contact-find only where it can change the gate outcome (outreach/unknown,
  // non-HARO). Signup-lane + HARO domains skip the network hop.
  const needsContact = classifications.map((cls) =>
    !cls.is_haro_platform && !SIGNUP_INTENTS.has(cls.intent_class));

  const contacts = await mapPool(candidates, concurrency, async (cand, i) => {
    if (!needsContact[i]) return null;
    try { return await findContactFn(cand.domain, { fetchFn }); }
    catch { return { domain: cand.domain, has_contact_path: false, contact_email: null, contact_url: null }; }
  });

  return candidates.map((cand, i) => {
    const scored = scoreProspect(cand, classifications[i], contacts[i]);
    return { candidate: cand, classification: classifications[i], ...scored };
  });
}

/**
 * heuristicPriority — fast, contact-agnostic, no-network priority for the
 * competitor-gap intel table (scanCompetitorGaps runs over hundreds of links;
 * it can't afford an LLM + contact fetch per row). Uses relevance + lead-value
 * + DR only. The full scored path (LLM + contact gate) runs in the harvest and
 * in create_link_prospects.
 */
function heuristicPriority(candidate) {
  const cls = heuristicClassify(candidate);
  const tier = tierFor(cls);
  const leadValue = TIER_POINTS[tier] ?? 10;
  const dr = Math.max(0, Math.min(100, Number(candidate.domain_rating) || 0));
  let s = 0.5 * cls.relevance_0_100 + 0.35 * leadValue + 0.15 * dr;
  if (cls.is_local_swfl) s += 8;
  return s >= 60 ? 'high' : s >= 38 ? 'medium' : 'low';
}

module.exports = {
  classifyBatch,
  scoreProspect,
  scoreCandidates,
  contactGate,
  classifyLinkType,
  heuristicClassify,
  heuristicPriority,
  OUTREACH_INTENTS,
  SIGNUP_INTENTS,
  CLAIMABLE_LINK_TYPES,
  HARO_PLATFORMS,
  WEIGHTS,
  _internals: { parseJsonArray, tierFor, contactScoreOf, mapPool },
};
