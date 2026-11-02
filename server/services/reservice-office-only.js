/**
 * Re-service office-only screen (step S3a of the consolidated re-service
 * report, owner 2026-11-02, GATE_RESERVICE_ASKS).
 *
 * A customer's message about US — damage we caused (a spill, a stain, a burn,
 * a broken sprinkler), money (a refund, a charge, a bill), a complaint about
 * the service, or a missed or late visit — belongs to the office, not on the
 * customer's service report. `officeOnlyReason(text)` returns a short reason,
 * or null when the text reads as the pest or lawn problem itself.
 *
 * Both mistakes cost something, so the screens aim at the message's subject,
 * not at strong words: a wrong "yes" drops the customer's own request from
 * the report that is meant to answer it ("the ants are terrible this year",
 * "chinch bug damage in the front yard", "dead spots in the lawn"); a wrong
 * "no" prints the line, where the tech's "Not about this visit" still hides
 * it. Damage counts only as a spill, a fertilizer burn, stains on a hard
 * surface, or harm to the customer's property, plants, pets or people that a
 * word points at us for (you, your tech, the spray, the last treatment ...),
 * never across a "not" and never to a pest or a weed: pests kill grass too,
 * and "the spray did not kill the ants" is the re-service's own subject. Schedule words count only with a person as
 * the subject ("the tech was late", never "I see them late at night").
 *
 * Pure: no DB, no clock. The report builder leaves an office-only item out
 * of the customer's report; a later step uses it to raise an office bell.
 */
'use strict';

// Words that point the damage at us: our people, our products, our visit ("the last treatment" too).
const OURS = '(?:you|your\\s+(?:guys?|tech\\w*|crew|team|worker|man|company|spray\\w*|treatment|products?|chemicals?|granules?|fertili[sz]er|herbicide|weed\\s*killer|pesticide|poison)|(?:the|that|this)\\s+(?:last\\s+|recent\\s+|latest\\s+|first\\s+|second\\s+)?(?:tech\\w*|spray\\w*|treatment|products?|chemicals?|granules?|fertili[sz]er|herbicide|weed\\s*killer|pesticide|poison))';
// What we can harm: the customer's property, plants, pets and people. Never a pest or a weed: "the spray killed the
// weeds" and "the spray did not kill the ants" are the treatment's result, the re-service's own subject.
const THINGS = '(?:grass|lawn|yard|turf|sod|plants?|shrubs?|bushes|flowers?|trees?|hedges?|palms?|garden|landscap\\w*|roses?|hibiscus|crotons?|sprinklers?|sprinkler\\s+heads?|irrigation|pipes?|hoses?|fences?|gates?|doors?|windows?|screens?|siding|paint|cars?|truck|driveway|patio|pavers?|deck|lanai|pool|furniture|carpets?|floors?|walls?|cushions?|sidewalk|walkway|concrete|house|mailbox|lights?|grill|dogs?|cats?|pets?|puppy|kitten|kids?|child|children|son|daughter|baby|wife|husband|family|fish|birds?|chickens?|horses?)';
const HARM = '(?:kill(?:ed|ing|s)?|damag\\w*|dead|died|dying|broke|broken|break|ruin\\w*|destroy\\w*|hurt|harm\\w*|brown(?:ed)?|yellow(?:ed)?|scratch\\w*|dent\\w*|burn(?:ed|t)|scorch\\w*|bleach\\w*|stain\\w*|sick|ill|vomit\\w*|rash\\w*)';
// A possessed or named thing: "my plants", "the sprinkler head", "our dog".
const THING = `(?:my|our|the|all\\s+(?:my|our|the)|some\\s+of\\s+(?:my|our|the))\\s+(?:\\w+\\s+)?${THINGS}`;
// Within one sentence, never across a negation: "the spray didn't hurt my dog" is not a damage report.
const NEAR = "(?:(?!\\b(?:not|never|no)\\b|n['’]t\\b)[^.?!]){0,60}?";
// A word that puts a strong feeling on US, not on the pests: "the worst service", "your tech was rude", "unhappy with
// the last visit". Never a bare "you": "the worst you have ever seen" is about the ants.
const SERVICE = '(?:you\\s+guys|waves|your\\s+(?:service|company|tech\\w*|team|crew|guys?|treatment|visit|spray\\w*)|(?:the|this|that)\\s+(?:last\\s+|recent\\s+|latest\\s+)?(?:service|company|tech\\w*|treatment|visit|crew|team))';
const FEELING = '(?:worst|unhappy|unacceptable|unprofessional|rude|furious|fed\\s+up|never\\s+again|horrible|terrible|awful|disappointed|disappointing|not\\s+(?:happy|satisfied|pleased))';
const PERSON = '(?:you|your\\s+(?:guys?|tech\\w*|crew|team|worker|man)|(?:the\\s+)?tech(?:nician)?s?|no\\s*one|nobody|anyone|anybody|someone|somebody)';
const NOT = "(?:did\\s*n[o']?t|didn['’]t|never|has\\s*n[o']?t|hasn['’]t|have\\s*n[o']?t|haven['’]t|won['’]t|will\\s+not)";

// Order matters: the first match names the reason. Each entry is [reason, regex].
const SCREENS = [
  ['damage', new RegExp([
    // A spill is our doing on a re-service; so is a fertilizer or chemical burn.
    '\\bspill(?:ed|s|ing)?\\b',
    '\\b(?:fertili[sz]er|chemical|herbicide|weed\\s*killer)\\s+burn\\b|\\bburn\\s+(?:marks?|spots?|patches?|lines?|stripes?)\\b',
    // Stains on a hard surface ("stains on the patio"), never roach stains in a cabinet.
    '\\bstain(?:s|ed)?\\s+(?:on|all\\s+over)\\s+(?:the|my|our)\\s+(?:\\w+\\s+)?(?:driveway|patio|pavers?|deck|lanai|pool|walls?|siding|house|cars?|sidewalk|walkway|concrete|floors?|carpets?|furniture|cushions?|screens?|doors?|windows?|fences?|paint)\\b',
    // "your tech broke my sprinkler head", "the treatment made my dog sick", "the spray turned my shrubs brown"
    `\\b${OURS}\\b${NEAR}\\b${HARM}\\s+${THING}\\b`,
    `\\b${OURS}\\b${NEAR}\\b${THING}\\b${NEAR}\\b${HARM}\\b`,
    // "the lawn looks burned after the last treatment", "my dog got sick after the spray"
    `\\b${THING}\\b${NEAR}\\b${HARM}\\b${NEAR}\\b(?:from|after|since|by|because\\s+of)\\s+${OURS}\\b`,
  ].join('|'), 'i')],
  ['billing', new RegExp([
    '\\b(?:refunds?|refunded|charges?|charged|charging|overcharg\\w*|invoices?|invoiced|reimburs\\w*)\\b',
    // "a bill", "my bill", "billed" (never the name "Bill said ...")
    '\\b(?:a|the|my|our|your|this|that)\\s+bill\\b|\\bbill(?:ed|ing)\\b',
    '\\bmoney\\s+back\\b|\\bcredit\\s+(?:me|us|back|my|our)\\b',
  ].join('|'), 'i')],
  ['complaint', new RegExp([
    // Words that are a complaint on their own.
    '\\b(?:complain\\w*|lawyers?|attorneys?|sue|sued|suing|legal\\s+action|bbb|better\\s+business)\\b',
    '\\bmad\\s+at\\s+(?:you|your|waves)\\b',
    // A strong feeling counts only beside a word for us, in the same sentence ("the ants are the worst they have
    // ever been" is the pest problem; "the worst service I have had" is a complaint).
    `\\b${FEELING}\\b[^.?!]{0,40}?\\b${SERVICE}\\b`,
    `\\b${SERVICE}\\b[^.?!]{0,40}?\\b${FEELING}\\b`,
    // "worst service", "terrible pest company", "awful customer service"
    `\\b${FEELING}\\s+(?:pest\\s+|customer\\s+)?(?:service|company|treatment|tech\\w*|visit|crew|team|experience)\\b`,
    '\\b(?:not|never)\\s+(?:happy|satisfied|pleased)\\s+with\\s+you\\b|\\bdisappointed\\s+(?:in|with)\\s+you\\b',
    '\\bcancel\\w*\\s+(?:my|our|the)\\s+(?:service|account|contract|plan|membership|subscription)\\b',
    '\\b(?:bad|negative|1[-\\s]?star|one[-\\s]?star)\\s+review\\b',
    '\\bwaste\\s+of\\s+(?:money|time)\\b',
  ].join('|'), 'i')],
  ['schedule', new RegExp([
    '\\bno[-\\s]?shows?\\b',
    `\\b${PERSON}\\s+${NOT}\\s+(?:even\\s+)?(?:show(?:ed|n)?(?:\\s+up)?|c[oa]me(?:\\s+(?:out|by))?|arrive[d]?|been\\s+(?:here|out|by))\\b`,
    '\\b(?:no\\s*one|nobody)\\s+(?:came|showed|arrived)\\b',
    '\\bnever\\s+showed(?:\\s+up)?\\b',
    // A person late: "you're late", "the tech was running late again"
    `\\b${PERSON}\\s*(?:'re|'s|\\s(?:is|was|were|are|be|being))\\s+(?:running\\s+|so\\s+|very\\s+|too\\s+|really\\s+)?late\\b`,
    // "why did you come so late?", "your tech showed up late" (a person arriving, never "the ants come out late")
    `\\b${PERSON}\\b[^.?!]{0,30}?\\b(?:came|come|arrived?|showed\\s+up|show\\s+up|got\\s+here|get\\s+here)\\s+(?:so\\s+|very\\s+|too\\s+|really\\s+)?late\\b`,
    '\\bpast\\s+(?:the|our|my)\\s+(?:appointment\\s+|arrival\\s+|time\\s+)?window\\b',
    '\\bmissed\\s+(?:the|our|my)\\s+(?:appointment|visit)\\b',
    // "What happened?" on its own, or about the visit — never "what happened to the grass by the pool?"
    '\\bwhat\\s+happened\\s*[?!.]*\\s*$',
    '\\bwhat\\s+happened\\s+to\\s+(?:you|the\\s+(?:tech\\w*|appointment|visit)|(?:my|our)\\s+(?:appointment|visit))\\b',
    '\\bwaiting\\s+all\\s+(?:day|morning|afternoon)\\b|\\bstill\\s+waiting\\b',
    '\\bwhere\\s+(?:are|is)\\s+(?:you|the\\s+tech\\w*|your\\s+(?:guys?|tech\\w*|crew))\\b',
  ].join('|'), 'i')],
];

/**
 * @param {*} text the customer's words
 * @returns {'damage'|'complaint'|'billing'|'schedule'|null}
 */
function officeOnlyReason(text) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!value) return null;
  // One sentence at a time, so "what happened?" at a sentence end is found and a match never spans two sentences.
  const sentences = value.split(/(?<=[.?!])\s+/);
  for (const [reason, re] of SCREENS) {
    if (sentences.some((sentence) => re.test(sentence))) return reason;
  }
  return null;
}

module.exports = { officeOnlyReason };
