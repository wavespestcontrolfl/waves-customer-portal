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
 * it. Damage words count only beside a spill/stain/burn word or a word that
 * points at us (you, your tech, the spray, the treatment, the granules ...),
 * because pests kill grass too. Schedule words count only with a person as
 * the subject ("the tech was late", never "I see them late at night").
 *
 * Pure: no DB, no clock. The report builder leaves an office-only item out
 * of the customer's report; a later step uses it to raise an office bell.
 */
'use strict';

// Words that point the damage at us: our people, our products, our visit.
const OURS = '(?:you|your\\s+(?:guys?|tech\\w*|crew|team|worker|man|company|spray\\w*|treatment|products?|chemicals?|granules?|fertili[sz]er|herbicide|weed\\s*killer|pesticide|poison)|(?:the|that)\\s+(?:tech\\w*|spray\\w*|treatment|products?|chemicals?|granules?|fertili[sz]er|herbicide|weed\\s*killer|pesticide|poison))';
const HARM = '(?:kill(?:ed|ing|s)?|damag\\w*|dead|died|dying|broke|broken|break|ruin\\w*|destroy\\w*|hurt|harm\\w*|brown(?:ed)?|yellow(?:ed)?|scratch\\w*|dent\\w*)';
// Within one sentence.
const NEAR = '[^.?!]{0,60}?';
const PERSON = '(?:you|your\\s+(?:guys?|tech\\w*|crew|team|worker|man)|(?:the\\s+)?tech(?:nician)?s?|no\\s*one|nobody|anyone|anybody|someone|somebody)';
const NOT = "(?:did\\s*n[o']?t|didn['’]t|never|has\\s*n[o']?t|hasn['’]t|have\\s*n[o']?t|haven['’]t|won['’]t|will\\s+not)";

// Order matters: the first match names the reason. Each entry is [reason, regex].
const SCREENS = [
  ['damage', new RegExp([
    // A spill, a stain, bleaching, scorching or a burned lawn is our doing on a re-service. Never a bare "burns" or
    // "burning": fire ant stings burn.
    '\\b(?:spill(?:ed|s|ing)?|stain(?:s|ed|ing)?|bleach(?:ed|ing)?|scorch\\w*|burn(?:ed|t))\\b',
    '\\bburn\\s+(?:marks?|spots?|patches?|lines?|stripes?)\\b|\\b(?:fertili[sz]er|chemical|herbicide)\\s+burn\\b',
    // "your tech broke my sprinkler head", "the spray turned my shrubs brown"
    `\\b${OURS}\\b${NEAR}\\b${HARM}\\b`,
    // "dead spots after the treatment", "brown patches from your fertilizer"
    `\\b${HARM}\\b${NEAR}\\b(?:from|after|since|by|because\\s+of)\\s+${OURS}\\b`,
  ].join('|'), 'i')],
  ['billing', new RegExp([
    '\\b(?:refunds?|refunded|charges?|charged|charging|overcharg\\w*|invoices?|invoiced|reimburs\\w*)\\b',
    // "a bill", "my bill", "billed" (never the name "Bill said ...")
    '\\b(?:a|the|my|our|your|this|that)\\s+bill\\b|\\bbill(?:ed|ing)\\b',
    '\\bmoney\\s+back\\b|\\bcredit\\s+(?:me|us|back|my|our)\\b',
  ].join('|'), 'i')],
  ['complaint', new RegExp([
    '\\b(?:complain\\w*|unhappy|unacceptable|unprofessional|rude|furious|fed\\s+up|worst|never\\s+again)\\b',
    '\\b(?:lawyers?|attorneys?|sue|sued|suing|legal\\s+action|bbb|better\\s+business)\\b',
    '\\bmad\\s+at\\s+(?:you|your|waves)\\b',
    '\\b(?:not|never)\\s+(?:happy|satisfied|pleased)\\s+with\\s+(?:you|your|the\\s+(?:service|tech\\w*|treatment|company|visit))\\b',
    '\\bdisappointed\\s+(?:in|with)\\s+(?:you|your|the\\s+(?:service|tech\\w*|treatment|company|visit))\\b',
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
