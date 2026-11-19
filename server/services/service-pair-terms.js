/**
 * The pest + lawn pair vocabulary, in one place for its three readers:
 *  - sms-service-intent.js reads a reply that IS the pair ("pest and lawn",
 *    "Lawn fertilization and pest control") as one request for both services
 *    ('pest_lawn', owner 2026-11-19 "a").
 *  - lead-intake.js and estimate-clarify-asks.js drop a known service tail from
 *    a captured street line ("123 Main St, pest and lawn"). A pair the
 *    classifier reads is the whole tail, so no half of it stays on the line.
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

// A known-service tail on a captured address: an optional cadence, then the
// pair or one service ("123 Main St, pest control", "…, quarterly pest and lawn").
const TAIL_CADENCE = '(?:quarterly\\s+|monthly\\s+|recurring\\s+|one[-\\s]?time\\s+)?';
const TAIL_SERVICE = '(?:pest|lawn|mosquito(?:es)?|termites?|bed\\s?bugs?|fleas?|ticks?|rodents?|mice|rats?|ants?|roach(?:es)?|wasps?|spiders?)(?:\\s+(?:control|care|service|treatment|program|removal))?';
const SERVICE_TAIL_RE = new RegExp(`[,\\s]+(${TAIL_CADENCE}(?:${SERVICE_PAIR_PATTERN}|${TAIL_SERVICE}))\\s*$`, 'i');

module.exports = { SERVICE_PAIR_PATTERN, SERVICE_TAIL_RE };
