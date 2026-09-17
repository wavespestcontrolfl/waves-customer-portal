/**
 * Recognize callback commitment candidates, without deciding whether consent,
 * a refusal or a hedge makes them permissible. All spans are half-open UTF-16
 * offsets into the supplied spoken string, including an inherited actor that
 * can precede the candidate source. No transcript, tool or policy dependencies.
 */

const TEAM_PROMISERS = Object.freeze(['I', 'we', 'the office', 'our office', 'the team', 'our team', 'a member of our team', 'a team member', 'a Waves team member', 'someone', 'someone from the office', 'someone from our office', 'somebody', 'one of us', 'a technician', 'the technician', 'our technician', 'our tech', 'the tech', 'a tech', 'dispatch', 'waves']);
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo';
// Shared actor/action vocabulary; sibling timing and consent checks use the
// same contact nouns rather than independently expanding the grammar.
const CALLBACK_VERB = '(?:call|phone|ring|reach(?: out to)?|contact|get in touch with|follow up with|get back to|text|email)';
const CALLBACK_VERB_ING = '(?:calling|phoning|ringing|reaching(?: out to)?|contacting|getting in touch with|following up with|getting back to|texting|emailing)';
const CALLBACK_LIGHT_VERB = '(?:give|send|place|make|shoot|drop|leave|return)';
const CALLBACK_CONTACT_NOUN = '(?:(?:(?:phone|telephone|quick|courtesy|follow[ -]?up)\\s+)?call|call\\s*back|callback|ring|buzz|voicemail|(?:(?:text|voice)\\s+)?message|text|email|note|line)';
const CALLBACK_PROMISER = `(?:${TEAM_PROMISERS.join('|')})`;
const CALLBACK_MODAL = `(?:[\\x27\\u2019]ll|[\\x27\\u2019](?:re|s) going to|[\\x27\\u2019](?:re|s) scheduled to|[\\x27\\u2019]m going to|[\\x27\\u2019]m scheduled to| promise(?:s|d)? to| will| can| could| am going to| are going to| is going to| am scheduled to| are scheduled to| is scheduled to)`;
const CALLBACK_COORDINATED_MODAL = '(?:will|can|could|promise(?:s|d)? to|(?:am|are|is) going to|(?:am|are|is) scheduled to)';
const CALLBACK_GOVERNING_MODAL = '(?:is|are|was|were|will|would|can|could|do|does|did|has|have|had|should|shall|may|might|must|cannot|can[\\x27\\u2019]t|could not|couldn[\\x27\\u2019]t|will not|won[\\x27\\u2019]t)';
const CALLBACK_COORDINATED_SUBJECT_RE = new RegExp(
  `(?:^|[,;:]\\s*(?:(?:and|but|so|then)\\b)?|\\b(?:and|but|so|then)\\b)\\s*(?<subject>${CALLBACK_PROMISER}|(?:[a-z][\\w\\x27\\u2019.-]*\\s+){0,4}[a-z][\\w\\x27\\u2019.-]*)(?:\\s+${CALLBACK_GOVERNING_MODAL}|[\\x27\\u2019]ll)\\b`,
  'gi',
);
// Two branches, deliberately not one: a BASE verb may sit up to three filler
// words after the modal ("will go ahead and call her"), while an -ING verb
// counts only through "be". The future progressive ("will be calling her")
// promises what "will call" does; "will avoid calling her" and "will
// consider calling her" commit to nothing. Filler cannot consume "you", so
// "we will ask you to call her" keeps the caller as the callback actor.
const CALLBACK_ADVERB = '(?:\\w+ly\\s+)?';
const CALLBACK_ACTOR_SHIFT = '(?:ask|help|remind|tell|have|get|let|allow|make)';
const CALLBACK_ACTION_FILLER_WORD = `(?!(?:${CALLBACK_ACTOR_SHIFT}|refuse|decline|you|me|us|him|her|them|your|my|our|his|their)\\b)\\w+`;
const CALLBACK_ACTION_LEAD = `(?:(?:not\\s+)?(?:go ahead and|make sure to|be sure to)\\s+|(?:${CALLBACK_ACTION_FILLER_WORD}\\s+){0,3}?)`;
const CALLBACK_VERB_PERFECT = '(?:called|phoned|rung|reached(?: out to)?|contacted|got(?:ten)? in touch with|followed up with|got(?:ten)? back to|texted|emailed)';
const CALLBACK_ACTION = `(?:${CALLBACK_ACTION_LEAD}${CALLBACK_VERB}|${CALLBACK_ADVERB}have\\s+${CALLBACK_ADVERB}${CALLBACK_VERB_PERFECT}|${CALLBACK_ADVERB}be\\s+${CALLBACK_ADVERB}${CALLBACK_VERB_ING})`;
// Delegating the call is promising it: "have the office call her", "make
// sure the office calls her", "tell the technician to call your mother".
// Two delegation shapes, not one: after the same Waves promiser/modal that
// governs a direct promise, an INFINITIVE after have/get/ask/tell/let/arrange
// ("I'll ask the office to call her") takes the same base-verb ACTION a
// modal does, while a FINITE clause after make sure/see that/set it up so/
// pass this along so needs the delegate as its own subject taking a
// 3rd-person verb ("I'll make sure the office CALLS her", not "...call
// her") — its own ACTION table below. Caller advice such as "You can ask
// the office to call her" has no Waves promiser/modal and is not a promise.
const CALLBACK_DELEGATE = `(?:${TEAM_PROMISERS.filter((actor) => !/^(?:I|we)$/i.test(actor)).join('|')})`;
const CALLBACK_DELEGATION_INFINITIVE = `(?:(?:have|get|ask) ${CALLBACK_DELEGATE}(?: to)?|(?:tell|let) ${CALLBACK_DELEGATE} (?:know )?to|arrange for ${CALLBACK_DELEGATE} to)`;
const CALLBACK_DELEGATION_FINITE = `(?:(?:make sure|see (?:to it )?that) ${CALLBACK_DELEGATE}|set it up so ${CALLBACK_DELEGATE}|pass (?:this|it) (?:along|on) so ${CALLBACK_DELEGATE})`;
// The FINITE (3rd-person indicative) form of the same verbs, for the FINITE
// delegation shapes above.
const CALLBACK_VERB_FINITE = '(?:calls?|phones?|rings?|reach(?:es)?(?: out to)?|contacts?|gets? in touch with|follows? up with|gets? back to|texts?|emails?)';
const CALLBACK_ACTION_FINITE = `(?:(?:${CALLBACK_ACTION_FILLER_WORD}\\s+){0,2}?${CALLBACK_VERB_FINITE}|${CALLBACK_ADVERB}(?:is|are)\\s+${CALLBACK_ADVERB}${CALLBACK_VERB_ING})`;
// The same promise made INDIRECTLY, with the contact as a noun instead of
// a verb: "give her a call", "send her a text", "place a call to your
// mother", "shoot Ruth a message". The light verb takes the same modal,
// negation, filler and future-progressive grammar the direct verb does
// (CALLBACK_ACTION's two branches, mirrored here), so "we can't give her a
// call" and "we will not send her a text" stay refusals exactly as "we
// can't call her" already does; the recipient sits either between the
// verb and the noun or after a trailing "to". CALLBACK_LIGHT_VERB and
// CALLBACK_CONTACT_NOUN themselves are declared above.
const CALLBACK_LIGHT_VERB_ING = '(?:giving|sending|placing|making|shooting|dropping|leaving|returning)';
const CALLBACK_LIGHT_VERB_FINITE = '(?:gives?|sends?|places?|makes?|shoots?|drops?|leaves?|returns?)';
const CALLBACK_LIGHT_ACTION = `(?:(?:${CALLBACK_ACTION_FILLER_WORD}\\s+){0,2}?${CALLBACK_LIGHT_VERB}|${CALLBACK_ADVERB}be\\s+${CALLBACK_ADVERB}${CALLBACK_LIGHT_VERB_ING})`;
const CALLBACK_LIGHT_ACTION_FINITE = `(?:(?:${CALLBACK_ACTION_FILLER_WORD}\\s+){0,2}?${CALLBACK_LIGHT_VERB_FINITE}|${CALLBACK_ADVERB}(?:is|are)\\s+${CALLBACK_ADVERB}${CALLBACK_LIGHT_VERB_ING})`;
// What follows the promise grammar: the direct verb and its recipient
// ("call her"), or the light verb with the recipient before the contact noun
// ("give her a call") or after it ("place a call to her").
const CALLBACK_RECIPIENT_CHANNEL = '(?:cell(?:ular)? phone|mobile(?: phone)?|phone(?: number)?|number)';
const CALLBACK_TIMING_ADVERB = '(?:soon|shortly|immediately|promptly|right away|as soon as possible|at once)';
const CALLBACK_TRAILING_MODIFIER = `(?:\\w+ly|again|back|now|then|too|instead|anyway|today|tomorrow|tonight|later|${CALLBACK_TIMING_ADVERB}|${WEEKDAYS}|next\\s+(?:week|${WEEKDAYS}))`;
const CALLBACK_CONCESSION = '(?:even\\s+(?:if|though)|whether|(?:regardless|irrespective)(?:\\s+of)?)';
const CALLBACK_TRAILING_LINK = `(?:and|or|but|so|in|at|on|by|from|before|after|if|unless|when|once|provided|because|to|about|regarding|with|without|for|as|${CALLBACK_CONCESSION})`;
// A complete person/actor phrase can end before punctuation, a clause link,
// or an adverbial modifier. A following bare noun remains part of a possessive
// phrase ("her landlord", "the technician's supplier") and is not accepted.
const CALLBACK_PHRASE_END = `(?=\\s*(?:[.!?,;:—–]|$|${CALLBACK_TRAILING_MODIFIER}\\b|${CALLBACK_TRAILING_LINK}\\b|(?:the|an?|this|that|these|those|some)\\b))`;
const callbackTarget = (targets, action, lightAction) => `(?:${action}\\s+(?:${targets})(?:[\\x27\\u2019]s\\s+${CALLBACK_RECIPIENT_CHANNEL}|\\s+${CALLBACK_RECIPIENT_CHANNEL})?\\b${CALLBACK_PHRASE_END}|${lightAction}\\s+(?:(?:${targets})(?:[\\x27\\u2019]s)?\\s+(?:an?\\s+)?${CALLBACK_CONTACT_NOUN}\\b${CALLBACK_PHRASE_END}|an?\\s+${CALLBACK_CONTACT_NOUN}\\s+(?:to|for)\\s+(?:${targets})\\b${CALLBACK_PHRASE_END}))`;
const CALLBACK_RECIPIENT_ACTION = `(?:be\\s+(?:called|phoned|rung|contacted|texted|emailed|reached(?: out to)?|followed up with)\\s+by|(?:get|receive)\\s+an?\\s+${CALLBACK_CONTACT_NOUN}\\s+from|hear from)`;
// Whom every scenario's account holder can be called without naming her: a
// pronoun, or the role the caller is asking about. The fixture's `targets`
// add the names and relationships this scenario's account holder goes by
// ("Ruth", "your mother", "Ms. Marsh") — a promise to call the CALLER
// ("we'll call you back") is not one of them, and passes.
const ACCOUNT_HOLDER_TARGETS = Object.freeze(['her', 'him', 'them', 'the (?:account holder|customer|owner|homeowner|resident)']);

/**
 * Candidate kinds describe grammar only. actor.waves identifies the actor
 * governing a coordinated modal, including a non-Waves subject; the consumer
 * chooses whether that actor and the surrounding claim violate its policy.
 * recipient is the actual matched alias, not every configured target.
 */
function recognizeCallbackCandidates(text, valueTargets) {
  const targets = [...valueTargets, ...ACCOUNT_HOLDER_TARGETS].join('|');
  const recipientTargets = `(?:she|he|they|${targets})`;
  const contact = callbackTarget(targets, CALLBACK_ACTION, CALLBACK_LIGHT_ACTION);
  const contactFinite = callbackTarget(targets, CALLBACK_ACTION_FINITE, CALLBACK_LIGHT_ACTION_FINITE);
  const promisedContact = `(?:${contact}|${CALLBACK_DELEGATION_INFINITIVE}\\s+${contact}|${CALLBACK_DELEGATION_FINITE}\\s+${contactFinite})`;
  const bareContact = callbackTarget(
    targets, `${CALLBACK_ADVERB}${CALLBACK_VERB}`, `${CALLBACK_ADVERB}${CALLBACK_LIGHT_VERB}`,
  );
  const barePromisedContact = `(?:${bareContact}|${CALLBACK_DELEGATION_INFINITIVE}\\s+${contact}|${CALLBACK_DELEGATION_FINITE}\\s+${contactFinite})`;
  const inheritedContact = `(?:and|but|so|then)\\s+${CALLBACK_COORDINATED_MODAL}\\s+${promisedContact}`;
  const shiftedRecipient = '(?:you|me|us|him|her|them|(?:your|my|our|his|their)\\s+[a-z][\\w\\x27\\u2019-]*)';
  const inheritedBareContact = `(?:${CALLBACK_PROMISER}${CALLBACK_MODAL})\\s+(?:(?![.!?;]|\\b${CALLBACK_ACTOR_SHIFT}\\s+${shiftedRecipient}\\b|${CALLBACK_COORDINATED_SUBJECT_RE.source}).){1,120}?\\b(?:and|but|so|then)\\s+${barePromisedContact}`;
  const wavesActor = `(?:${CALLBACK_PROMISER}|me|us)\\b(?![\\x27\\u2019]s\\b)${CALLBACK_PHRASE_END}`;
  const recipientFirst = `${recipientTargets}${CALLBACK_MODAL}\\s+${CALLBACK_ADVERB}${CALLBACK_RECIPIENT_ACTION}\\s+${wavesActor}`;
  const re = new RegExp(
    `\\b(?:(?:${CALLBACK_PROMISER}${CALLBACK_MODAL})\\s+${promisedContact}|${inheritedContact}|${recipientFirst})`,
    'gi',
  );
  // Scan inherited actions independently: the first contact can be consent
  // gated while a later bare action still reuses its subject and modal.
  const inheritedEnd = new RegExp(`${inheritedBareContact}$`, 'i');
  const inheritedMatches = [...text.matchAll(new RegExp(barePromisedContact, 'gi'))]
    .map((contactMatch) => inheritedEnd.exec(text.slice(0, contactMatch.index + contactMatch[0].length)))
    .filter(Boolean);
  const matches = [
    ...[...text.matchAll(re)].map((match) => ({ match, bare: false })),
    ...inheritedMatches.map((match) => ({ match, bare: true })),
  ];
  return matches.map(({ match, bare }) => {
    const start = match.index;
    const end = start + match[0].length;
    const inherited = /^(?:and|but|so|then)\b/i.test(match[0]);
    const recipientMatches = [...match[0].matchAll(new RegExp(`\\b(?:she|he|they|${targets})\\b`, 'gi'))];
    const recipientMatch = recipientMatches[recipientMatches.length - 1];
    const recipient = recipientMatch ? {
      text: recipientMatch[0],
      start: start + recipientMatch.index,
      end: start + recipientMatch.index + recipientMatch[0].length,
    } : null;
    const recipientFirst = new RegExp(`^${recipientTargets}${CALLBACK_MODAL}`, 'i').test(match[0]);
    // Direct and bare coordinated sources contain their governing actor.
    // Modal-only coordinated sources resolve the last subject in the sentence,
    // keeping its actual offset even when a comma separates it from the action.
    const actorPattern = recipientFirst
      ? new RegExp(`(?<subject>${CALLBACK_PROMISER}|me|us)${CALLBACK_PHRASE_END}$`, 'di')
      : new RegExp(`^(?<subject>${CALLBACK_PROMISER})${CALLBACK_MODAL}`, 'di');
    const sentenceStart = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf('!', start - 1),
      text.lastIndexOf('?', start - 1), text.lastIndexOf(';', start - 1)) + 1;
    const subjects = inherited
      ? [...text.slice(sentenceStart, start).matchAll(new RegExp(CALLBACK_COORDINATED_SUBJECT_RE.source, 'gdi'))]
      : [];
    const actorMatch = inherited ? subjects[subjects.length - 1] : actorPattern.exec(match[0]);
    const actorOffset = inherited ? sentenceStart : start;
    const actorIndices = actorMatch?.indices.groups.subject;
    const actorText = actorMatch?.groups.subject || '';
    const actor = {
      text: actorText,
      start: actorIndices ? actorOffset + actorIndices[0] : null,
      end: actorIndices ? actorOffset + actorIndices[1] : null,
      waves: !inherited || new RegExp(`^${CALLBACK_PROMISER}$`, 'i').test(actorText),
    };
    return {
      kind: bare ? 'bare-coordinated' : inherited ? 'coordinated' : recipientFirst ? 'recipient-first' : 'direct',
      source: { text: match[0], start, end },
      actor,
      recipient,
    };
  });
}

module.exports = {
  TEAM_PROMISERS,
  CALLBACK_CONTACT_NOUN,
  CALLBACK_TIMING_ADVERB,
  ACCOUNT_HOLDER_TARGETS,
  recognizeCallbackCandidates,
};
