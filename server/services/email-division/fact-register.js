/**
 * Email division fact register.
 *
 * Reads the UF/IFAS (and other authoritative) facts seeded into
 * knowledge_base (category 'facts', see migration
 * 20260928100000_email_division_fact_register.js) that customer-facing
 * newsletter copy is allowed to state, and flags a small, deterministic set
 * of known-false or overreaching claim shapes so the newsletter validator
 * can hard-block them before a draft is proofed or sent.
 *
 * This is a tripwire, not a proof: a false hold costs one proof review, a
 * false pass mails a wrong claim to the list. So every exemption below is
 * an ALLOWLIST of explicit denial shapes for that one claim — never "the
 * clause contains a negation word", which lets idioms ("no doubt", "no
 * joke", "never fails to", "not only") and unrelated asides clear a real
 * false claim.
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

// The words that make the termite claim false: a SECOND / repeat /
// late-summer / storm-triggered swarm (the January–May swarm "on warm days
// after rain" is the true fact and carries none of them).
const REPEAT_SWARM = '(?:second|another|again|repeat(?:ed)?|late[-\\s]?summer|post[-\\s]?storm|storm[-\\s]?(?:triggered|induced|driven)?)';
const NEGATOR = "(?:do(?:es)?\\s+not|don'?t|doesn'?t|did\\s+not|didn'?t|will\\s+not|won'?t|cannot|can'?t|never)";
const SWARM_VERB = '(?:have|throw|produce|swarm|get|trigger|stage)';
// The same idea when the modifier comes FIRST ("a second termite swarm",
// "another termite swarm"). "again" and a bare "storm" are left out here:
// they only make the claim false after the verb.
const REPEAT_MODIFIER = '(?:second|another|repeat(?:ed)?|late[-\\s]?summer|post[-\\s]?storm|storm[-\\s]?(?:triggered|induced|driven))';

// Known-false or overreaching claim shapes an AI-written newsletter draft
// must never state. `denials` lists the ONLY phrasings that exempt an
// occurrence: the rule's own correct fact stated as a denial of that claim.
const UNVERIFIED_CLAIM_RULES = [
  {
    // The September 2026 Pest Insider draft's actual error: native
    // subterranean termites do NOT have a second, storm/late-summer
    // triggered swarm (fact-no-storm-triggered-second-termite-swarm). Two
    // word orders: "... a second swarm" and "... swarm again / a second
    // time". The anchor's negative lookbehind keeps a drywood subject out:
    // both drywood species correctly document wide, near-any-month flight
    // windows, while a contrastive "Unlike drywood termites, native
    // subterranean termites have a second swarm" still anchors on — and
    // blocks — the second, non-drywood "termites".
    rule: 'termite_second_swarm',
    pattern: new RegExp(
      `\\b(?<!drywood[\\s-])termites?\\b[^.]{0,150}?\\b${REPEAT_SWARM}\\b[^.]{0,60}?\\bswarm`
      + `|\\b(?<!drywood[\\s-])termites?\\b[^.]{0,80}?\\bswarm(?:s|ed|ing)?\\s+(?:again|a\\s+second\\s+time|twice|once\\s+more)\\b`
      // modifier first: "a second termite swarm", "another subterranean
      // termite swarm" — never when the termite named is a drywood.
      + `|\\b${REPEAT_MODIFIER}\\s+(?!(?:[\\w-]+\\s+){0,2}?drywood\\b)(?:[\\w-]+\\s+){0,2}?termite\\s+swarm`,
      'i',
    ),
    denials: [
      // "termites do not have a second swarm", "termites never swarm again"
      new RegExp(`\\b${NEGATOR}\\s+${SWARM_VERB}\\b[^.,;]{0,60}?\\b(?:${REPEAT_SWARM}|a\\s+second\\s+time|twice|once\\s+more)`, 'i'),
      // "No native subterranean termites have a second swarm"
      new RegExp(`\\bno\\s+(?:[\\w-]+\\s+){0,4}?termites?\\s+${SWARM_VERB}\\b[^.,;]{0,60}?\\b${REPEAT_SWARM}`, 'i'),
      // "there is no second swarm" (never "there is no doubt ...")
      new RegExp(`\\b(?:there\\s+is|there'?s|there\\s+are)\\s+no\\s+(?:such\\s+)?${REPEAT_SWARM}\\b`, 'i'),
      // "no second termite swarm", "not a second termite swarm" — the
      // negation must sit directly on the modifier, so "no doubt a second
      // termite swarm" is still the false claim.
      new RegExp(`\\b(?:no|never)\\s+(?:such\\s+)?${REPEAT_MODIFIER}\\b`, 'i'),
      new RegExp(`\\bnot\\s+(?:a|an|any)\\s+${REPEAT_MODIFIER}\\b`, 'i'),
    ],
  },
  {
    // Large patch is "most likely to be observed from November through May
    // when temperatures are below 80°F" and "normally not observed in the
    // summer months" (fact-large-patch, UF/IFAS LH044). Only the summer and
    // above-80°F claims trip this rule: UF's own St. Augustinegrass guide
    // says large patch "occurs in warm, humid weather", so "warm weather"
    // is not a false claim and is not matched.
    rule: 'large_patch_summer_disease',
    pattern: /\b(?:brown|large)\s+patch\b[^.]{0,100}?\b(?:summer|above[-\s]?80)\b|\b(?:summer|above[-\s]?80\s*(?:°|degrees?)?)\b[^.]{0,100}?\b(?:brown|large)\s+patch\b/i,
    denials: [
      // "it is not a summer disease"
      /\b(?:is\s+not|isn'?t|are\s+not|aren'?t|it'?s\s+not|was\s+not|never)\s+(?:a\s+|an\s+)?summer\b/i,
      // "spring and fall, not in summer"
      /\bnot\s+(?:in|during)\s+(?:the\s+)?summer\b/i,
      // UF's own wording: "normally not observed in the summer months"
      /\bnot\s+(?:normally\s+|usually\s+)?(?:observed|seen|found|active)\s+(?:in|during)\s+(?:the\s+)?summer\b/i,
    ],
  },
  {
    // Continuing to vacuum after treatment is flea guidance: it stimulates
    // pupae to hatch into the treatment (fact-flea-vacuuming-after-treatment,
    // University of Kentucky ENTFACT-602). An instruction to vacuum for N
    // days or weeks is exempt only in a sentence about fleas; a NEGATED
    // instruction ("do not"/"avoid" vacuuming for N days) is never correct,
    // for fleas or anything else. Capture group 1 carries the negation.
    rule: 'non_flea_vacuum_advice',
    pattern: /\b((?:do\s*not|don'?t|avoid)\s+)?vacuum(?:ing)?\b[^.]{0,80}?\b\d+\s*(?:days?|weeks?)\b/i,
  },
  {
    // Absolute safety guarantees no label supports (AGENTS.md: no safety or
    // efficacy claims). The label's own wording is the only safe one:
    // "Do not allow people or pets on treated surfaces until the spray has
    // dried." Covers bees, pets, kids and the family spellings.
    rule: 'absolute_safety_claim',
    pattern: /\b(?:bee|pet|family|kid|child|baby)[-\s]?safe\b|\bsafe\s+for\s+(?:bees|pets?|kids?|children|babies|(?:the\s+|your\s+)?(?:whole\s+|entire\s+)?family)\b/i,
  },
];

// The sentence an occurrence sits in: from the period before the match (or
// text start) to the period after it (or text end).
function sentenceWindow(body, match) {
  const idx = match.index ?? 0;
  const end = idx + match[0].length;
  const start = body.lastIndexOf('.', idx) + 1; // 0 when no prior '.'
  const stop = body.indexOf('.', end);
  return body.slice(start, stop === -1 ? body.length : stop);
}

// Where a denial may sit: from the start of the match's own clause (the
// nearest period, comma or semicolon before it, so a leading "No native
// subterranean termites ..." counts) to the END OF THE MATCH. Nothing after
// the match is read: a trailing "..., not that anyone believes it" and a
// correct denial elsewhere in the same sentence must not clear this
// occurrence.
function denialWindow(body, match) {
  const idx = match.index ?? 0;
  const before = body.slice(0, idx);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf(','), before.lastIndexOf(';')) + 1;
  return body.slice(start, idx + match[0].length);
}

// A global clone of a rule's pattern — matchAll needs the 'g' flag, and a
// single `body.match(pattern)` only ever checks the FIRST occurrence: a
// draft repeating a rule's shape (one exempt mention, then a real one)
// would have the exempt first match wrongly clear the whole rule.
function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

// True when THIS occurrence is the rule's own correct fact (one of its
// allowlisted denial shapes, or — vacuum rule only — the affirmative
// instruction in a sentence about fleas), not the false claim.
function isExemptOccurrence(body, match, { rule, denials }) {
  if (Array.isArray(denials) && denials.length) {
    const window = denialWindow(body, match);
    if (denials.some((denial) => denial.test(window))) return true;
  }
  if (rule === 'non_flea_vacuum_advice') {
    const negated = !!match[1];
    if (!negated && /\bflea/i.test(sentenceWindow(body, match))) return true;
  }
  return false;
}

/**
 * Scan customer-facing copy for the known-false/overreaching claim shapes
 * above. Returns one { rule, excerpt } per rule that matched (never more
 * than one per rule, mirroring findHallucinatedClaims' one-per-label shape).
 * Every occurrence of a rule's pattern is checked — one exempt mention does
 * not clear a LATER, non-exempt occurrence of the same shape.
 */
function findUnverifiedClaims(text) {
  const body = String(text ?? '');
  if (!body) return [];
  const results = [];
  for (const claimRule of UNVERIFIED_CLAIM_RULES) {
    for (const match of body.matchAll(globalPattern(claimRule.pattern))) {
      if (isExemptOccurrence(body, match, claimRule)) continue;
      results.push({ rule: claimRule.rule, excerpt: match[0].trim().slice(0, 160) });
      break; // one result per rule, mirroring findHallucinatedClaims
    }
  }
  return results;
}

/**
 * The register as a prompt block for an AI writer: every active fact with
 * its quoted source text and the note on what the source does not state,
 * followed by the rule that binds the writer to it. Throws when no fact can
 * be loaded — a Pest Insider draft written without its facts is exactly the
 * ungrounded copy this register exists to stop, so the draft fails instead.
 */
async function factsPromptBlock({ limit = 40 } = {}) {
  const facts = await listFacts({ limit });
  if (!facts.length) throw new Error('fact register is empty: no verified facts to ground the draft');
  const lines = facts.map((fact) => {
    const meta = typeof fact.metadata === 'string' ? JSON.parse(fact.metadata || '{}') : (fact.metadata || {});
    return `- ${fact.title}\n  Source text: ${fact.summary}\n  What this means and what the source does NOT say: ${fact.content}\n  Source: ${meta.source_url || 'on file'}`;
  });
  return `

VERIFIED FACTS — the ONLY source for statements about when a pest is active, how a product works, how long anything takes, and what a rule requires:
${lines.join('\n')}

RULES FOR FACTS:
- State such a fact only if it is in the list above, and keep its numbers and months exactly as written there.
- If the list does not cover a claim, leave the claim out. Do not estimate, round, or supply a number from general knowledge.
- Never write a number of days, weeks or months that does not appear in the list.
- Where a fact says its source does not state something, do not state it.`;
}

module.exports = { listFacts, findUnverifiedClaims, factsPromptBlock };
