// Scope/refusal/drying policy consumes source evidence. Conversation state
// and runner decisions live in voice-relay-safety-adjudicator.
const {
  EPISTEMIC_HEDGE_PREFIX_SOURCE, CONVERSATIONAL_CONDITION_RE, QUESTION_LEAD_RE,
  clauseIsNegated, clauseIsEpistemicallyHedged,
} = require('./voice-relay-spoken-language');
const {
  localCandidateEvidence, sentenceSourceSpans, INSTRUCTION_LEAD_RE, latestInterrogativeSpan,
} = require('./voice-relay-source-evidence');
const {
  SAFETY_REFUSAL_PREFIX, SAFETY_SUBJECT_MODIFIER, SAFETY_INTENSIFIER, HARM_ADJECTIVE,
  SAFETY_ADDITIVE_ADJECTIVE_PREFIX, SAFETY_COORDINATED_ADJECTIVE_SEPARATOR,
  SAFETY_STRONG_ADJECTIVE, SAFETY_ADJECTIVE, SAFETY_AUDIENCE, SAFETY_HARM_VERB,
  SAFETY_BRAND_MENTION_RE, SAFETY_REFUSED_CLAIM_RE, SAFETY_SUBJECT_WITH_PRODUCT,
  SAFETY_SUBJECT_VERB, SAFETY_BRAND_SUBJECT, SAFETY_AUDIENCE_SUBJECT,
  SAFETY_AUDIENCE_PRODUCT_RELATION, safetyNamesProduct, SAFETY_AUDIENCE_NOUN,
  SAFETY_AUDIENCE_POSSESSIVE, SAFETY_COORDINATED_ADJECTIVE_PREFIX,
  SAFETY_GUARANTEED_MODIFIER, SAFETY_PRODUCT_RELATIVE, dynamicIdentityFor,
} = require('./voice-relay-safety-response-recognition');
const { recognizeSafetyQuestion, SAFETY_NON_PREFIX } = require('./voice-relay-safety-question-recognition');

// A restriction connector ("except for dogs", "not for dogs") names an
// EXCLUDED audience, not a positive scope -- without this exclusion the
// same "for AUDIENCE" text would double as a claimed scope narrower than
// the refusal actually states, on top of being read by
// SAFETY_AUDIENCE_EXCLUSION_RE as the exclusion it really is.
const SAFETY_AUDIENCE_SCOPE_RE = new RegExp(`(?<!\\b(?:except|excluding|unless|other\\s+than|apart\\s+from|not)\\s)\\b(?:for|around|with)\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

const SAFETY_HARM_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:hurt|harm|bother|affect|poison)\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

const SAFETY_RISK_TO_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:risk|harm|danger)\\s+to\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

const SAFETY_AUDIENCE_MEMBER_RE = new RegExp(`\\b${SAFETY_AUDIENCE_POSSESSIVE}(${SAFETY_AUDIENCE_NOUN})\\b`, 'gi');

const SAFETY_AUDIENCE_SUBJECT_SCOPE_RE = new RegExp(`\\b(${SAFETY_AUDIENCE_SUBJECT})(?:${SAFETY_SUBJECT_VERB}|\\s+(?:be\\s+)?)\\s*${SAFETY_COORDINATED_ADJECTIVE_PREFIX}${SAFETY_GUARANTEED_MODIFIER}(?:not\\s+)?${SAFETY_INTENSIFIER}(?:${SAFETY_ADJECTIVE}|${HARM_ADJECTIVE})\\b${SAFETY_AUDIENCE_PRODUCT_RELATION}`, 'gi');

const SAFETY_KEEP_SAFE_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:${SAFETY_SUBJECT_WITH_PRODUCT}|${SAFETY_BRAND_SUBJECT})${SAFETY_PRODUCT_RELATIVE}\\s+(?:(?:will|would|can|could)\\s+)?keeps?\\s+(${SAFETY_AUDIENCE})\\s+${SAFETY_INTENSIFIER}safe\\b`, 'gi');

const SAFETY_ADJECTIVE_TO_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:${SAFETY_STRONG_ADJECTIVE}|${HARM_ADJECTIVE})\\s+to\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

function safetyAudienceScopes(text) {
  const scopedPhrases = [
    ...text.matchAll(SAFETY_AUDIENCE_SCOPE_RE),
    ...text.matchAll(SAFETY_HARM_AUDIENCE_SCOPE_RE),
    ...text.matchAll(SAFETY_RISK_TO_AUDIENCE_SCOPE_RE),
    ...[...text.matchAll(SAFETY_AUDIENCE_SUBJECT_SCOPE_RE)].filter((scope) => safetyNamesProduct(scope[0])),
    ...[...text.matchAll(SAFETY_KEEP_SAFE_AUDIENCE_SCOPE_RE)].filter((scope) => safetyNamesProduct(scope[0])),
    ...text.matchAll(SAFETY_ADJECTIVE_TO_AUDIENCE_SCOPE_RE),
  ];
  const audiences = scopedPhrases
    .flatMap((scope) => [...scope[1].matchAll(SAFETY_AUDIENCE_MEMBER_RE)]);
  return new Set(audiences.map((match) => {
    if (/^(?:dogs?|pupp(?:y|ies))$/i.test(match[1])) return 'dog';
    if (/^(?:cats?|kittens?)$/i.test(match[1])) return 'cat';
    if (/^pets?$/i.test(match[1])) return 'pet';
    if (/^animals?$/i.test(match[1])) return 'animal';
    if (/^(?:people|humans?)$/i.test(match[1])) return 'human';
    // "family"/"families" spans every member of the household, including
    // any children in it -- distinct from (and broader than) a scope naming
    // only children/babies, which says nothing about the adults.
    if (/^famil(?:y|ies)$/i.test(match[1])) return 'family';
    return 'child';
  }));
}

const SAFETY_SPECIFIC_PRODUCT_SCOPES = Object.freeze([
  ['bait', /\bbaits?\b/i],
  ['gel', /\bgels?\b/i],
  ['spray', /\bsprays?\b/i],
  ['granule', /\bgranules?\b/i],
  ['rodenticide', /\brodenticides?\b/i],
  ['termiticide', /\btermiticides?\b/i],
  ['larvicide', /\blarvicides?\b/i],
  ['adulticide', /\badulticides?\b/i],
  ['miticide', /\bmiticides?\b/i],
  ['insecticide', /\binsecticides?\b/i],
  ['herbicide', /\bherbicides?\b/i],
  ['poison', /\bpoisons?\b/i],
  ['repellent', /\brepellents?\b/i],
  ['fumigant', /\bfumigants?\b/i],
]);

// Mirrors SAFETY_SUBJECT_COORDINATOR (voice-relay-safety-response-recognition,
// not exported): the response/question recognizers keep a coordinated
// product subject ("Bifen I/T and Termidor Foam") as one matched span so its
// full text stays available as evidence, but per-member product coverage
// needs each name on its own -- a refusal naming only one member must not
// read as covering both, and a question naming two must not read as one
// unmatchable compound product. Split only where every resulting piece is
// itself a complete brand mention on its own: this leaves a product name
// that happens to contain "and" ("Tim-bor Professional Insecticide and
// Fungicide") untouched, since its second half is not a brand by itself.
const SAFETY_BRAND_COORDINATOR_RE = /\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+/;
const SAFETY_BRAND_MENTION_ANCHORED_RE = new RegExp(`^${SAFETY_BRAND_MENTION_RE.source}$`);

function safetyBrandMentionMembers(text, options = {}) {
  const dynamicIdentity = dynamicIdentityFor(options.productNames);
  const isBrandMention = (part) => SAFETY_BRAND_MENTION_ANCHORED_RE.test(part)
    || (dynamicIdentity && dynamicIdentity.brandIdentityRe.test(part));
  const parts = text.split(SAFETY_BRAND_COORDINATOR_RE).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 && parts.every(isBrandMention) ? parts : [text];
}

// A caller's full utterance can carry a product mention outside the
// selected safety question ("The spray is scheduled tomorrow. Is the bait
// safe?"); scan only that selected interrogative span so the unrelated
// sentence's product never widens the required scope. Declarative
// claim/refusal text (no recognized question in it) is scanned in full,
// exactly as before.
function safetyProductScopeSource(text) {
  const latest = latestInterrogativeSpan(text);
  return latest ? latest.text : text;
}

// options.productNames carries the calling visit's live product identities
// (see dynamicIdentityFor in voice-relay-safety-response-recognition) so a
// product created or renamed after the checked-in fixture was regenerated
// still scopes correctly; omit it (the default) for the static-only
// grammar every existing caller already relies on.
function safetyProductScope(text, options = {}) {
  const source = safetyProductScopeSource(text);
  const scopes = new Set(SAFETY_SPECIFIC_PRODUCT_SCOPES
    .filter(([, pattern]) => pattern.test(source))
    .map(([scope]) => scope));
  const dynamicIdentity = dynamicIdentityFor(options.productNames);
  const brandPatterns = dynamicIdentity
    ? [SAFETY_BRAND_MENTION_RE, dynamicIdentity.brandMentionRe] : [SAFETY_BRAND_MENTION_RE];
  for (const brandPattern of brandPatterns) {
    for (const match of source.matchAll(new RegExp(brandPattern.source, 'g'))) {
      for (const member of safetyBrandMentionMembers(match[0], options)) {
        scopes.add(`brand:${member.toLowerCase().replace(/\s+/g, ' ')}`);
      }
    }
  }
  return scopes;
}

// Question evidence already crops fronted ASR conditions at their actual
// auxiliary and is anchored to whichever question recognizeSafetyQuestion
// actually selected -- the LATEST interrogative span, not necessarily the
// first predicate in the text ("Is the spray safe if swallowed? Is the
// bait safe?" selects the unconditional bait question). Only fall back to
// the first local lexical predicate when no question is recognized at all,
// as for a declarative refusal clause.
function safetyScopeEvidence(text) {
  const question = recognizeSafetyQuestion(text);
  const candidate = question.positive || question.harm;
  if (candidate) return candidate.evidence;
  const predicate = SAFETY_REFUSED_CLAIM_RE.exec(text);
  return predicate ? localCandidateEvidence(text, 'scope', predicate.index, predicate.index + predicate[0].length) : null;
}

// A while connective stays unresolved unless its entire body is a reduced
// state/exposure phrase. A finite independent assertion cannot qualify scope.
const REDUCED_WHILE_BODY_RE = /^\s*(?:(?:it|they)\s+(?:is|are)\s+)?(?:still\s+)?(?:dry|wet|dries|drying|swallowed|eaten|ingested)\s*$/i;
function safetyCircumstanceScopes(text, evidence = safetyScopeEvidence(text)) {
  if (!evidence) return [];
  const predicate = SAFETY_REFUSED_CLAIM_RE.exec(text.slice(evidence.clause.index, evidence.clause.end));
  const index = predicate ? evidence.clause.index + predicate.index : evidence.index;
  const end = predicate ? index + predicate[0].length : evidence.end;
  return [...evidence.conditions, ...evidence.adjacentConnectives]
    .filter((condition) => condition.end <= index || condition.marker.index >= end)
    .filter((condition) => condition.relation !== 'unresolved' || REDUCED_WHILE_BODY_RE.test(condition.body.text))
    .filter((condition) => !CONVERSATIONAL_CONDITION_RE.test(condition.body.text.replace(/^\s*(?:it|they)\s+(?:is|are|was|were)\s+/i, '')))
    .map((condition) => `${/^once$/i.test(condition.marker.text) ? 'when' : condition.marker.text} ${condition.body.text}`.toLowerCase()
      .replace(/\b(?:it|they)\s+(?:is|are|was|were)\s+/g, '')
      // A disjunct's trailing coordinator ("dry or ", ahead of the next
      // marker) is source-evidence's own boundary artifact, not part of
      // this disjunct's body -- strip it so each alternative compares as
      // the same string whether it comes from the question or a refusal.
      .replace(/\s+(?:or|and)\s*$/i, '').replace(/\s+/g, ' ').trim());
}

function safetyPropositionText(text, at) {
  const evidence = localCandidateEvidence(text, 'proposition', at, at);
  const tail = SAFETY_TRAILING_AUDIENCE_RE.exec(text.slice(evidence.clause.end));
  return text.slice(evidence.clause.index, tail ? evidence.clause.end + tail[0].length : evidence.clause.end);
}

const SAFETY_EMBEDDED_QUESTION_RE = /\b(?:ask(?:ed|ing)?|check(?:ed|ing)?|confirm(?:ed|ing)?|find out|know|tell|wonder(?:ed|ing)?)\b[^.!?;:]{0,80}\b(?:if|whether)\b[^.!?;:]*$/i;
const SAFETY_ASSERTION_TAG_RE = /^\s*,\s*(?:right|ok(?:ay)?|correct|yes|isn[\x27\u2019]t it|aren[\x27\u2019]t they|doesn[\x27\u2019]t it|don[\x27\u2019]t they)\s*$/i;
function safetyGuaranteeIsInterrogative(text, match) {
  const evidence = localCandidateEvidence(text, 'claim', match.index, match.index + match[0].length);
  const prefix = text.slice(evidence.clause.index, match.index);
  const context = text.slice(evidence.clause.index, match.index + match[0].length);
  const assertionTag = !prefix.trim() && SAFETY_ASSERTION_TAG_RE.test(text.slice(evidence.end, evidence.clause.end));
  // Subject-auxiliary inversion ("Are the products harmless") is itself the
  // grammatical mark of a question, so it classifies as interrogative even
  // when ASR dropped the punctuation -- unlike the bare-completion branch
  // below, which needs the literal "?" since it has no other question cue.
  // A coordinated candidate ("safe and the spray") can end its clause
  // before the sentence's own terminator; the enclosing sentence bound is
  // what actually carries the question mark for that bare form.
  return QUESTION_LEAD_RE.test(context)
    || (text[evidence.sentence.end] === '?' && !prefix.trim() && !assertionTag)
    || SAFETY_EMBEDDED_QUESTION_RE.test(prefix);
}

const SAFETY_REFUSAL_VERB_RE = new RegExp(`${SAFETY_REFUSAL_PREFIX}\\b[\"\\x27\\u201c\\u2018(]?`, 'gi');

const SAFETY_CLAUSE_BOUNDARY_TOKEN_RE = /,|\bthat said\b/gi;

const SAFETY_CLAUSE_HARD_BOUNDARY_RE = /^that said$/i;

function safetyClauseBoundary(text) {
  SAFETY_CLAUSE_BOUNDARY_TOKEN_RE.lastIndex = 0;
  let m = SAFETY_CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
  while (m) {
    const after = text.slice(m.index + m[0].length);
    if (SAFETY_CLAUSE_HARD_BOUNDARY_RE.test(m[0]) || !safetyClauseContinues(text.slice(0, m.index), after, m[0])) return m.index;
    SAFETY_CLAUSE_BOUNDARY_TOKEN_RE.lastIndex = m.index + m[0].length;
    m = SAFETY_CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
  }
  return -1;
}

function safetyExemptSpans(text) {
  const spans = [];
  SAFETY_REFUSAL_VERB_RE.lastIndex = 0;
  let m = SAFETY_REFUSAL_VERB_RE.exec(text);
  while (m) {
    const start = m.index + m[0].length;
    const evidence = localCandidateEvidence(text, 'refusal', m.index, start);
    if (evidence.sentence.ambiguousBoundaries.length) {
      m = SAFETY_REFUSAL_VERB_RE.exec(text);
      continue;
    }
    let end = evidence.clause.end;
    let coordinator = /^\b(?:and|or)\b/i.exec(text.slice(end));
    // A repeated reporting complement may share the original refusal. Extend
    // only a policy-approved continuation, obtaining every new bound from
    // source evidence; independent while clauses keep their own negations.
    while (coordinator && safetyClauseContinues(text.slice(start, end), text.slice(end + coordinator[0].length), coordinator[0])) {
      const following = localCandidateEvidence(text, 'refusal-continuation', end + coordinator[0].length, end + coordinator[0].length);
      if (following.sentence.ambiguousBoundaries.length || following.clause.end <= end) break;
      end = following.clause.end;
      coordinator = /^\b(?:and|or)\b/i.exec(text.slice(end));
    }
    const boundary = safetyClauseBoundary(text.slice(start, end));
    spans.push([start, boundary === -1 ? end : start + boundary]);
    m = SAFETY_REFUSAL_VERB_RE.exec(text);
  }
  return spans;
}

const SAFETY_ONCE_DRY_COORDINATED_WORD = `(?!(?:${SAFETY_ADJECTIVE})\\b)[a-z]+(?:-[a-z]+)?`;

const SAFETY_ONCE_DRY_COORDINATED_ITEM = `(?:${SAFETY_ONCE_DRY_COORDINATED_WORD}\\s+)?${SAFETY_ONCE_DRY_COORDINATED_WORD}`;

const SAFETY_ONCE_DRY_COORDINATED_PREFIX = `${SAFETY_ADDITIVE_ADJECTIVE_PREFIX}(?:(?:${SAFETY_ONCE_DRY_COORDINATED_ITEM})${SAFETY_COORDINATED_ADJECTIVE_SEPARATOR}){0,3}`;

// The drying condition must qualify this exact predicate. Only an optional
// audience may sit between "safe" and "once dry"; arbitrary text could cross
// into a second claim and incorrectly excuse the first one.
const SAFETY_ONCE_DRY_AFTER_RE = new RegExp(`^(?:\\s+(?:for|around|with)\\s+${SAFETY_AUDIENCE})?(?:,\\s*|\\s+)once\\s+(?:it|they)?(?:\\x27s|\\u2019s|\\s+is|\\s+are|\\x27re|\\u2019re)?\\s*dry\\b`, 'i');

// Only the sanctioned "safe once dry" predicate receives the drying
// exemption. Other guarantee adjectives remain guarantees even when followed
// by the same drying and technician-timing language.
const SAFETY_ONCE_DRY_PREDICATE_RE = new RegExp(`(?:^|(?:[\\x27\\u2019](?:s|re)|\\b(?:is|are|was|were|will be|would be|should be))\\s+)${SAFETY_ONCE_DRY_COORDINATED_PREFIX}safe(?:\\s+(?:for|around|with)\\s+${SAFETY_AUDIENCE})?$`, 'i');

const SAFETY_STAFF_ROLE = '(?:technician|tech|team member|member of (?:our|the) team)';

// A capability ("can confirm", "could confirm", "may confirm") only states
// that the technician is ABLE to confirm timing, not that they actually
// will; only an actual confirmation clause -- a future/progressive
// "will"/"is going to" form, a bare present-tense "confirms", or the
// equivalent "will let you know" -- satisfies the exemption.
const TECHNICIAN_DRY_TIMING_VERB_RE_SOURCE = '(?:will|is going to)\\s+(?:be\\s+)?(?:confirm(?:ing)?|verify(?:ing)?|check(?:ing)?)'
  + '|(?:confirms|verifies|checks)|will\\s+let\\s+you\\s+know';
const TECHNICIAN_DRY_TIMING_RE = new RegExp(
  `\\b(?:the |your |our |a )?${SAFETY_STAFF_ROLE}\\b[^.!?;]{0,30}?\\b(?:${TECHNICIAN_DRY_TIMING_VERB_RE_SOURCE})\\b[^.!?;]{0,30}?\\b(?:timing|drying(?: time)?|re-?entry(?: time| timing)?|when\\b[^.!?;]{0,16}\\bdry)\\b`,
  'gi',
);
const TECHNICIAN_EXPLICIT_DRY_TIMING_RE = /\b(?:drying(?: time)?|re-?entry(?: time| timing)?|when\b[^.!?;]{0,16}\bdry)\s*$/i;
// A bounded English number-word grammar for interval figures: every
// spelled-out quantity from "one" through "ninety-nine", plus "hundred" --
// local rather than reused from voice-relay-spoken-checks.js's
// NUMBER_WORD_EN_STRICT, which that module does not export. Only definite
// quantities count as prohibited fixed figures: "half an hour", "a couple
// of hours", and a bare "an hour" name one exactly the same as a number
// word does, but a vague amount ("a few minutes") never defeats the
// exemption.
const SAFETY_INTERVAL_ONES_WORD = 'one|two|three|four|five|six|seven|eight|nine';
const SAFETY_INTERVAL_TEEN_WORD = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const SAFETY_INTERVAL_TENS_WORD = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
// A tens word's ones digit can be spoken hyphenated ("twenty-one") or, just
// as commonly, spaced ("twenty one") -- both name the same fixed figure.
const SAFETY_INTERVAL_TENS_ONES_WORD = `(?:${SAFETY_INTERVAL_TENS_WORD})(?:[\\s-](?:${SAFETY_INTERVAL_ONES_WORD}))?`;
// "hundred" alone ("a hundred minutes"), an ones digit in front of it ("one
// hundred"), and an optional "and"-joined remainder ("two hundred and
// forty") are all still one definite quantity, not a vague amount.
const SAFETY_INTERVAL_HUNDRED_WORD = `(?:(?:${SAFETY_INTERVAL_ONES_WORD})\\s+)?hundred(?:\\s+and)?(?:\\s+(?:${SAFETY_INTERVAL_TENS_ONES_WORD}|${SAFETY_INTERVAL_TEEN_WORD}|${SAFETY_INTERVAL_ONES_WORD}))?`;
const SAFETY_INTERVAL_NUMBER_WORD = `${SAFETY_INTERVAL_HUNDRED_WORD}|${SAFETY_INTERVAL_TENS_ONES_WORD}|${SAFETY_INTERVAL_TEEN_WORD}|${SAFETY_INTERVAL_ONES_WORD}`;
const SAFETY_INTERVAL_QUANTITY_RE_SOURCE = `(?:(?:an?\\s+)?(?:\\d+(?:\\.\\d+)?|${SAFETY_INTERVAL_NUMBER_WORD})\\s*(?:minutes?|mins?|hours?|hrs?)|half\\s+an?\\s+hour|a\\s+couple\\s+of\\s+hours?|an?\\s+hour)`;
// A named fixed interval ("dries in 30 minutes", "safe after two hours",
// "re-enter in 4 hours", "safe within half an hour") is a banned specific
// figure even when it rides alongside the sanctioned "safe once dry"
// idiom; it must defeat the exemption rather than hide behind it. A fixed
// figure stated as its own drying-time sentence ("The drying time is 30
// minutes.", "Drying takes about an hour.") names the same banned quantity
// without an "in/after/within" preposition; "The treatment takes 30
// minutes to dry."/"It needs 30 minutes to dry." do too, but only when a
// trailing "to dry" actually ties the quantity to drying -- a generic
// subject like "it" or "the treatment" otherwise names an unrelated wait.
const SAFETY_FIXED_DRYING_FIGURE_RE = new RegExp(
  `\\b(?:dr(?:y|ies|ying)|re-?enter(?:s|ing)?|re-?entry|safe|ready)\\b[^.!?;]{0,30}?\\b(?:in|after|within)\\s+(?:about\\s+)?${SAFETY_INTERVAL_QUANTITY_RE_SOURCE}`
  + `|\\b(?:the\\s+)?dry(?:ing)?(?:\\s+time)?\\b[^.!?;]{0,15}?\\b(?:is|takes?|needs?)\\b[^.!?;]{0,20}?\\b(?:about\\s+)?${SAFETY_INTERVAL_QUANTITY_RE_SOURCE}`
  + `|\\b(?:the\\s+treatment|it|this|that)\\b[^.!?;]{0,15}?\\b(?:takes?|needs?)\\b[^.!?;]{0,20}?\\b(?:about\\s+)?${SAFETY_INTERVAL_QUANTITY_RE_SOURCE}[^.!?;]{0,5}?\\bto\\s+dry\\b`,
  'i',
);
const TECHNICIAN_VISIT_TIMING_RE = /\b(?:appointment|arrival|schedule|scheduling)\s+(?:time|timing)\b|\btiming\s+(?:for|of)\s+(?:(?:the|your|our)\s+)?(?:appointment|arrival|schedule)\b/i;
const SAFETY_COORDINATED_DRYING_WITHDRAWAL_RE = /^\s*,?\s*(?:and|or|but)\s+(?:even\s+)?(?:before\s+(?:it|they)\s+(?:dr(?:y|ies)|(?:is|are)\s+dry)|(?:while|when)\s+(?:(?:it|they)\s+(?:is|are)\s+)?wet)\b(?=\s*(?:[.!?;,]|$))/i;

function trailingWithdrawalAlternative(objectSource) {
  return new RegExp(
    `^\\s*(?:[^.!?;—–]{0,60}?\\s*,?\\s*(?:or|and|but|though|although)\\s+|[.!?;—–]\\s*(?:[^.!?;—–]*[.!?;—–]\\s*)*?(?:(?:actually|however)\\s*,?\\s*)?)(?:(?:maybe|perhaps|possibly|potentially)\\s+)?`
    + `(?:(?:i|we)\\s+${EPISTEMIC_HEDGE_PREFIX_SOURCE}\\s+${objectSource}(?=\\s*(?:[,.!?;—–]|$))|(?:(?:they|the technician|the team member)\\s+)?(?:`
    + `not(?:\\s+(?:necessarily|always|certainly|guaranteed))?(?=\\s*(?:[,.!?;—–]|$))|(?:(?:might|may|could|would|should|will)\\s+)?(?:skip|omit|avoid)\\s+${objectSource}\\b`
    + `|(?:(?:might|may|could|would|should|will|can|do|does)\\s+not|cannot|(?:might|could|would|should|ca|wo|do|does)n[\\x27\\u2019]t)`
    + `(?:\\s+(?:be able to\\s+)?(?:(?:confirm|verify|check|review|explain|go over|talk(?: you)? through)\\s+${objectSource}\\b|do\\s+(?:so|that)\\b)|(?=\\s*(?:[,.!?;—–]|$)))))`,
    'i',
  );
}

const TECHNICIAN_DRY_TIMING_ALTERNATIVE_RE = trailingWithdrawalAlternative('(?:it|that|this|(?:the\\s+)?(?:timing|confirmation|drying time|re-?entry time))');

const TECHNICIAN_DRY_TIMING_OBJECT_NEGATION_RE = /^\s*[^.!?;—–]{0,60}?\s*(?:,\s*|,?\s*(?:and|but|though|although)\s+)not\s+(?:the\s+)?(?:timing|confirmation|drying time|re-?entry time)\b/i;

const TECHNICIAN_VISIT_TIMING_OBJECT_NEGATION_RE = /^\s*,\s*not\s+(?:the\s+)?(?:appointment|arrival|schedule|scheduling)(?:\s+(?:time|timing))?\b/i;

// "It is false that the technician will confirm timing" denies the whole
// proposition rather than negating a word or hedging its certainty, so
// neither clauseIsNegated nor clauseIsEpistemicallyHedged catches it; it
// must still defeat the technician-confirmation exemption.
const SAFETY_TIMING_PROPOSITION_DENIAL_RE = /\bit(?:['’]s|\s+is|\s+was)\s+(?:false|not\s+true|untrue|a\s+lie)\s+that\b|\b(?:that['’]s|that\s+is|that\s+was)\s+(?:false|not\s+true|untrue)\b/i;

// Three distinct ways the timing claim can be withdrawn: an ordinary
// lexical negation, an epistemic hedge on certainty, or an explicit
// proposition-level denial. Any one of them means the technician's
// confirmation was never actually promised.
function safetyTimingClaimIsWithdrawn(claim) {
  return clauseIsNegated(claim) || clauseIsEpistemicallyHedged(claim) || SAFETY_TIMING_PROPOSITION_DENIAL_RE.test(claim);
}

function safetyTimingAudienceCovers(claimText, timingText) {
  const positiveTimingText = timingText.replace(SAFETY_AUDIENCE_EXCLUSION_RE, '');
  return !safetyAudienceScopes(positiveTimingText).size
    || safetyAudienceCovers(positiveTimingText, claimText);
}

// A potentially terminal abbreviation does not erase a complete fronted
// condition's following command. Interpret that bounded discourse form as
// an independent instruction; keep every ambiguity flag on both source sides.
// A bare condition, finite promise, or uncertainty within the command cannot
// establish an unconditional technician timing witness.
// Qualifying discourse requires a complete known command construction,
// not merely a word that could also be a noun ('contact', 'call times').
const COMPLETE_TIMING_INSTRUCTION_RE = /^(?:call|contact)\s+(?:me|us|him|her|them|poison control|(?:(?:the|your|our|an?)\s+)?(?:office|veterinarian|vet|doctor|technician))(?:\s+(?:now|immediately|today|tomorrow))?\s*$/i;
function timingAmbiguitySeparatesInstruction(source, evidence, witnessEnd) {
  const sentences = sentenceSourceSpans(source);
  return evidence.sentence.ambiguousBoundaries.every((boundary) => {
    if (!/^(?:time_abbreviation|lexical_abbreviation)$/.test(boundary.reason) || boundary.index < witnessEnd) return false;
    const containing = sentences.find((sentence) => boundary.end >= sentence.index && boundary.end < sentence.end);
    if (!containing) return false;
    const tail = source.slice(boundary.end, containing.end);
    const head = boundary.end + tail.length - tail.trimStart().length;
    const comma = source.indexOf(',', head);
    const direct = INSTRUCTION_LEAD_RE.exec(source.slice(head, containing.end));
    const commandAt = direct ? head : comma + 1;
    if (!direct && (comma < head || comma >= containing.end)) return false;
    const commandTail = source.slice(commandAt, containing.end);
    const command = INSTRUCTION_LEAD_RE.exec(commandTail.trimStart());
    if (!command) return false;
    const index = commandAt + commandTail.length - commandTail.trimStart().length;
    const instruction = localCandidateEvidence(source, 'instruction', index, index + command[0].length);
    if (instruction.sentence.ambiguousBoundaries.some((item) => item.index >= head)) return false;
    const ownCondition = instruction.conditions.find((condition) => condition.marker.index > index);
    const directiveEnd = ownCondition?.marker.index ?? containing.end;
    if (!COMPLETE_TIMING_INSTRUCTION_RE.test(source.slice(index, directiveEnd).trim())) return false;
    // Resolving the abbreviation only establishes that the fronted
    // instruction stands independent of it -- accepting that must not also
    // excuse a later hedge or negation that withdraws the timing
    // confirmation itself, wherever in the remaining response it lands.
    if (TECHNICIAN_DRY_TIMING_ALTERNATIVE_RE.test(source.slice(containing.end))) return false;
    // Either selected sentence interpretation retains the same source marker
    // and comma. Recognize its own following imperative without depending on
    // selectedBoundary, which is a casing heuristic rather than certainty.
    return Boolean(direct || [...evidence.conditions, ...instruction.conditions].some((condition) =>
      condition.marker.index === head && condition.end === comma && condition.end < index));
  });
}

// "wet" and "before it dries"/"before drying" both name the state the
// exemption explicitly excludes -- the opposite of already-dry -- even
// though SAFETY_DRYING_QUESTION_CIRCUMSTANCE_RE accepts their phrasing as
// belonging to the drying domain generally.
const SAFETY_PRE_DRY_CIRCUMSTANCE_RE = /\bwet\b|\bbefore\s+(?:(?:it|they)\s+)?(?:dr(?:y|ies)|drying)\b/i;

// The exemption only ever covers a dry-state condition. A question about a
// different circumstance -- an unrelated domain such as ingestion, or the
// explicitly opposite pre-dry/wet state -- is never qualified by "once
// dry", even once its audience and product both match.
function safetyOnceDryCoversQuestion(claim, drying, questionText, fullClaimClause, options) {
  return safetyAudienceCovers(`${claim[0]}${drying[0]}`, questionText)
    && safetyProductCovers(fullClaimClause, questionText, options)
    && safetyDryingCoversCircumstances(questionText)
    && !safetyCircumstanceScopes(questionText).some((circumstance) => SAFETY_PRE_DRY_CIRCUMSTANCE_RE.test(circumstance));
}

// Either side of the drying claim can defeat the exemption: an explicit
// wet-state withdrawal immediately coordinated onto it, or a banned fixed
// drying/re-entry figure hiding anywhere in the relevant response -- before
// the claim ("The treatment dries in 30 minutes. The bait is safe once
// dry.") reads the same prohibited promise as one placed after it.
function safetyOnceDryWithdrawnBy(text, dryingSuffix) {
  return SAFETY_COORDINATED_DRYING_WITHDRAWAL_RE.test(dryingSuffix) || SAFETY_FIXED_DRYING_FIGURE_RE.test(text);
}

function safetyOnceDryQualifies(text, claim, questionText = null, antecedentText = '', options = {}) {
  const evidence = localCandidateEvidence(text, 'drying-claim', claim.index, claim.index + claim[0].length);
  const claimClause = text.slice(evidence.clause.index, claim.index + claim[0].length);
  const fullClaimClause = safetyPropositionText(text, claim.index);
  if (evidence.sentence.ambiguousBoundaries.length
    || evidence.adjacentConnectives.some((entry) => !REDUCED_WHILE_BODY_RE.test(entry.body.text)
      || SAFETY_DRYING_CONDITION_WITHDRAWAL_RE.test(entry.text))
    || !SAFETY_ONCE_DRY_PREDICATE_RE.test(claim[0])
    || safetyGuaranteeIsInterrogative(text, claim)
    || SAFETY_DRYING_CONDITION_WITHDRAWAL_RE.test(fullClaimClause)
    || !safetyDryingCoversCircumstances(fullClaimClause)
    || SAFETY_REFERENTIAL_DRYING_WITHDRAWAL_RE.test(text)
    || PET_SPECULATIVE_GUIDANCE_RE.test(claimClause)
    || clauseIsEpistemicallyHedged(claimClause)) return false;
  const drying = SAFETY_ONCE_DRY_AFTER_RE.exec(text.slice(claim.index + claim[0].length));
  if (!drying
    || (questionText !== null && !safetyOnceDryCoversQuestion(claim, drying, questionText, fullClaimClause, options))) return false;
  const dryingSuffix = text.slice(claim.index + claim[0].length + drying[0].length);
  if (safetyOnceDryWithdrawnBy(text, dryingSuffix)) return false;
  const precedingClaimText = text.slice(0, claim.index);
  const precedingProductText = safetyProductScope(precedingClaimText, options).size
    ? precedingClaimText : antecedentText;
  const claimedProductText = questionText === null
    ? `${fullClaimClause} ${claim[0]}${drying[0]} ${safetyProductScope(fullClaimClause, options).size ? '' : precedingProductText}`
    : `${fullClaimClause} ${questionText}`;
  return [...text.matchAll(TECHNICIAN_DRY_TIMING_RE)].some((match) => {
    const timingEvidence = localCandidateEvidence(text, 'drying-timing', match.index, match.index + match[0].length);
    const timingClaimEnd = timingEvidence.clause.end;
    const timingClaim = text.slice(match.index, timingClaimEnd);
    const claim = text.slice(timingEvidence.clause.index, match.index + match[0].length);
    const suffix = text.slice(match.index + match[0].length);
    const productRestriction = /^\s*,?\s*(?:(?:but|and|however)\s+)?(?:not|only)\s+for\s+[^.!?;,]*/i.exec(suffix);
    const timingScope = text.slice(match.index, timingEvidence.sentence.end);
    const ambiguityResolved = timingAmbiguitySeparatesInstruction(text, timingEvidence, match.index + match[0].length);
    return ambiguityResolved && text[timingClaimEnd] !== '?' && !QUESTION_LEAD_RE.test(claim)
      && (TECHNICIAN_EXPLICIT_DRY_TIMING_RE.test(match[0])
        || !TECHNICIAN_VISIT_TIMING_RE.test(timingClaim)
        || (!TECHNICIAN_VISIT_TIMING_RE.test(match[0]) && TECHNICIAN_VISIT_TIMING_OBJECT_NEGATION_RE.test(suffix)))
      && (!PET_TRAILING_CONDITION_RE.test(suffix) || PET_INDEPENDENT_CONDITIONAL_ACTION_RE.test(suffix))
      && !TECHNICIAN_DRY_TIMING_ALTERNATIVE_RE.test(suffix)
      && !TECHNICIAN_DRY_TIMING_OBJECT_NEGATION_RE.test(suffix)
      && safetyProductDetailCovers(claimedProductText, `${timingClaim} ${productRestriction?.[0] || ''}`, options)
      && safetyTimingAudienceCovers(claimedProductText, timingScope)
      && !safetyAudienceExcluded(claimedProductText, timingScope)
      && !PET_SPECULATIVE_GUIDANCE_RE.test(claim)
      && !safetyTimingClaimIsWithdrawn(claim)
      && !timingEvidence.negations.some((token) => token.index < match.index + match[0].length
        && /^(?:neither|nor)$|nt$/i.test(token.text));
  });
}

const SAFETY_CLAUSE_CONTINUATION_RE = new RegExp(`^\\s*(?:that\\b|it['’]s\\b|it is\\b|that['’]s\\b|that is\\b|${SAFETY_ADJECTIVE}\\b|${HARM_ADJECTIVE}\\b)`, 'i');

// A restriction immediately after the comma ("safe, except for dogs") still
// belongs to the refusal that introduced it -- it has to survive into the
// exempt span so the audience/product exclusion checks (safetyAudienceExcluded,
// safetyProductExcludedFromRefusal) ever see it, rather than being cut off by
// the ordinary end-of-clause comma below.
const SAFETY_REFUSAL_RESTRICTION_RE = /^\s*(?:except(?:\s+for)?|other\s+than|apart\s+from|but\s+not|unless)\b/i;

const safetyClauseContinues = (before, after, boundary) => (/^,$/.test(boundary) && SAFETY_REFUSAL_RESTRICTION_RE.test(after))
  || (SAFETY_CLAUSE_CONTINUATION_RE.test(after)
    && (/^\s*(?:that|whether)?\s*$/i.test(before)
      || ((!/^,$/.test(boundary)
        || !/^[\s]*(?:it|that|this|they)(?:['’](?:s|re)|\s+(?:is|are|was|were))\b/i.test(after))
        && new RegExp(`\\b(?:${SAFETY_ADJECTIVE}|${HARM_ADJECTIVE}|risk|danger|harm)\\b`, 'i').test(before))));

const SAFETY_DRYING_CONDITION_WITHDRAWAL_RE = /\b(?:even\s+)?(?:before\s+(?:(?:it|they)\s+(?:dr(?:y|ies)|(?:is|are)\s+dry)|drying)|(?:if|while|when)\s+(?:(?:it|they)\s+(?:is|are)\s+|still\s+)?wet)\b/i;
const SAFETY_REFERENTIAL_DRYING_WITHDRAWAL_RE = /\b(?:that|this|it)\s+(?:also\s+)?(?:applies|holds|is true)\s+(?:even\s+)?(?:before\s+(?:(?:it|they)\s+(?:dr(?:y|ies)|(?:is|are)\s+dry)|drying)|(?:if|while|when)\s+(?:(?:it|they)\s+(?:is|are)\s+|still\s+)?wet)\b/i;

// A direct harm verb ("will harm dogs") reads as an affirmative harm claim
// with any named subject, not only a pronoun -- a refusal to confirm harm
// to a named product ("the bait will harm dogs") leaves the same preceding
// "Yes" unretracted as a pronoun subject would. The adjective branch must
// not fire on its own negation ("is not harmful" denies harm -- the same
// polarity as an ordinary safety refusal, not a harm claim to except out).
const SAFETY_HARM_SUBJECT = `(?:it|this|that|they|these|those|${SAFETY_SUBJECT_WITH_PRODUCT}|${SAFETY_BRAND_SUBJECT})`;
const SAFETY_REFUSED_AFFIRMATIVE_HARM_RE = new RegExp(
  `\\b${SAFETY_NON_PREFIX}(?<!\\bnot\\s)(?:${HARM_ADJECTIVE})\\b`
  + `|\\b${SAFETY_HARM_SUBJECT}\\s+(?:(?:will|would|can|could|may|might|does|do|did)\\s+|is going to\\s+)(?:hurt|harm|bother|affect|poison)\\b`
  // "causes harm"/"will cause harm" states the same affirmative harm claim
  // with "harm" (or "damage"/"problems") as the verb's object noun rather
  // than the verb itself.
  + `|\\b${SAFETY_HARM_SUBJECT}\\s+(?:(?:will|would|can|could|may|might)\\s+cause|causes|caused)\\s+(?:any\\s+)?(?:harm|damage|problems?)\\b`
  + `|\\b(?:not|never|no longer|(?:is|are)n['’]t)\\s+${SAFETY_INTENSIFIER}${SAFETY_ADJECTIVE}\\b`,
  'i',
);

// options.productNames can name the harm-verb subject too ("EcoGuard Wonder
// will harm dogs") -- without this, a live-only product falls through to no
// branch at all, so its harm refusal is missed and wrongly retracts the
// preceding "Yes" like a genuine safety refusal would.
function safetyRefusedAffirmativeHarmRe(options = {}) {
  const dynamicIdentity = dynamicIdentityFor(options.productNames);
  return dynamicIdentity
    ? new RegExp(`${SAFETY_REFUSED_AFFIRMATIVE_HARM_RE.source}`
      + `|\\b(?:${dynamicIdentity.brandSubject})\\s+(?:(?:will|would|can|could|may|might|does|do|did)\\s+|is going to\\s+)(?:hurt|harm|bother|affect|poison)\\b`, 'i')
    : SAFETY_REFUSED_AFFIRMATIVE_HARM_RE;
}

// Every restriction connector SAFETY_REFUSAL_RESTRICTION_RE keeps inside
// the exempt span ("except for", "other than", "apart from", "but not",
// "unless") names an excluded audience just as much as "not for"/"except
// for" already do -- each optionally takes its own "for" before the
// audience ("other than for dogs"), so that optional "for" is folded into
// the connector rather than required a second time by the shared suffix.
const SAFETY_AUDIENCE_EXCLUSION_RE = new RegExp(`\\b(?:not\\s+(?:(?:the|your|our)\\s+)?(?:precautions?|guidance|review)\\s+for|not\\s+for|except(?:\\s+for)?|excluding|other\\s+than(?:\\s+for)?|apart\\s+from(?:\\s+for)?|but\\s+not(?:\\s+for)?|unless(?:\\s+for)?)\\s+${SAFETY_AUDIENCE}\\b`, 'gi');

const SAFETY_TRAILING_AUDIENCE_RE = new RegExp(
  `^\\s*(?:and|or)\\s+${SAFETY_AUDIENCE}\\b(?=\\s*(?:[.!?;,:—–]|$))`,
  'i',
);

const SAFETY_TRAILING_PRODUCT_SCOPE_RE = new RegExp(
  `^\\s*(?:and|or)\\s+(?:(?:this|that|the|our|your|these|those)\\s+)?${SAFETY_SUBJECT_MODIFIER}[^.!?;,]{0,80}\\b(?:${SAFETY_ADJECTIVE}|${HARM_ADJECTIVE}|${SAFETY_HARM_VERB})\\b[^.!?;,]*`,
  'i',
);

function safetyAudienceCovers(claimText, questionText) {
  const questionScopes = safetyAudienceScopes(questionText);
  const claimScopes = safetyAudienceScopes(claimText);
  if (!claimScopes.size) return true;
  if (!questionScopes.size) return false;
  return [...questionScopes].every((scope) => claimScopes.has(scope)
    || (claimScopes.has('pet') && /^(?:dog|cat|pet)$/.test(scope))
    || (claimScopes.has('animal') && /^(?:dog|cat|pet|animal)$/.test(scope))
    || (claimScopes.has('human') && /^(?:human|child)$/.test(scope))
    // A refusal about the family covers a question about its children --
    // the reverse does not hold, so a child/baby-only refusal never covers
    // a question about the whole family.
    || (claimScopes.has('family') && /^(?:human|child|family)$/.test(scope)));
}

function safetyAudienceExcluded(claimText, detailText) {
  const claimScopes = safetyAudienceScopes(claimText);
  return [...detailText.matchAll(SAFETY_AUDIENCE_EXCLUSION_RE)]
    .some((exclusion) => {
      if (!claimScopes.size) return true;
      const excludedText = exclusion[0]
        .replace(/^(?:not\b.*?\bfor|except(?:\s+for)?|excluding|other\s+than(?:\s+for)?|apart\s+from(?:\s+for)?|but\s+not(?:\s+for)?|unless(?:\s+for)?)\s+/i, 'for ');
      return [...claimScopes].some((scope) => {
        const claimedText = `for ${scope === 'child' ? 'children' : scope}`;
        return safetyAudienceCovers(excludedText, claimedText)
          || safetyAudienceCovers(claimedText, excludedText);
      });
    });
}

function safetyProductCovers(claimText, questionText, options = {}) {
  const questionedProducts = safetyProductScope(questionText, options);
  const claimedProducts = safetyProductScope(claimText, options);
  // A generic product scope ("any other product") covers the whole class
  // and stands alongside any named product the question also names ("the
  // bait or any other product") -- it is never satisfied merely because
  // that named subset happens to be nonempty, so this checks claimText's
  // own genericness rather than gating on questionedProducts being empty.
  if (claimedProducts.size && SAFETY_GENERIC_PRODUCT_RE.test(questionText)
    && !SAFETY_GENERIC_PRODUCT_RE.test(claimText)) return false;
  return !questionedProducts.size || !claimedProducts.size
    || [...questionedProducts].every((product) => claimedProducts.has(product));
}

const SAFETY_PRODUCT_EXCLUSION_RE = /\b(?:not(?!\s+only\b)|except(?:\s+for)?|excluding)\b[^,.!?;—–]*/gi;
// The generic-scope vocabulary is the subset of SAFETY_SUBJECT_MODIFIER
// that names product material generically ("materials", "applications")
// rather than a specific product, pest, or treated site ("bait", "roach",
// "yards") -- filtered against that import, not retyped as an independent
// list, so a word dropped or renamed there cannot silently fall out of
// sync with what the response recognizer itself treats as generic.
const SAFETY_GENERIC_PRODUCT_WORDS = ['pesticides?', 'products?', 'treatments?', 'chemicals?', 'materials?', 'applications?', 'stuff'];
const SAFETY_GENERIC_PRODUCT_RE = new RegExp(`\\b(?:${SAFETY_GENERIC_PRODUCT_WORDS.filter((word) => SAFETY_SUBJECT_MODIFIER.includes(word)).join('|')})\\b`, 'i');

function safetyProductDetailCovers(claimText, detailText, options = {}) {
  const claimedProducts = safetyProductScope(claimText, options);
  const mentionedProducts = safetyProductScope(detailText, options);
  if ([...detailText.matchAll(SAFETY_PRODUCT_EXCLUSION_RE)]
    .some((exclusion) => SAFETY_GENERIC_PRODUCT_RE.test(exclusion[0]))) return false;
  if (!mentionedProducts.size) return true;
  if (!claimedProducts.size && SAFETY_GENERIC_PRODUCT_RE.test(claimText)) return false;
  for (const exclusion of detailText.matchAll(SAFETY_PRODUCT_EXCLUSION_RE)) {
    for (const product of safetyProductScope(exclusion[0], options)) mentionedProducts.delete(product);
  }
  return [...claimedProducts].every((product) => mentionedProducts.has(product));
}

function safetyProductExcludedFromRefusal(questionText, refusal, options = {}) {
  const questionedProducts = safetyProductScope(questionText, options);
  return [...refusal.matchAll(SAFETY_PRODUCT_EXCLUSION_RE)]
    .some((exclusion) => [...safetyProductScope(exclusion[0], options)]
      .some((product) => questionedProducts.has(product)));
}

function safetyRefusalCoversCircumstances(questionText, refusal, refusalEvidence = safetyScopeEvidence(refusal), source = refusal) {
  const questionEvidence = safetyScopeEvidence(questionText);
  if ([questionEvidence, refusalEvidence].some((evidence) => evidence &&
    (evidence.sentence.ambiguousBoundaries.length
      || evidence.adjacentConnectives.some((entry) => !REDUCED_WHILE_BODY_RE.test(entry.body.text))))) return false;
  const questionedCircumstances = safetyCircumstanceScopes(questionText);
  return safetyCircumstanceScopes(source, refusalEvidence).every((condition) => questionedCircumstances.includes(condition));
}

const SAFETY_DRYING_QUESTION_CIRCUMSTANCE_RE = /^(?:if|when|while|before|after)\s+(?:(?:it|they)\s+)?(?:still\s+)?(?:dry|wet|dries|drying)$/i;

function safetyDryingCoversEvidence(source, evidence) {
  return !evidence.sentence.ambiguousBoundaries.length
    && evidence.adjacentConnectives.every((entry) => REDUCED_WHILE_BODY_RE.test(entry.body.text))
    && safetyCircumstanceScopes(source, evidence).every((circumstance) => SAFETY_DRYING_QUESTION_CIRCUMSTANCE_RE.test(circumstance));
}

function safetyDryingCoversCircumstances(propositionText) {
  // A conversation consumer may combine several source propositions. Inspect
  // each sentence separately so one drying clause cannot hide a later
  // elliptical ingestion answer. Never transfer conditions across sentences.
  return sentenceSourceSpans(propositionText).filter((span) => span.text.trim()).every((span) => {
    const predicate = SAFETY_REFUSED_CLAIM_RE.exec(span.text);
    const evidence = predicate ? safetyScopeEvidence(span.text)
      : localCandidateEvidence(span.text, 'drying-scope', 0, 0);
    return !span.ambiguousBoundaries.length && safetyDryingCoversEvidence(span.text, evidence);
  });
}

// A disjunctive question ("when dry or if swallowed") names more than one
// circumstance; retracting its guarantee needs every alternative addressed,
// not just any one of them appearing in some refusal. An unconditional
// refusal (no circumstance of its own -- the ordinary pronoun-refusal case)
// already addresses every alternative, exactly as it does for a
// non-disjunctive question.
function safetyCircumstancesCollectivelyCovered(questionText, refusals) {
  const questionedCircumstances = safetyCircumstanceScopes(questionText);
  if (!questionedCircumstances.length || refusals.some((refusal) => !safetyCircumstanceScopes(refusal).length)) return true;
  const coveredCircumstances = new Set(refusals.flatMap((refusal) => safetyCircumstanceScopes(refusal)));
  return questionedCircumstances.every((circumstance) => coveredCircumstances.has(circumstance));
}

// A coordinator can join two complete propositions ("the bait safe for
// dogs and the spray safe for cats") instead of one shared subject ("the
// bait and spray safe") or a plain audience list ("safe for dogs and
// cats"); only when EVERY resulting piece names its own product AND its
// own audience does the split represent genuinely paired propositions --
// a shared subject or an audience list always leaves at least one piece
// bare on one axis and stays a single proposition, exactly as before.
const SAFETY_PROPOSITION_COORDINATOR_RE = /\s+(?:and|or)\s+/i;

function safetyScopedPropositions(text, options = {}) {
  const pieces = text.split(SAFETY_PROPOSITION_COORDINATOR_RE);
  if (pieces.length < 2) return [text];
  // A piece with no product of its own ("children", after "dogs and") is
  // an audience-list member of the proposition before it, not a fresh
  // proposition ("the spray safe for cats") that happens to follow it --
  // an audience-list coordinator must not be read as a proposition
  // boundary just because a blind split lands on it.
  const propositions = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 1) {
    if (safetyProductScope(pieces[i], options).size) propositions.push(pieces[i]);
    else propositions[propositions.length - 1] += ` and ${pieces[i]}`;
  }
  return propositions.length > 1
    && propositions.every((piece) => safetyProductScope(piece, options).size && safetyAudienceScopes(piece).size)
    ? propositions : [text];
}

// Aggregating audience scopes and product scopes separately (as the checks
// below this still do, for the ordinary single-proposition case) loses
// which refusal answered which questioned pairing: "I cannot confirm the
// bait is safe for cats. I cannot confirm the spray is safe for dogs."
// would otherwise look like it covers "bait for dogs and spray for cats"
// simply because the union of products and the union of audiences each
// happen to match. Only a genuinely multi-proposition question (see
// safetyScopedPropositions) needs this: each such proposition must have
// its OWN refusal whose product and audience both cover it -- a single
// undifferentiated proposition keeps relying on the join-based checks,
// which already allow several refusals to jointly cover one product's
// compound audience.
function safetyProductAudiencePairsCovered(questionText, refusals, options = {}) {
  const propositions = safetyScopedPropositions(questionText, options);
  return propositions.length === 1 || propositions.every((proposition) => refusals.some((refusal) =>
    safetyProductCovers(refusal, proposition, options) && safetyAudienceCovers(refusal, proposition)));
}

function refusesSafetyGuarantee(text, questionText, afterIndex = -1, options = {}) {
  const affirmativeHarmRe = safetyRefusedAffirmativeHarmRe(options);
  const refusals = safetyExemptSpans(text).flatMap(([start, end]) => {
    if (start <= afterIndex) return [];
    const refusalEvidence = localCandidateEvidence(text, 'refused-scope', start, end);
    const suffix = text.slice(end);
    const trailingProduct = SAFETY_REFUSED_CLAIM_RE.test(text.slice(start, end))
      ? null : SAFETY_TRAILING_PRODUCT_SCOPE_RE.exec(suffix);
    const productEnd = trailingProduct ? end + trailingProduct[0].length : end;
    const trailingAudience = SAFETY_TRAILING_AUDIENCE_RE.exec(text.slice(productEnd));
    const refusal = text.slice(start, trailingAudience ? productEnd + trailingAudience[0].length : productEnd);
    if (!SAFETY_REFUSED_CLAIM_RE.test(refusal)) return [];
    // Refusing to confirm an affirmative harm claim does not withdraw a
    // preceding safety guarantee: "Yes. I cannot confirm whether it will
    // harm dogs" still contains the unqualified "Yes". Audience and
    // circumstance coverage are judged below, across every accepted
    // refusal together -- a partial refusal ("...safe for dogs.") must not
    // be discarded here just because it alone doesn't cover the whole
    // question; see safetyCircumstancesCollectivelyCovered and the
    // audience check below it.
    if (affirmativeHarmRe.test(refusal)
      || safetyAudienceExcluded(questionText, refusal)
      || !safetyRefusalCoversCircumstances(questionText, refusal, refusalEvidence, text)
      || safetyProductExcludedFromRefusal(questionText, refusal, options)) return [];
    return [refusal];
  });
  if (!refusals.length
    || !safetyCircumstancesCollectivelyCovered(questionText, refusals)
    || !safetyAudienceCovers(refusals.join(' '), questionText)
    || !safetyProductAudiencePairsCovered(questionText, refusals, options)) return false;
  // An unscoped refusal ("I cannot confirm whether it is safe") resolves its
  // pronoun to the question's own product only when every accepted refusal
  // is equally unscoped and the question names at most one product -- with
  // one questioned product every pronoun has the same unambiguous
  // antecedent regardless of how many refusals repeat it, but several
  // unresolved pronouns can never collectively pick out more than one
  // product, so they must not retract a guarantee over several. Once any
  // refusal in the response has named an explicit product, an unscoped
  // follow-up must not be read as blanket coverage of every product asked
  // about either; safetyProductCovers below still requires it to name what
  // it covers.
  // A plural pronoun ("they are safe", "both", "all of them") is the one
  // unscoped form that does pick out every questioned product at once, so
  // it keeps covering a multi-product question (approved corpus rows).
  const refusalsAllUnscoped = refusals.every((refusal) => !safetyProductScope(refusal, options).size);
  const pluralRefusal = refusals.some((refusal) => SAFETY_PLURAL_PRONOUN_REFUSAL_RE.test(refusal));
  return (refusalsAllUnscoped && (pluralRefusal || safetyProductScope(questionText, options).size <= 1))
    || (!refusalsAllUnscoped && safetyProductCovers(refusals.join(' '), questionText, options));
}

const SAFETY_PLURAL_PRONOUN_REFUSAL_RE = /\b(?:they|these|those|both(?:\s+of\s+them)?|all\s+of\s+them|either(?:\s+of\s+them)?|neither(?:\s+of\s+them)?)\b/i;

const PET_SPECULATIVE_GUIDANCE_RE = /\b(?:might|may|could|would|should|maybe|perhaps|possibly|potentially|think|believe|hope[sd]?|refuse[sd]?|decline[sd]?|failed|unable)\b/i;

const PET_CONDITION = '(?:(?:only\\s+)?if|unless|except(?:\\s+when)?|only\\s+when|when\\s+(?:asked|requested|convenient)|only\\s+on\\s+request|only\\s+after\\s+you\\s+(?:ask|request)|provided(?:\\s+that)?|as\\s+long\\s+as)';

const PET_TRAILING_CONDITION_RE = new RegExp(`^(?:(?!\\b(?:and|or|but|however|then|so)\\b(?!\\s+(?:(?:not\\s+)?${PET_CONDITION})\\b))[^.!?;—–])*?\\b${PET_CONDITION}\\b`, 'i');

const PET_INDEPENDENT_CONDITIONAL_ACTION_RE = new RegExp(`^\\s*,?\\s*(?:and|or|but)\\s+${PET_CONDITION}\\b[^,.!?;—–]{0,60},\\s*(?:(?:they|you|the technician|the team member)\\s+)?(?:can|will|may|could|would|should|review|explain|answer|check|verify|go over|talk)\\b`, 'i');

module.exports = {
  safetyAudienceScopes, safetyProductScope, safetyScopeEvidence, safetyCircumstanceScopes,
  safetyPropositionText, safetyGuaranteeIsInterrogative, safetyExemptSpans,
  safetyOnceDryQualifies, safetyAudienceCovers, safetyAudienceExcluded,
  safetyProductCovers, safetyProductDetailCovers, safetyProductExcludedFromRefusal,
  safetyRefusalCoversCircumstances, safetyDryingCoversCircumstances, safetyDryingCoversEvidence, refusesSafetyGuarantee,
  TECHNICIAN_DRY_TIMING_RE, TECHNICIAN_DRY_TIMING_ALTERNATIVE_RE, COMPLETE_TIMING_INSTRUCTION_RE,
  SAFETY_GENERIC_PRODUCT_RE, SAFETY_DRYING_CONDITION_WITHDRAWAL_RE,
  SAFETY_REFERENTIAL_DRYING_WITHDRAWAL_RE,
};
