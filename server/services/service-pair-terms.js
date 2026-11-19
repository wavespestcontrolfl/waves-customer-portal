/**
 * The pest + lawn pair vocabulary, in one place for its two readers:
 *  - sms-service-intent.js reads a reply that IS a pair request ("pest and
 *    lawn", "Both pest and lawn, like on the form") as one request for both
 *    services ('pest_lawn', owner 2026-11-19 "a").
 *  - lead-intake.js drops a known service tail from a street line captured
 *    from the same reply ("100 Palm Ave, pest and lawn services").
 * Both read the text through the same normalization (normalizePairText), so
 * the street line loses exactly the pair request the classifier reads,
 * whatever plain punctuation the customer typed around or inside it
 * ("pest-control and lawn care", `"pest and lawn"`).
 * estimate-clarify-asks.js keeps its own tail pattern: there a tail is the
 * service answer itself, with no classifier.
 *
 * No dependencies, so a test that mocks sms-service-intent still gets the real
 * address strip. The patterns read normalized text (lowercase, one space
 * between words), so each separator has one way to match and matching stays
 * linear in the length of the text.
 */

const PEST_SERVICE = 'pests?(?:\\s+control)?';
const LAWN_SERVICE = '(?:lawn(?:\\s+(?:care|fertilization|treatments?|maintenance|service))?|fertilization)';
const PAIR_JOIN = '(?:\\s+(?:and|plus)\\s+|\\s*[&+/]\\s*)';
const SERVICE_PAIR_PATTERN = `(?:${PEST_SERVICE}${PAIR_JOIN}${LAWN_SERVICE}|${LAWN_SERVICE}${PAIR_JOIN}${PEST_SERVICE})`;

// The words a reply may put around the pair: polite filler and a form
// reference ("Both pest and lawn", "pest and lawn services, like on the
// form"). At most 3 come before the pair and 4 after it, so each try of the
// address tail stays short.
const PAIR_LEAD = '(?:(?:residential|both|just|i[\'’]d\\s+like|i\\s+would\\s+like|i\\s+want|i\\s+need|need|want|looking\\s+for|interested\\s+in)\\s+){0,3}';
const PAIR_FORM = '(?:as\\s+per|per|like\\s+on|like|on|from)\\s+(?:the\\s+|my\\s+)?form(?:\\s+i\\s+(?:filled(?:\\s+(?:out|in))?|sent|submitted))?';
const PAIR_TRAIL = `(?:\\s+(?:services?|please|pls|thanks|thank\\s+you|both|${PAIR_FORM})){0,4}`;
const PAIR_REQUEST_PATTERN = `${PAIR_LEAD}${SERVICE_PAIR_PATTERN}${PAIR_TRAIL}`;

// Plain punctuation: each run of it, with the spaces, reads as one space (the
// customer's commas, quotes, brackets and dashes). A "?", an emoji, an
// apostrophe or a word in another script stays, so such a reply is no
// fast-path pair request.
const PLAIN_PUNCT = '\\s.,!;:"“”()*~…–—\\-';
const PLAIN_PUNCT_RUN_RE = new RegExp(`[${PLAIN_PUNCT}]+`, 'g');
const PLAIN_PUNCT_CHAR_RE = new RegExp(`[${PLAIN_PUNCT}]`);
const TRAILING_PUNCT_RE = new RegExp(`(?<![${PLAIN_PUNCT}])[${PLAIN_PUNCT}]+$`);
const normalizePairText = (lower) => lower.replace(PLAIN_PUNCT_RUN_RE, ' ').trim();

// The same normalization, lowercased, with each normalized character's index
// in the raw text, so a match in normalized text cuts the raw text in place.
function normalizeWithIndex(raw) {
  let text = '';
  const at = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (PLAIN_PUNCT_CHAR_RE.test(raw[i])) {
      if (text && !text.endsWith(' ')) {
        text += ' ';
        at.push(i);
      }
    } else {
      const lower = raw[i].toLowerCase();
      text += lower;
      for (let k = 0; k < lower.length; k += 1) at.push(i);
    }
  }
  return { text: text.trimEnd(), at };
}

// A known-service tail ends a captured street line: an optional cadence, then
// a pair request or one service ("123 Main St, pest control", "…, quarterly
// pest and lawn services"). It starts after a separator, never at the start.
const TAIL_CADENCE = '(?:quarterly\\s+|monthly\\s+|recurring\\s+|one[-\\s]?time\\s+)?';
const TAIL_SERVICE = '(?:pest|lawn|mosquito(?:es)?|termites?|bed\\s?bugs?|fleas?|ticks?|rodents?|mice|rats?|ants?|roach(?:es)?|wasps?|spiders?)(?:\\s+(?:control|care|service|treatment|program|removal))?';
const SERVICE_TAIL_RE = new RegExp(` ${TAIL_CADENCE}(?:${PAIR_REQUEST_PATTERN}|${TAIL_SERVICE})$`);

// Where that tail starts in the raw text (its first character), or -1.
function serviceTailIndex(raw) {
  const { text, at } = normalizeWithIndex(raw);
  const match = text.match(SERVICE_TAIL_RE);
  return match ? at[match.index + 1] : -1;
}

// Drops every known service tail from a captured street line ("…, quarterly
// pest control, mosquito"), with the punctuation before it. The classifier
// reads the full reply on its own. The text is normalized once; each pass
// reads the normalized text up to the tail the pass before it found. Lead
// intake strips a street line of 160 characters at most.
function stripServiceTail(address) {
  const raw = String(address || '').trim();
  const { text, at } = normalizeWithIndex(raw);
  let cut = raw.length;
  let match = text.match(SERVICE_TAIL_RE);
  while (match) {
    cut = at[match.index + 1];
    match = text.slice(0, match.index).match(SERVICE_TAIL_RE);
  }
  return raw.slice(0, cut).replace(TRAILING_PUNCT_RE, '');
}

// Service-introducing prose ends a captured street line at its first
// connector word ("123 Main St for ants, they're everywhere"). A known service
// tail at the end of the clause is found first and kept whole, so the
// connector words inside a pair request ("I want pest and lawn", "…, pest and
// lawn please") do not cut it. When the line is cut before the tail, the tail
// goes with the cut. The lookbehind starts a match only where a run of spaces
// begins: the split cuts where main's pattern did, but a long run of spaces
// is tried once (25,600 spaces took 1.5 s, now under 1 ms).
const CONNECTOR_RE = /(?<!\s)\s+(?:for|about|regarding|because|since|need|want|please|thanks)\b/i;
function cutAddressClause(clause) {
  const at = serviceTailIndex(clause);
  const head = at > 0 ? clause.slice(0, at) : clause;
  const cut = head.split(CONNECTOR_RE)[0];
  return (at > 0 && cut === head ? clause : cut).trim();
}

module.exports = { PAIR_REQUEST_PATTERN, normalizePairText, stripServiceTail, cutAddressClause };
