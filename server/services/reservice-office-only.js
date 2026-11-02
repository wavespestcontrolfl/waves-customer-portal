/**
 * Re-service office-only screen (step S3a of the consolidated re-service
 * report, owner 2026-11-02, GATE_RESERVICE_ASKS).
 *
 * A customer's message that is a complaint, a damage report, a billing
 * question or a no-show gripe belongs to the office, not on the customer's
 * service report. `officeOnlyReason(text)` is a conservative keyword screen:
 * it returns a short reason, or null when the text reads as an ordinary pest
 * or lawn problem. A wrong "yes" only keeps one line off the report (the
 * office still sees it); a wrong "no" would print it, so the lists lean wide.
 *
 * Pure: no DB, no clock. The report builder uses it to leave an item out of
 * the customer's report; a later step uses it to raise an office bell.
 */
'use strict';

const PLANT = '(?:grass|lawn|turf|sod|plants?|shrubs?|bushes|flowers?|trees?|hedges?|landscap\\w*|garden|palms?)';
const DAMAGE_WORD = '(?:dead|burn(?:ed|t)|scorch\\w*|killed|died|ruined|damaged?|stained?)';

// Order matters: the first match names the reason. Each entry is [reason, regex].
const SCREENS = [
  ['damage', new RegExp(
    '\\b(?:spill(?:ed|s)?|leak(?:ed|ing)?\\s+(?:onto|on|into)|damage[ds]?|damaging|stains?|stained|ruin(?:ed|s)?|scorch\\w*|bleach(?:ed)?)\\b'
    + `|\\b${DAMAGE_WORD}\\s+(?:\\w+\\s+){0,2}${PLANT}\\b`
    + `|\\b${PLANT}\\s+(?:\\w+\\s+){0,2}(?:is|are|was|were|got|has|have|looks?)?\\s*(?:dead|died|burn(?:ed|t)|scorch\\w*|killed|ruined|damaged)\\b`
    + `|\\b(?:burn(?:ed|t)|killed)\\s+(?:my|our|the)\\b`,
    'i',
  )],
  ['billing', new RegExp(
    '\\b(?:refunds?|refunded|charged|charges?|overcharg\\w*|bill(?:ed|s|ing)?|invoices?|money\\s+back|credit\\s+(?:me|us|back)|reimburs\\w*)\\b',
    'i',
  )],
  ['complaint', new RegExp(
    '\\b(?:complain\\w*|unhappy|upset|angry|mad\\s+(?:at|about)|disappoint\\w*|frustrat\\w*|furious|unacceptable|terrible|horrible|awful|ridiculous|fed\\s+up|lawyers?|attorneys?|sue|sued|suing|legal\\s+action|bbb|better\\s+business)\\b',
    'i',
  )],
  ['schedule', new RegExp(
    '\\b(?:no[-\\s]?shows?|(?:did\\s*n[o\']?t|didn[’\']?t|never|not)\\s+(?:even\\s+)?(?:show(?:ed)?(?:\\s+up)?|came|come|arrive[d]?)'
    + '|(?:no\\s*one|nobody)\\s+(?:came|showed|arrived)|never\\s+showed|late|past\\s+(?:the|our|my)\\s+(?:appointment\\s+)?window'
    + '|missed\\s+(?:the|our|my)\\s+(?:appointment|visit)|what\\s+happened|waiting\\s+all\\s+day)\\b',
    'i',
  )],
];

/**
 * @param {*} text the customer's words
 * @returns {'damage'|'complaint'|'billing'|'schedule'|null}
 */
function officeOnlyReason(text) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!value) return null;
  for (const [reason, re] of SCREENS) {
    if (re.test(value)) return reason;
  }
  return null;
}

module.exports = { officeOnlyReason };
