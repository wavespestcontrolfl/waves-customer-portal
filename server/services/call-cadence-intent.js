'use strict';

/**
 * Shared speaker-aware, negation-aware, clause-bounded cadence and recurring
 * intent helpers used by both `call-recording-processor` and
 * `call-booking-catalog`.
 */

const RECURRING_INTENT_STRONG_RE = /\b(recurring|re-?occurring|ongoing (?:service|plan|treatments?|maintenance|coverage)|year[- ]?round (?:service|plan|coverage|protection|treatments?)|keep[^.?!;]{0,40}\byear[- ]?round|(?:service|maintenance|pest|treatment) plans?|(?:a|any|your|the|what|which) plans?\b(?!\s+(?:to|this|tonight|today|tomorrow|for|later|already|next|on|that|changed?|fell|got)\b|\s+(?:sun|mon|tues?|wednes|thurs?|fri|satur)day\b)|(?<!\bpayment )(?<!\bfinanc(?:e|ing) )(?<!\binstallment )plans\b(?!\s+(?:to|this|tonight|today|tomorrow|for|later|already|next|on|that|changed?|fell|got)\b|\s+(?:sun|mon|tues?|wednes|thurs?|fri|satur)day\b)|(?<!\bpayment )packages?|memberships?)\b/i;
const RECURRING_CADENCE_RE = /\b(?:bi[- ]?)?monthly\b|\bquarterly\b|\bsemi[- ]?annual(?:ly)?\b|\btwice a year\b|\bevery (?:other )?(?:single )?(?:few |couple (?:of )?)?(?:\d+ |two |three |four |six )?(?:week|month)s?\b/gi;
const PEST_PRESSURE_BEFORE_RE = /\b(?:get(?:ting)?|got|has|(?<!\b(?:can|could|may) (?:i|we) )(?<!\b(?:do|does|did) (?:you|they) )(?<!\byou guys )(?<!\b(?:want|need|like|love|prefer)(?:ed)? to )have|had|having|been|see(?:ing|n)?|notice(?:d|ing)?|noticing|find(?:ing)?|found|spot(?:ted|ting)?|deal(?:ing)? with|show(?:s|ing)? up|come(?:s|ing)? (?:back|out of|in)|(?:was|were|used to be) (?:on|with|getting|doing)|(?:i'?m|we'?re|am|are|currently|already|still) (?:on|with|using))\b[^.?!]{0,40}$/i;
const REQUEST_VERB_RE = /\b(?:want(?:s|ed)?|need(?:s)?|prefer|sign(?:ing)?(?: me| us)? up|set(?:ting)? up|start|get started|schedule|book|interested in|looking for|put (?:me|us) on)\b/i;
const RECURRING_DECLINED_RE = /\b(?:don'?t|do not|doesn'?t|does not|isn'?t|is not|won'?t|not) (?:want|need|interested in|looking for)\b(?:(?!\b(?:want|need)\b)[^.?!;]){0,50}\b(?:recurring|plans?|packages?|memberships?|ongoing|quarterly|(?:bi[- ]?)?monthly|semi[- ]?annual(?:ly)?)|\b(?:no|without|skip(?:ping)?) (?:a |the |any )?(?:(?:service|maintenance|pest|treatment) )?(?:recurring|plans?|packages?|memberships?|quarterly|(?:bi[- ]?)?monthly|semi[- ]?annual(?:ly)?)\b|(?<!\b(?:not|than)\s)(?<!\b(?:don'?t|do not|doesn'?t|won'?t|didn'?t) (?:want|need) )\bjust (?:a |the )?one[- ]?time\b/i;
const PROGRAM_DECLINE_RE = /\b(?:recurring|plans?|packages?|memberships?|ongoing|one[- ]?time)\b/i;
const NEGATED_CADENCE_BEFORE_RE = /(?:\b(?:not|no|never|without|rather than|instead of|(?:don'?t|do not|doesn'?t|does not|isn'?t|is not|can'?t|cannot|won'?t) (?:want|need|do|offer|provide|carry|interested in)|(?:not|never) (?:interested in|looking for|into)|no longer (?:want|need|on|interested in))\s+(?:the |a |any )?|\b(?:not|no|never|(?:don'?t|do not) want)\s+(?:the |a |any )?(?:(?:bi[- ]?)?monthly|quarterly|semi[- ]?annual(?:ly)?),? (?:or|nor|and) )$/i;
const PAYMENT_CONTEXT_BEFORE_RE = /\b(?:pay(?:ing)?|billed?|billing|charged?|payments?|installments?|invoiced?)\b[^.?!]{0,15}$/i;
const OTHER_PROVIDER_CONTEXT_RE = /\b(?:with\s+(?:them|him|her|another\s+company|a\s+different\s+company|somebody\s+else|someone\s+else|terminix|orkin|truly\s+nolen|massey|aptive|home\s*team|eco\s*shield|bulwark)|other\s+company|previous\s+company|existing\s+company|already\s+(?:on\s+(?:a|their)|signed\s+up\s+(?:with|for)|have\s+(?:a\s+|an\s+)?(?:plan|program|service|company|provider|contract|monthly|quarterly|pest\s+company)))\b/i;
const PLAN_AFFIRMATION_RE = /^\s*(?:caller|customer)\s*:\s*(?:(?:um|uh|well|hmm|so|oh|ok(?:ay)?)[,.\s]+){0,3}(?:yes|yeah|yep|yup|sure|sounds good|that works|that'?s fine|let'?s do (?:that|it)|perfect|please do|sign me up|absolutely|definitely)\b(?!\s*,?\s*(?:not|no|never|don'?t)\b)/i;

const normalizeApostrophes = (s) => String(s || '').replace(/[‘’]/g, "'");

function clauseSliceBefore(text, index) {
  const raw = text.slice(Math.max(0, index - 60), index);
  const sep = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf('!'), raw.lastIndexOf('?'), raw.lastIndexOf('\n'), raw.lastIndexOf(';'));
  return sep === -1 ? raw : raw.slice(sep + 1);
}

function clauseSliceAfter(text, endIndex) {
  const raw = text.slice(endIndex, endIndex + 30);
  const m = raw.match(/[.!?\n;]/);
  return m ? raw.slice(0, m.index) : raw;
}

function serviceCadenceMatch(re, text) {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = scan.exec(text))) {
    const before = clauseSliceBefore(text, m.index);
    const after = clauseSliceAfter(text, m.index + m[0].length);
    const billingNounAfter = /^\s{0,2}(?:payments?|installments?|billing|invoices?|price|pricing|cost)\b/i.test(after);
    const otherProviderClause = OTHER_PROVIDER_CONTEXT_RE.test(`${before} ${after}`);
    if (!billingNounAfter && !otherProviderClause && !NEGATED_CADENCE_BEFORE_RE.test(before) && !PAYMENT_CONTEXT_BEFORE_RE.test(before)) {
      const pressure = before.match(PEST_PRESSURE_BEFORE_RE);
      if (!pressure || REQUEST_VERB_RE.test(before.slice(pressure.index))) return true;
    }
    if (scan.lastIndex === m.index) scan.lastIndex++;
  }
  return false;
}

function speakerTurns(transcription) {
  const lines = String(transcription || '').split('\n');
  const turns = [];
  for (const line of lines) {
    const label = line.match(/^\s*([A-Za-z][A-Za-z0-9 ]{0,20}?)\s*:/);
    if (label) {
      const rawLabel = label[1].trim();
      turns.push({ speaker: /^(caller|customer)$/i.test(rawLabel) ? 'caller' : 'other', label: rawLabel, text: line });
    } else if (turns.length) {
      turns[turns.length - 1].text += `\n${line}`;
    }
  }
  return turns;
}

function callerOnlyText(transcription) {
  const turns = speakerTurns(transcription);
  if (!turns.length) return String(transcription || '');
  return turns.filter((t) => t.speaker === 'caller').map((t) => t.text).join('\n');
}

function nonNegatedMatch(re, text) {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = scan.exec(text))) {
    const before = clauseSliceBefore(text, m.index);
    if (!NEGATED_CADENCE_BEFORE_RE.test(before)) return true;
    if (scan.lastIndex === m.index) scan.lastIndex++;
  }
  return false;
}

function acceptedPlanOffer(turns, afterIndex = -1) {
  for (let i = Math.max(0, afterIndex + 1); i + 1 < turns.length; i++) {
    if (turns[i].speaker !== 'other' || turns[i + 1].speaker !== 'caller') continue;
    const offer = turns[i].text;
    if ((nonNegatedMatch(RECURRING_INTENT_STRONG_RE, offer) || serviceCadenceMatch(RECURRING_CADENCE_RE, offer))
      && PLAN_AFFIRMATION_RE.test(turns[i + 1].text)) {
      return { text: offer, index: i };
    }
  }
  return null;
}

function postDeclineRecurringOffer(turns, callerText, decline) {
  const afterDecline = callerText.slice(decline.index + decline[0].length);
  const declineTurnIdx = turns.reduce(
    (acc, t, i) => (t.speaker === 'caller' && RECURRING_DECLINED_RE.test(t.text) ? i : acc), -1,
  );
  const postOffer = acceptedPlanOffer(turns, declineTurnIdx);
  if (postOffer || nonNegatedMatch(RECURRING_INTENT_STRONG_RE, afterDecline)
    || serviceCadenceMatch(RECURRING_CADENCE_RE, afterDecline)) {
    return postOffer;
  }
  return false;
}

function recurringIntentEvidence(transcription) {
  const normalized = normalizeApostrophes(transcription);
  const turns = speakerTurns(normalized);
  const callerText = callerOnlyText(normalized);
  const decline = callerText.match(RECURRING_DECLINED_RE);
  let postDeclineOffer = null;
  if (decline && PROGRAM_DECLINE_RE.test(decline[0])) {
    postDeclineOffer = postDeclineRecurringOffer(turns, callerText, decline);
    if (postDeclineOffer === false) return null;
  }
  const callerVoiced = nonNegatedMatch(RECURRING_INTENT_STRONG_RE, callerText)
    || serviceCadenceMatch(RECURRING_CADENCE_RE, callerText);
  const acceptedOffer = postDeclineOffer || (callerVoiced ? null : acceptedPlanOffer(turns, -1));
  if (!callerVoiced && !acceptedOffer) return null;
  return { callerText, acceptedOffer };
}

module.exports = {
  RECURRING_INTENT_STRONG_RE,
  RECURRING_CADENCE_RE,
  PEST_PRESSURE_BEFORE_RE,
  REQUEST_VERB_RE,
  RECURRING_DECLINED_RE,
  PROGRAM_DECLINE_RE,
  NEGATED_CADENCE_BEFORE_RE,
  PAYMENT_CONTEXT_BEFORE_RE,
  OTHER_PROVIDER_CONTEXT_RE,
  PLAN_AFFIRMATION_RE,
  normalizeApostrophes,
  serviceCadenceMatch,
  speakerTurns,
  callerOnlyText,
  nonNegatedMatch,
  acceptedPlanOffer,
  recurringIntentEvidence,
};
