/**
 * The pest + lawn pair vocabulary, in one place for its three readers:
 *  - sms-service-intent.js reads a reply that IS a pair request ("pest and
 *    lawn", "Both pest and lawn, like on the form") as one request for both
 *    services ('pest_lawn', owner 2026-11-19 "a").
 *  - lead-intake.js and estimate-clarify-asks.js drop a known service tail from
 *    a captured street line ("123 Main St, pest and lawn services"). A pair
 *    request the classifier reads is one whole tail, with the words around the
 *    pair, so no part of it stays on the street line.
 *
 * No dependencies, so a test that mocks sms-service-intent still gets the real
 * address strip. Each separator has one way to match (a comma takes the spaces
 * around it, and "and" takes none of them), so no two parts of a pattern can
 * take the same characters: matching stays linear on long text.
 */

const PEST_SERVICE = 'pests?(?:\\s+control)?';
const LAWN_SERVICE = '(?:lawn(?:\\s+(?:care|fertilization|treatments?|maintenance|service))?|fertilization)';
const PAIR_JOIN = '(?:(?:\\s*,\\s*|\\s+)(?:and|plus)\\s+|\\s*[&+/]\\s*)';
const SERVICE_PAIR_PATTERN = `(?:${PEST_SERVICE}${PAIR_JOIN}${LAWN_SERVICE}|${LAWN_SERVICE}${PAIR_JOIN}${PEST_SERVICE})`;

// The words a reply may put around the pair: polite filler and a form
// reference ("Both pest and lawn", "pest and lawn services, like on the
// form"), each after a comma or spaces. At most 3 come before the pair and 4
// after it, so each try of the address tail stays short and the strip stays
// linear in the length of the text.
const WORD_SEP = '(?:\\s*,\\s*|\\s+)';
const PAIR_LEAD = `(?:(?:residential|both|just|i['’]d\\s+like|i\\s+would\\s+like|i\\s+want|i\\s+need|need|want|looking\\s+for|interested\\s+in)${WORD_SEP}){0,3}`;
const PAIR_FORM = '(?:as\\s+per|per|like\\s+on|like|on|from)\\s+(?:the\\s+|my\\s+)?form(?:\\s+i\\s+(?:filled(?:\\s+(?:out|in))?|sent|submitted))?';
const PAIR_TRAIL = `(?:${WORD_SEP}(?:services?|please|pls|thanks|thank\\s+you|both|${PAIR_FORM})){0,4}`;
const PAIR_REQUEST_PATTERN = `${PAIR_LEAD}${SERVICE_PAIR_PATTERN}${PAIR_TRAIL}`;

// A known-service tail on a captured address: an optional cadence, then a pair
// request or one service ("123 Main St, pest control", "…, quarterly pest and
// lawn services"). The lookbehind starts a match only where a run of
// separators begins, so a long run of commas or spaces is tried once, not
// from each of its characters.
const TAIL_CADENCE = '(?:quarterly\\s+|monthly\\s+|recurring\\s+|one[-\\s]?time\\s+)?';
const TAIL_SERVICE = '(?:pest|lawn|mosquito(?:es)?|termites?|bed\\s?bugs?|fleas?|ticks?|rodents?|mice|rats?|ants?|roach(?:es)?|wasps?|spiders?)(?:\\s+(?:control|care|service|treatment|program|removal))?';
const SERVICE_TAIL_RE = new RegExp(`(?<![,\\s])[,\\s]+(${TAIL_CADENCE}(?:${PAIR_REQUEST_PATTERN}|${TAIL_SERVICE}))\\s*$`, 'i');

module.exports = { PAIR_REQUEST_PATTERN, SERVICE_TAIL_RE };
