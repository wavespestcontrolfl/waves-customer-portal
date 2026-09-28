/**
 * Email division fact register.
 *
 * Reads the UF/IFAS (and other authoritative) facts seeded into
 * knowledge_base (category 'facts', see migration
 * 20260928050000_email_division_fact_register.js) that customer-facing
 * newsletter copy is allowed to state, and flags a small, deterministic set
 * of known-false or overreaching claim shapes so the newsletter validator
 * can hard-block them before a draft is proofed or sent.
 */

const db = require('../../models/db');

const CATEGORY = 'facts';

/**
 * List active facts, optionally filtered to any of the given tags.
 * `tags` may be a single string or an array; omitted/empty returns every
 * active fact (bounded by `limit`).
 */
async function listFacts({ tags, limit = 50 } = {}) {
  const rows = await db('knowledge_base')
    .where({ category: CATEGORY, active: true })
    .orderBy('title', 'asc');

  const wanted = Array.isArray(tags) ? tags : (tags ? [tags] : null);
  const filtered = (wanted && wanted.length)
    ? rows.filter((r) => Array.isArray(r.tags) && r.tags.some((t) => wanted.includes(t)))
    : rows;

  return filtered.slice(0, limit);
}

// Known-false or overreaching claim shapes an AI-written newsletter draft
// must never state. Each is deliberately narrow (matched against the
// correct, verified phrasing in the fact register itself — see the
// migration above — to confirm no rule here false-positives on citing a
// real fact correctly).
const UNVERIFIED_CLAIM_RULES = [
  {
    // The exact false claim the September 2026 Pest Insider draft made:
    // native subterranean termites do NOT have a second, storm/late-summer
    // triggered swarm (see fact-no-storm-triggered-second-termite-swarm). A
    // negated match ("termites do NOT swarm again after storms") is that
    // fact stated correctly, not the false claim — negatable exempts it.
    rule: 'termite_second_swarm',
    pattern: /\btermites?\b[^.]{0,150}?\b(?:second|another|again|repeat(?:ed)?|late[-\s]?summer|post[-\s]?storm|storm[-\s]?(?:triggered|induced|driven)?)\b[^.]{0,60}?\bswarm/i,
    negatable: true,
  },
  {
    // Large/brown patch is a spring-and-fall, cool/humid-weather disease —
    // never a summer or above-80°F one (fact-st-augustinegrass-care). A
    // NEGATED claim ("it is NOT a summer disease") is the correct fact
    // stated correctly — findUnverifiedClaims below drops any match whose
    // span carries a negation word, so only the asserted-true claim blocks.
    rule: 'large_patch_summer_disease',
    pattern: /\b(?:brown|large)\s+patch\b[^.]{0,100}?\b(?:summer|above[-\s]?80|hot\s+weather|warm\s+weather|high\s+temperatures?)\b|\b(?:summer|above[-\s]?80\s*(?:°|degrees?)?|hot\s+weather|high\s+temperatures?)\b[^.]{0,100}?\b(?:brown|large)\s+patch\b/i,
    negatable: true,
  },
  {
    // "Vacuum daily for 14 days" is flea-specific (pupae hatch into the
    // residual) — fact-flea-vacuuming-14-days. Two distinct wrong shapes:
    // (a) the AFFIRMATIVE instruction ("vacuum ... for N days") generalized
    // to a non-flea pest — findUnverifiedClaims exempts this ONE shape when
    // "flea" is nearby, since that's the actual correct guidance; (b) a
    // NEGATED instruction ("do not"/"avoid" vacuuming for N days), which is
    // never correct — no fact in the register recommends avoiding
    // vacuuming, for fleas or anything else, so this is flagged regardless
    // of context. Capture group 1 carries the negation phrase (or
    // undefined) so findUnverifiedClaims can tell the two apart.
    rule: 'non_flea_vacuum_advice',
    pattern: /\b((?:do\s*not|don'?t|avoid)\s+)?vacuum(?:ing)?\b[^.]{0,80}?\b\d+\s*(?:days?|weeks?)\b/i,
  },
  {
    // Absolute safety guarantees no label supports — mirrors the existing
    // pet/child-safety block in newsletter-validator.js, extended to bees.
    rule: 'absolute_safety_claim',
    pattern: /\b(?:bee[-\s]?safe|safe\s+for\s+bees|pet[-\s]?safe|safe\s+for\s+pets?)\b/i,
  },
];

// A "negatable" rule's own correct fact is stated as a denial (e.g. "no
// second swarm", "not a summer disease") — a match carrying one of these
// words is that denial stated correctly, not the false claim.
const NEGATION_RE = /\b(?:not|isn'?t|is\s+not|never|no)\b/i;

function nearbyWindow(body, match, radius) {
  const idx = match.index ?? 0;
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + match[0].length + radius);
  return body.slice(start, end);
}

/**
 * Scan customer-facing copy for the known-false/overreaching claim shapes
 * above. Returns one { rule, excerpt } per rule that matched (never more
 * than one per rule, mirroring findHallucinatedClaims' one-per-label shape).
 */
function findUnverifiedClaims(text) {
  const body = String(text ?? '');
  if (!body) return [];
  const results = [];
  for (const { rule, pattern, negatable } of UNVERIFIED_CLAIM_RULES) {
    const match = body.match(pattern);
    if (!match) continue;
    if (negatable && NEGATION_RE.test(match[0])) continue; // correctly denies the false claim
    if (rule === 'non_flea_vacuum_advice') {
      const negated = !!match[1];
      if (!negated && /\bflea/i.test(nearbyWindow(body, match, 200))) continue; // correct flea guidance
      // A negated instruction ("do not"/"avoid" vacuuming for N days) is
      // never correct — flagged regardless of flea context.
    }
    results.push({ rule, excerpt: match[0].trim().slice(0, 160) });
  }
  return results;
}

module.exports = { listFacts, findUnverifiedClaims };
