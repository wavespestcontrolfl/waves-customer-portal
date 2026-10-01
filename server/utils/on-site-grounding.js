'use strict';

// Transcript check for the on-site contact consent inputs (owner ruling
// 2026-09-30 "on-site person is the contact point"). Shared by the call
// processor (applied where a call's secondary contacts are resolved) and the
// extraction replay (flatView with a transcript), so both judge grounding the
// same way.
//
// The flags (wants_appointment_texts, on_site) are model-judged and a
// schema-valid V2 response may omit evidence[] entirely, so a hallucinated
// true/true pair must not stamp consent or fire an opt-in text. The function
// returns a COPY of the contact with each flag forced false unless its pinned
// quote (V2 evidence[], speaker 'caller' — see extraction-compat) sits word for
// word inside a CALLER turn of the speaker-labeled transcript. Turn parsing and
// the short-quote rule are the reschedule applier's: a quote under three words
// must be the whole turn. An unlabeled transcript fails closed.

// A bare affirmation ("Yeah.", "Yes", "Okay", "Sure") proves nothing on its
// own: it only counts when the IMMEDIATELY preceding agent turn asked about
// THAT field, so a stray "Yeah." after "What's the zip code?" cannot ground
// consent. Substantive quotes (at least one content word) keep the plain
// caller-turn rule.
// A quote made ONLY of these words (any length) is a generic affirmation and
// takes the prompt-bound path: "Yes, that's correct" after "is the name
// spelled S-A-M?" must not ground consent. A quote with at least one content
// word outside this set is substantive.
const AFFIRMATIVE_OR_FILLER_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'fine', 'correct', 'right', 'thats', 'that', 'is', 'it',
  'works', 'sounds', 'good', 'great', 'perfect', 'please', 'absolutely', 'definitely', 'of', 'course',
  'i', 'we', 'he', 'she', 'they', 'do', 'does', 'will', 'can', 'agree', 'thanks', 'thank', 'you',
  'um', 'uh', 'so', 'well', 'alright', 'all', 'exactly', 'huh', 'mm', 'hmm', 'mhm', 'would', 'be',
]);

// Phrase-level, not token-level: "Are there termites?" must not ask about
// presence and "Did you get my message?" must not ask about appointment texts.
// Texts additionally need a recipient reference in the SAME agent turn.
// "is/are there" is deliberately NOT a presence phrase ("Are there termites?").
const PROMPT_PATTERNS = {
  wants_appointment_texts: /\b(text(s|ing)? (him|her|them|you|his|your|their)|(get|send|receive)s? (a |the )?(text|texts|reminder|reminders|tracking link)|(appointment |visit )?(reminder|reminders)|on (the|his|her|their|our) way|tracking link|notifications?)\b/i,
  on_site: /\b((?:be|will be|is going to be|he's|she's|they're|he'll be|she'll be|they'll be) (?:there|home)|(?:be|is|are|he's|she's|they're|will be|is going to be) (?:at the (?:house|property|home|address)|on[- ]site|home)|meet (?:the|our|your) (?:tech|technician|inspector)|lives? (?:there|at the (?:house|property))|living there|present (?:at|for)|on[- ]site)\b/i,
};
// Subject pronouns count too: "Should he get appointment reminders?".
const RECIPIENT_REFERENCE = /\b(him|her|them|his|your|their|you|cell|phone|number|name|he|she|they|he'll|she'll|they'll|hes|shes)\b/i;
const promptAsks = (field, agentText) => PROMPT_PATTERNS[field].test(agentText)
  && (field !== 'wants_appointment_texts' || RECIPIENT_REFERENCE.test(agentText));

// Negation / refusal screen, applied to the NORMALIZED quote (lowercase,
// apostrophes dropped, punctuation to spaces): "don't send him appointment
// texts" and "he will not be at the house" are refusals, never grounding.
// The common affirmative idioms are stripped first ("no problem, text him").
const AFFIRMATIVE_IDIOMS = /\b(no problem|not a problem|no worries|no trouble)\b/g;
const NEGATION = /\b(no|nope|not|dont|do not|wont|will not|never|isnt|arent|cant|cannot|nobody|none|rather not|stop|doesnt|didnt|shouldnt|wouldnt|couldnt|hasnt|havent|wasnt|werent|mustnt|neednt)\b/;
// A short affirmation must itself be affirmative.
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|okay|ok|correct|right|that works|sounds good|please)\b/;

function normalizeQuote(quote) {
  return String(quote).toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
const isNegated = (normalized) => NEGATION.test(normalized.replace(AFFIRMATIVE_IDIOMS, ' '));

function verifyOnSiteGrounding(contact, transcript) {
  if (!contact || typeof contact !== 'object') return contact;
  const { parseTurns, turnsHolding } = require('../services/call-reschedule-agreement');
  const turns = parseTurns(transcript);
  // Generic = under 3 words (a lone "Tuesday." proves nothing either), or made
  // only of affirmative/filler words at ANY length.
  const isGenericAffirmation = (normalized) => {
    const words = normalized.split(' ').filter(Boolean);
    return words.length < 3 || words.every((w) => AFFIRMATIVE_OR_FILLER_WORDS.has(w));
  };
  // The agent turn right before this caller turn (empty turns skipped).
  const promptingAgentTurn = (turn) => {
    for (let i = turns.indexOf(turn) - 1; i >= 0; i -= 1) {
      if (!turns[i].ns) continue;
      return turns[i].agent ? turns[i] : null;
    }
    return null;
  };
  const verified = (field, flag, quote) => {
    if (flag !== true || !turns || typeof quote !== 'string' || !quote.trim()) return false;
    const normalized = normalizeQuote(quote);
    if (!normalized || isNegated(normalized)) return false;
    const holding = turnsHolding(turns, quote, 'caller');
    if (!holding.length) return false;
    if (!isGenericAffirmation(normalized)) return true;
    if (!AFFIRMATIVE.test(normalized)) return false;
    return holding.some((turn) => {
      const prompt = promptingAgentTurn(turn);
      return !!prompt && promptAsks(field, prompt.raw);
    });
  };
  return {
    ...contact,
    wants_appointment_texts: verified('wants_appointment_texts', contact.wants_appointment_texts, contact.wants_appointment_texts_quote),
    on_site: verified('on_site', contact.on_site, contact.on_site_quote),
  };
}

module.exports = { verifyOnSiteGrounding };
