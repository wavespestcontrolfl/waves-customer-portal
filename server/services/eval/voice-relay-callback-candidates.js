/**
 * Recognize callback commitment candidates, without deciding whether consent,
 * a refusal or a hedge makes them permissible. All spans are half-open UTF-16
 * offsets into the supplied spoken string, including an inherited actor that
 * can precede the candidate source. No transcript, tool or policy dependencies.
 */

const TEAM_PROMISERS = Object.freeze(['I', 'we', 'the office', 'our office', 'the team', 'our team', 'a member of our team', 'a team member', 'a Waves team member', 'someone', 'someone from the office', 'someone from our office', 'somebody', 'one of us', 'a technician', 'the technician', 'our technician', 'our tech', 'the tech', 'a tech', 'dispatch', 'customer service', 'waves']);
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo';
// Shared actor/action vocabulary; sibling timing and consent checks use the
// same contact nouns rather than independently expanding the grammar.
const CALLBACK_VERB = '(?:call|phone|ring|reach(?: out to)?|contact|get in touch with|follow up with|get back to|speak (?:with|to)|talk (?:to|with)|text|email)';
const CALLBACK_VERB_ING = '(?:calling|phoning|ringing|reaching(?: out to)?|contacting|getting in touch with|following up with|getting back to|speaking (?:with|to)|talking (?:to|with)|texting|emailing)';
const CALLBACK_LIGHT_VERB = '(?:give|send|place|make|shoot|drop|leave|return)';
const CALLBACK_CONTACT_NOUN = '(?:(?:(?:phone|telephone|quick|courtesy|follow[ -]?up)\\s+)?call|call\\s*back|callback|ring|buzz|voicemail|(?:(?:text|voice)\\s+)?message|text|email|note|line)';
const CALLBACK_PROMISER = `(?:${TEAM_PROMISERS.join('|')})`;
// "scheduled" can carry a short timing phrase before its infinitive ("is
// scheduled tomorrow to call her", "are scheduled at 3 PM to call her");
// bounding the gap to a few tokens keeps it from crossing into an
// unrelated clause.
const CALLBACK_SCHEDULING_TIMING_GAP = '(?:[a-z0-9:]+\\s+){0,3}';
const CALLBACK_MODAL = `(?:[\\x27\\u2019]ll|[\\x27\\u2019](?:re|s) going to|[\\x27\\u2019](?:re|s) scheduled ${CALLBACK_SCHEDULING_TIMING_GAP}to|[\\x27\\u2019]m going to|[\\x27\\u2019]m scheduled ${CALLBACK_SCHEDULING_TIMING_GAP}to| promise(?:s|d)? to| will| can| could| am going to| are going to| is going to| am scheduled ${CALLBACK_SCHEDULING_TIMING_GAP}to| are scheduled ${CALLBACK_SCHEDULING_TIMING_GAP}to| is scheduled ${CALLBACK_SCHEDULING_TIMING_GAP}to)`;
const CALLBACK_COORDINATED_MODAL = '(?:will|can|could|promise(?:s|d)? to|(?:am|are|is) going to|(?:am|are|is) scheduled to)';
const CALLBACK_GOVERNING_MODAL = '(?:is|are|was|were|will|would|can|could|do|does|did|has|have|had|should|shall|may|might|must|cannot|can[\\x27\\u2019]t|could not|couldn[\\x27\\u2019]t|will not|won[\\x27\\u2019]t)';
// A leading pronoun, determiner, or possessive marks where an actor's noun
// phrase can actually start; a bare temporal or conditional adverbial
// ("tomorrow", "if necessary") never does. Requiring the generic (non-
// promiser) subject branch to start on one of these — instead of allowing
// any word — keeps the coordinated-actor capture from swallowing whatever
// adverbial precedes it, without enumerating every possible adverb.
const CALLBACK_ACTOR_HEAD = '(?:you|he|she|it|they|one|who|my|our|your|his|their|the|an?|this|that|these|those|some|another)';
// A coordinator can be followed by a short adverbial or discourse aside
// ("tomorrow", "of course", "if necessary") with no punctuation of its own
// before the real subject. Each skipped word is barred from itself being a
// promiser or an actor-head word, so the filler can never consume the
// subject it is supposed to be clearing out of the way; bounding it to two
// words keeps "and of course we're going to review" and "and tomorrow
// we'll review" both resolving to actor "we".
const CALLBACK_COORDINATED_FILLER = `(?:(?!\\b(?:${CALLBACK_ACTOR_HEAD}|${CALLBACK_PROMISER})\\b)[a-z][\\w\\x27\\u2019.-]*\\s+){0,2}`;
const CALLBACK_COORDINATED_SUBJECT_RE = new RegExp(
  `(?:^|[,;:]|\\b(?:and|or|but|so|then)\\b)\\s*(?:(?:and|or|but|so|then)\\b\\s*)*${CALLBACK_COORDINATED_FILLER}(?<subject>${CALLBACK_PROMISER}|${CALLBACK_ACTOR_HEAD}(?:\\s+[a-z][\\w\\x27\\u2019.-]*){0,3})(?:\\s+${CALLBACK_GOVERNING_MODAL}|${CALLBACK_MODAL})\\b`,
  'gi',
);
// Moved ahead of its original position (once next to CALLBACK_RECIPIENT_
// CHANNEL) so CALLBACK_COORDINATED_SUBJECT_SHIFT_RE below can reuse it — a
// bare temporal/discourse adverb ("tomorrow", "otherwise") is exactly the
// non-subject shape that list already exists to name.
const CALLBACK_TIMING_ADVERB = '(?:soon|shortly|immediately|promptly|right away|as soon as possible|at once)';
// "sometime"/"later" stand alone or head an ordinary timing phrase
// ("sometime tomorrow", "later this week"); folding the bare "later" case
// into this alternative avoids listing it twice.
const CALLBACK_TIMING_PHRASE = '(?:sometime|later)(?:\\s+(?:today|tomorrow|this\\s+week))?';
// A bare "\w+ly" alternative also matches possessive nouns that merely end
// in "-ly" ("her family", "her ally"), which are not adverbs at all; a
// bounded list of the actual trailing adverbs keeps those nouns from being
// swallowed as if they ended the recipient phrase.
const CALLBACK_TRAILING_ADVERB = '(?:shortly|quickly|directly|immediately|promptly|personally|briefly)';
const CALLBACK_TRAILING_MODIFIER = `(?:${CALLBACK_TRAILING_ADVERB}|again|back|now|then|too|instead|anyway|today|tomorrow|tonight|${CALLBACK_TIMING_PHRASE}|${CALLBACK_TIMING_ADVERB}|${WEEKDAYS}|next\\s+(?:week|weekend|month|year|${WEEKDAYS}))`;
// A coordinator introducing ANY other apparent subject before a modal —
// including a bare name with no leading pronoun or determiner ("and Jordan
// will review...") — signals the original promiser may no longer govern
// what follows, even when that subject is not itself recognized as a
// candidate actor by CALLBACK_COORDINATED_SUBJECT_RE above (whose
// ACTOR_HEAD restriction exists for actor ATTRIBUTION, not for this guard).
// Used only to exclude a bare-coordinated match from wrongly inheriting the
// original promiser — never to attribute the shifted subject itself, since
// this widened alternative is not anchored to a real actor phrase shape.
// The subject's own first word still cannot be a bare temporal/discourse
// adverb ("and tomorrow will review...", "and otherwise will call her"):
// an adverb never itself does the coordinated action, so treating it as an
// unresolved-actor shift would wrongly excuse the ORIGINAL promiser's own
// unconditional promise instead of correctly still attributing it.
// CALLBACK_TRAILING_MODIFIER only names TIMING adverbs ("tomorrow",
// "later"); a non-timing discourse connective ("otherwise", "also",
// "therefore", "meanwhile") is the same non-subject shape and needs its
// own list, since none of those words belong in a RECIPIENT-phrase-end
// context (CALLBACK_TRAILING_MODIFIER's other job) the way a timing word
// does.
const CALLBACK_DISCOURSE_ADVERB = '(?:otherwise|also|therefore|meanwhile|moreover|furthermore|however|nonetheless|nevertheless|thus|hence|consequently|similarly)';
const CALLBACK_COORDINATED_SUBJECT_SHIFT_RE = new RegExp(
  `(?:^|[,;:]|\\b(?:and|or|but|so|then)\\b)\\s*(?:(?:and|or|but|so|then)\\b\\s*)*${CALLBACK_COORDINATED_FILLER}(?!\\b(?:and|or|but|so|then)\\b)(?!${CALLBACK_TRAILING_MODIFIER}\\b)(?!\\b${CALLBACK_DISCOURSE_ADVERB}\\b)[a-z][\\w\\x27\\u2019.-]*(?:\\s+(?!\\b(?:and|or|but|so|then)\\b)[a-z][\\w\\x27\\u2019.-]*){0,3}(?:\\s+${CALLBACK_GOVERNING_MODAL}|${CALLBACK_MODAL})\\b`,
  'gi',
);
// A bridge like "check, or call her" reuses the sentence's opening promiser,
// but an intervening subject with its own bare verb that directly abuts the
// coordinator (no punctuation break) governs the coordinated action instead:
// "while you review or call her" means "you review or [you] call her", not
// a Waves promise. "she agrees, and email him" stays bridgeable because the
// comma separates the aside from the resumed main-clause coordination.
// Verb agreement, not just a subject word, decides whether the intervening
// clause actually governs the coordinated action: "you review or call her"
// reads as "you review or [you] call her" because "you" can also govern the
// following base-form contact verb, but singular "she" cannot — "she
// reviews and call her" can only mean "[we] call her", so an -s finite verb
// after a third-person-singular subject does not count as a bridge. A
// plural/second-person subject keeps matching on any final word since its
// base-form verb never carries that -s.
const CALLBACK_SUBORDINATE_BRIDGE = `\\b(?:you|they|one|who)\\b\\s+(?:(?!(?:and|or|but|so|then)\\b)[a-z]+\\s+){0,3}(?!(?:and|or|but|so|then)\\b)[a-z]+\\s*\\b(?:and|or|but|so|then)\\b|\\b(?:she|he|it)\\b\\s+(?:(?!(?:and|or|but|so|then)\\b)[a-z]+\\s+){0,3}(?!(?:and|or|but|so|then)\\b)[a-z]+(?<!s)\\s*\\b(?:and|or|but|so|then)\\b`;
// Two branches, deliberately not one: a BASE verb may sit up to three filler
// words after the modal ("will go ahead and call her"), while an -ING verb
// counts only through "be". The future progressive ("will be calling her")
// promises what "will call" does; "will avoid calling her" and "will
// consider calling her" commit to nothing. Filler cannot consume "you", so
// "we will ask you to call her" keeps the caller as the callback actor.
const CALLBACK_ADVERB = '(?:\\w+ly\\s+)?';
const CALLBACK_ACTOR_SHIFT = '(?:ask|help|remind|tell|have|get|let|allow|make)';
const CALLBACK_ACTION_FILLER_WORD = `(?!(?:${CALLBACK_ACTOR_SHIFT}|refuse|decline|consider|avoid|decide|think|debate|plan|wonder|discuss|you|me|us|him|her|them|your|my|our|his|their)\\b)\\w+`;
const CALLBACK_ACTION_LEAD = `(?:(?:not\\s+)?(?:go ahead and|make sure to|be sure to)\\s+|(?:${CALLBACK_ACTION_FILLER_WORD}\\s+){0,3}?)`;
// "whether/if to call" and "not to call" are deliberation or refusal, not a
// commitment, whatever verb governs them ("debate whether to call",
// "plan whether to call", "try not to call") — a structural guard on the
// infinitive shape catches every governing verb at once, rather than
// enumerating them.
// A finite embedded question ("see if they call her", "check whether they
// call her") is the same deliberation as the infinitive shape above, just
// with its own subject and a finite verb instead of "to" + the base verb —
// Waves only promises to observe or check, not to make the call itself.
const CALLBACK_ACTION_DELIBERATION_GUARD = `(?!(?:[a-z]+\\s+){0,3}(?:whether|if)\\s+to\\s+${CALLBACK_VERB}\\b)(?!(?:[a-z]+\\s+){0,3}not\\s+to\\s+${CALLBACK_VERB}\\b)(?!(?:[a-z]+\\s+){0,3}(?:whether|if)\\s+(?!to\\b)[a-z]+\\s+${CALLBACK_VERB}\\b)`;
const CALLBACK_VERB_PERFECT = '(?:called|phoned|rung|reached(?: out to)?|contacted|got(?:ten)? in touch with|followed up with|got(?:ten)? back to|spoken (?:with|to)|talked (?:to|with)|texted|emailed)';
const CALLBACK_ACTION = `(?:${CALLBACK_ACTION_DELIBERATION_GUARD}${CALLBACK_ACTION_LEAD}${CALLBACK_VERB}|${CALLBACK_ADVERB}have\\s+${CALLBACK_ADVERB}${CALLBACK_VERB_PERFECT}|${CALLBACK_ADVERB}be\\s+${CALLBACK_ADVERB}${CALLBACK_VERB_ING})`;
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
const CALLBACK_DELEGATION_INFINITIVE = `(?:(?:have|get|ask) ${CALLBACK_DELEGATE}(?: to)?|tell ${CALLBACK_DELEGATE} (?:know )?to|let ${CALLBACK_DELEGATE}|arrange for ${CALLBACK_DELEGATE} to)`;
const CALLBACK_DELEGATION_FINITE = `(?:(?:make sure(?: that)?|see (?:to it )?that) ${CALLBACK_DELEGATE}|set it up so ${CALLBACK_DELEGATE}|pass (?:this|it) (?:along|on) so ${CALLBACK_DELEGATE})`;
// The FINITE (3rd-person indicative) form of the same verbs, for the FINITE
// delegation shapes above.
const CALLBACK_VERB_FINITE = '(?:calls?|phones?|rings?|reach(?:es)?(?: out to)?|contacts?|gets? in touch with|follows? up with|gets? back to|speaks? (?:with|to)|talks? (?:to|with)|texts?|emails?)';
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
// "only if" is a restrictive condition, not the "even if" concession this
// group was named for, but it shares the same trailing shape (a focus
// adverb directly in front of "if") and needs the same phrase-end
// allowance so "call her only if the office opens" still closes the
// recipient span instead of falling through to no match at all.
const CALLBACK_CONCESSION = '(?:even\\s+(?:if|though)|only\\s+if|whether|(?:regardless|irrespective)(?:\\s+of)?)';
// "around"/"within" join the other simple timing prepositions already
// accepted here ("in an hour", "at noon", "by 5", "before/after lunch")
// so an ordinary prepositional timing phrase can follow the recipient.
const CALLBACK_TRAILING_LINK = `(?:and|or|but|so|in|at|on|by|from|before|after|around|within|if|unless|when|once|provided|because|to|about|regarding|with|without|for|as|${CALLBACK_CONCESSION})`;
// A complete person/actor phrase can end before punctuation, a clause link,
// or an adverbial modifier. A following bare noun remains part of a possessive
// phrase ("her landlord", "the technician's supplier") and is not accepted.
const CALLBACK_PHRASE_END = `(?=\\s*(?:[.!?,;:—–]|$|${CALLBACK_TRAILING_MODIFIER}\\b|${CALLBACK_TRAILING_LINK}\\b|(?:the|an?|this|that|these|those|some)\\b))`;
// \b only recognizes ASCII letters/digits/underscore as "word" characters, so
// it finds no boundary right after a non-ASCII letter ("José", "Zoë") that
// ends a sentence or precedes punctuation. These Unicode property lookarounds
// replace it wherever a configured recipient alias can end a match; every
// regex that embeds one needs the 'u' flag.
const CALLBACK_UNICODE_WORD_START = '(?<![\\p{L}\\p{N}_])';
const CALLBACK_UNICODE_WORD_END = '(?![\\p{L}\\p{N}_])';
// "call her a taxi" / "call her this nickname" / "call her that name" is a
// benefactive or naming use ("get her a taxi", "refer to her as the
// owner"), not a contact commitment, for any determiner the phrase-end
// below also recognizes ("this/that/these/those/some") plus the other
// ordinary object-complement determiners. A determiner directly after the
// recipient blocks the whole direct-verb match rather than merely ending
// the recipient span early. A preposition-led timing phrase ("within an
// hour", "in an hour") is unaffected: the word right after the recipient
// there is the preposition, not a determiner.
// A determiner-led TIMING phrase ("this afternoon", "some time tomorrow")
// is not an object complement even though it shares the same
// determiner-then-word shape as "this nickname" / "that name" / "some
// fool"; excluding the bounded timing nouns from the word right after the
// determiner keeps those ordinary callback times from being rejected.
const CALLBACK_OBJECT_COMPLEMENT_TIMING_NOUN = `(?:afternoon|morning|evening|weekend|week|month|year|time|day|${WEEKDAYS}|minute|hour|moment)`;
const CALLBACK_OBJECT_COMPLEMENT = `(?!\\s+(?:an?|the|this|that|these|those|some|any|another|my|our|your|his|their)\\s+(?!${CALLBACK_OBJECT_COMPLEMENT_TIMING_NOUN}\\b)[a-z])`;
const callbackTarget = (targets, action, lightAction) => `(?:${action}\\s+(?:${targets})(?:[\\x27\\u2019]s\\s+${CALLBACK_RECIPIENT_CHANNEL}|\\s+${CALLBACK_RECIPIENT_CHANNEL})?${CALLBACK_UNICODE_WORD_END}${CALLBACK_OBJECT_COMPLEMENT}${CALLBACK_PHRASE_END}|${lightAction}\\s+(?:(?:${targets})(?:[\\x27\\u2019]s)?\\s+(?:an?\\s+)?${CALLBACK_CONTACT_NOUN}\\b${CALLBACK_PHRASE_END}|an?\\s+${CALLBACK_CONTACT_NOUN}\\s+(?:to|for)\\s+(?:${targets})${CALLBACK_UNICODE_WORD_END}${CALLBACK_PHRASE_END}))`;
const CALLBACK_RECIPIENT_ACTION = `(?:be\\s+(?:called|phoned|rung|contacted|texted|emailed|reached(?: out to)?|followed up with)\\s+by|(?:get|receive)\\s+an?\\s+${CALLBACK_CONTACT_NOUN}\\s+from|hear from)`;
// The same promise as a noun instead of a verb: "is scheduled for a call
// with her", "is booked for a phone call with the office". Used both as a
// direct promiser-first form and, mirroring CALLBACK_RECIPIENT_ACTION
// above, as a recipient-first passive ("she is booked for a call with the
// office").
const CALLBACK_SCHEDULED_CALL_NOUN = `(?:is|are|was|am)\\s+(?:scheduled|booked|set\\s+up)\\s+for\\s+(?:an?\\s+)?${CALLBACK_CONTACT_NOUN}\\s+with`;
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
  const inheritedContact = `(?:and|or|but|so|then)\\s+${CALLBACK_COORDINATED_MODAL}\\s+${promisedContact}`;
  const shiftedRecipient = '(?:you|me|us|him|her|them|(?:your|my|our|his|their)\\s+[a-z][\\w\\x27\\u2019-]*)';
  const inheritedBareContact = `${CALLBACK_UNICODE_WORD_START}(?:${CALLBACK_PROMISER}${CALLBACK_MODAL})\\s+(?:(?![.!?;]|\\b${CALLBACK_ACTOR_SHIFT}\\s+${shiftedRecipient}\\b|${CALLBACK_COORDINATED_SUBJECT_SHIFT_RE.source}|${CALLBACK_SUBORDINATE_BRIDGE}).){1,120}?\\b(?:and|or|but|so|then)\\s+${barePromisedContact}`;
  const wavesActor = `(?:${CALLBACK_PROMISER}|me|us)\\b(?![\\x27\\u2019]s\\b)${CALLBACK_PHRASE_END}`;
  const recipientFirst = `${recipientTargets}${CALLBACK_MODAL}\\s+${CALLBACK_ADVERB}${CALLBACK_RECIPIENT_ACTION}\\s+${wavesActor}`;
  const scheduledCallDirect = `${CALLBACK_PROMISER}\\s+${CALLBACK_SCHEDULED_CALL_NOUN}\\s+(?:${targets})${CALLBACK_UNICODE_WORD_END}${CALLBACK_PHRASE_END}`;
  const scheduledCallPassive = `${recipientTargets}\\s+${CALLBACK_SCHEDULED_CALL_NOUN}\\s+${wavesActor}`;
  const re = new RegExp(
    // \b only recognizes ASCII word characters, so it finds no boundary
    // before a recipient-first alias that begins with a non-ASCII letter
    // ("Élodie will receive a call..."); the same Unicode-safe lookbehind
    // used for the end boundary elsewhere covers the start too.
    `${CALLBACK_UNICODE_WORD_START}(?:(?:${CALLBACK_PROMISER}${CALLBACK_MODAL})\\s+${promisedContact}|${inheritedContact}|${recipientFirst}|${scheduledCallDirect}|${scheduledCallPassive})`,
    'giu',
  );
  // Scan inherited actions independently: the first contact can be consent
  // gated while a later bare action still reuses its subject and modal.
  const inheritedEnd = new RegExp(`${inheritedBareContact}$`, 'iu');
  const inheritedMatches = [...text.matchAll(new RegExp(barePromisedContact, 'giu'))]
    .map((contactMatch) => inheritedEnd.exec(text.slice(0, contactMatch.index + contactMatch[0].length)))
    .filter(Boolean);
  const matches = [
    ...[...text.matchAll(re)].map((match) => ({ match, bare: false })),
    ...inheritedMatches.map((match) => ({ match, bare: true })),
  ];
  const seenCandidates = new Set();
  return matches.map(({ match, bare }) => {
    const start = match.index;
    const end = start + match[0].length;
    const inherited = /^(?:and|or|but|so|then)\b/i.test(match[0]);
    const recipientMatches = [...match[0].matchAll(new RegExp(
      `${CALLBACK_UNICODE_WORD_START}(?:she|he|they|${targets})${CALLBACK_UNICODE_WORD_END}`, 'giu',
    ))];
    const recipientMatch = recipientMatches[recipientMatches.length - 1];
    const recipient = recipientMatch ? {
      text: recipientMatch[0],
      start: start + recipientMatch.index,
      end: start + recipientMatch.index + recipientMatch[0].length,
    } : null;
    const recipientFirst = new RegExp(`^${recipientTargets}(?:${CALLBACK_MODAL}|\\s+${CALLBACK_SCHEDULED_CALL_NOUN})`, 'i').test(match[0]);
    // Direct and bare coordinated sources contain their governing actor.
    // Modal-only coordinated sources resolve the last subject in the sentence,
    // keeping its actual offset even when a comma separates it from the action.
    const actorPattern = recipientFirst
      ? new RegExp(`(?<subject>${CALLBACK_PROMISER}|me|us)${CALLBACK_PHRASE_END}$`, 'di')
      : new RegExp(`^(?<subject>${CALLBACK_PROMISER})(?:${CALLBACK_MODAL}|\\s+${CALLBACK_SCHEDULED_CALL_NOUN})`, 'di');
    // A semicolon joins clauses closely enough to keep sharing a governing
    // actor ("We will check; then will call her."), unlike a period, "!" or
    // "?", which do start a fresh sentence — so it is not a boundary here.
    const sentenceStart = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf('!', start - 1),
      text.lastIndexOf('?', start - 1)) + 1;
    const subjects = inherited
      ? [...text.slice(sentenceStart, start).matchAll(new RegExp(CALLBACK_COORDINATED_SUBJECT_RE.source, 'gdi'))]
      : [];
    // The same bare-named-delegate gap that inheritedBareContact's exclusion
    // guards against applies here too: if an unrecognized subject shift (no
    // leading pronoun/determiner, so CALLBACK_COORDINATED_SUBJECT_RE never
    // captures it) happened AFTER the last actor-head/promiser subject this
    // scan found, that later, unknown subject — not the stale earlier one —
    // governs the coordinated action. Treat the actor as unresolved rather
    // than defaulting to it, so downstream policy checks it as non-Waves.
    const lastSubject = subjects[subjects.length - 1];
    const shiftedPastLastSubject = inherited && [...text.slice(sentenceStart, start)
      .matchAll(new RegExp(CALLBACK_COORDINATED_SUBJECT_SHIFT_RE.source, 'gi'))]
      .some((shift) => !lastSubject || shift.index > lastSubject.index);
    const actorMatch = inherited ? (shiftedPastLastSubject ? null : lastSubject) : actorPattern.exec(match[0]);
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
  })
    // A coordinated commitment can satisfy both the primary expression and
    // the independent inherited-action scan ("We will check and call her."),
    // producing identical direct and bare-coordinated candidates for the
    // same commitment. Direct candidates are built first (see `matches`
    // above), so keeping the first occurrence per (span, actor, recipient)
    // keeps the direct kind and drops its bare-coordinated duplicate.
    .filter((candidate) => {
      const key = `${candidate.source.start}|${candidate.source.end}|${candidate.actor.text}|${candidate.recipient ? candidate.recipient.text : ''}`;
      if (seenCandidates.has(key)) return false;
      seenCandidates.add(key);
      return true;
    });
}

module.exports = {
  TEAM_PROMISERS,
  CALLBACK_CONTACT_NOUN,
  CALLBACK_TIMING_ADVERB,
  ACCOUNT_HOLDER_TARGETS,
  recognizeCallbackCandidates,
};
