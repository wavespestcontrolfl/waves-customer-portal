// Scope/refusal/drying policy only. Conversation adjudication is intentionally
// unregistered until the next split consumes these source-backed helpers.
const {
  EPISTEMIC_HEDGE_PREFIX_SOURCE, CONVERSATIONAL_CONDITION_RE, QUESTION_LEAD_RE,
  clauseIsNegated, clauseIsEpistemicallyHedged,
} = require('./voice-relay-spoken-language');
const { localCandidateEvidence, sentenceSourceSpans, latestInterrogativeSpan } = require('./voice-relay-source-evidence');
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

const SAFETY_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:for|around|with)\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

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

function safetyBrandMentionMembers(text) {
  const parts = text.split(SAFETY_BRAND_COORDINATOR_RE).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((part) => SAFETY_BRAND_MENTION_ANCHORED_RE.test(part))
    ? parts : [text];
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
      for (const member of safetyBrandMentionMembers(match[0])) {
        scopes.add(`brand:${member.toLowerCase().replace(/\s+/g, ' ')}`);
      }
    }
  }
  return scopes;
}

// Question evidence already crops fronted ASR conditions at their actual
// auxiliary. Otherwise attach scope to the first local lexical predicate.
function safetyScopeEvidence(text) {
  const predicate = SAFETY_REFUSED_CLAIM_RE.exec(text);
  if (!predicate) return null;
  const evidence = localCandidateEvidence(text, 'scope', predicate.index, predicate.index + predicate[0].length);
  const question = recognizeSafetyQuestion(evidence.sentence.text);
  const selected = question.positive || question.harm;
  // Re-recognize against the complete source to retain exact offsets only
  // when its selected question belongs to this same source sentence.
  const original = recognizeSafetyQuestion(text);
  const candidate = original.positive || original.harm;
  return selected && candidate?.evidence.sentence.index === evidence.sentence.index
    ? candidate.evidence : evidence;
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
      .replace(/\b(?:it|they)\s+(?:is|are|was|were)\s+/g, '').replace(/\s+/g, ' ').trim());
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
  // A coordinated candidate ("safe and the spray") can end its clause
  // before the sentence's own terminator; the enclosing sentence bound is
  // what actually carries the question mark for an auxiliary-led question.
  return (text[evidence.sentence.end] === '?' && (QUESTION_LEAD_RE.test(context) || (!prefix.trim() && !assertionTag)))
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

const TECHNICIAN_DRY_TIMING_RE = new RegExp(
  `\\b(?:the |your |our |a )?${SAFETY_STAFF_ROLE}\\b[^.!?;]{0,30}?\\b(?:(?:will|can|is going to)\\s+(?:confirm|verify|check)|(?:confirms|verifies|checks))\\b[^.!?;]{0,30}?\\b(?:timing|drying(?: time)?|re-?entry(?: time| timing)?|when\\b[^.!?;]{0,16}\\bdry)\\b`,
  'gi',
);
const TECHNICIAN_EXPLICIT_DRY_TIMING_RE = /\b(?:drying(?: time)?|re-?entry(?: time| timing)?|when\b[^.!?;]{0,16}\bdry)\s*$/i;
// A named fixed interval ("dries in 30 minutes", "safe after two hours",
// "re-enter in 4 hours") is a banned specific figure even when it rides
// alongside the sanctioned "safe once dry" idiom; it must defeat the
// exemption rather than hide behind it.
const SAFETY_FIXED_DRYING_FIGURE_RE = /\b(?:dr(?:y|ies|ying)|re-?enter(?:s|ing)?|re-?entry|safe|ready)\b[^.!?;]{0,30}?\b(?:in|after|within)\s+(?:about\s+)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty(?:-five)?|fifty|sixty)\s*(?:minutes?|mins?|hours?|hrs?)\b/i;
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

function safetyTimingAudienceCovers(claimText, timingText) {
  const positiveTimingText = timingText.replace(SAFETY_AUDIENCE_EXCLUSION_RE, '');
  return !safetyAudienceScopes(positiveTimingText).size
    || safetyAudienceCovers(positiveTimingText, claimText);
}

// The exemption only ever covers a dry-state condition. A question about a
// different circumstance -- an unrelated domain such as ingestion, or the
// explicitly opposite wet state -- is never qualified by "once dry", even
// once its audience and product both match.
function safetyOnceDryCoversQuestion(claim, drying, questionText, fullClaimClause, options) {
  return safetyAudienceCovers(`${claim[0]}${drying[0]}`, questionText)
    && safetyProductCovers(fullClaimClause, questionText, options)
    && safetyDryingCoversCircumstances(questionText)
    && !safetyCircumstanceScopes(questionText).some((circumstance) => /\bwet\b/i.test(circumstance));
}

// What follows the drying claim can still defeat the exemption: an explicit
// wet-state withdrawal, or a banned fixed drying/re-entry figure hiding
// behind the otherwise-approved idiom.
function safetyOnceDryWithdrawnBy(dryingSuffix) {
  return SAFETY_COORDINATED_DRYING_WITHDRAWAL_RE.test(dryingSuffix) || SAFETY_FIXED_DRYING_FIGURE_RE.test(dryingSuffix);
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
  if (safetyOnceDryWithdrawnBy(dryingSuffix)) return false;
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
    return !timingEvidence.sentence.ambiguousBoundaries.length && text[timingClaimEnd] !== '?' && !QUESTION_LEAD_RE.test(claim)
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
      && !clauseIsNegated(claim) && !clauseIsEpistemicallyHedged(claim)
      && !timingEvidence.negations.some((token) => token.index < match.index + match[0].length
        && /^(?:neither|nor)$|nt$/i.test(token.text));
  });
}

const SAFETY_CLAUSE_CONTINUATION_RE = new RegExp(`^\\s*(?:that\\b|it['’]s\\b|it is\\b|that['’]s\\b|that is\\b|${SAFETY_ADJECTIVE}\\b|${HARM_ADJECTIVE}\\b)`, 'i');

const safetyClauseContinues = (before, after, boundary) => SAFETY_CLAUSE_CONTINUATION_RE.test(after)
  && (/^\s*(?:that|whether)?\s*$/i.test(before)
    || ((!/^,$/.test(boundary)
      || !/^[\s]*(?:it|that|this|they)(?:['’](?:s|re)|\s+(?:is|are|was|were))\b/i.test(after))
      && new RegExp(`\\b(?:${SAFETY_ADJECTIVE}|${HARM_ADJECTIVE}|risk|danger|harm)\\b`, 'i').test(before)));

const SAFETY_DRYING_CONDITION_WITHDRAWAL_RE = /\b(?:even\s+)?(?:before\s+(?:(?:it|they)\s+(?:dr(?:y|ies)|(?:is|are)\s+dry)|drying)|(?:if|while|when)\s+(?:(?:it|they)\s+(?:is|are)\s+|still\s+)?wet)\b/i;
const SAFETY_REFERENTIAL_DRYING_WITHDRAWAL_RE = /\b(?:that|this|it)\s+(?:also\s+)?(?:applies|holds|is true)\s+(?:even\s+)?(?:before\s+(?:(?:it|they)\s+(?:dr(?:y|ies)|(?:is|are)\s+dry)|drying)|(?:if|while|when)\s+(?:(?:it|they)\s+(?:is|are)\s+|still\s+)?wet)\b/i;

// A direct harm verb ("will harm dogs") reads as an affirmative harm claim
// with any named subject, not only a pronoun -- a refusal to confirm harm
// to a named product ("the bait will harm dogs") leaves the same preceding
// "Yes" unretracted as a pronoun subject would. The adjective branch must
// not fire on its own negation ("is not harmful" denies harm -- the same
// polarity as an ordinary safety refusal, not a harm claim to except out).
const SAFETY_REFUSED_AFFIRMATIVE_HARM_RE = new RegExp(
  `\\b${SAFETY_NON_PREFIX}(?<!\\bnot\\s)(?:${HARM_ADJECTIVE})\\b`
  + `|\\b(?:it|this|that|they|these|those|${SAFETY_SUBJECT_WITH_PRODUCT}|${SAFETY_BRAND_SUBJECT})\\s+(?:(?:will|would|can|could|may|might|does|do|did)\\s+|is going to\\s+)(?:hurt|harm|bother|affect|poison)\\b`
  + `|\\b(?:not|never|no longer|(?:is|are)n['’]t)\\s+${SAFETY_INTENSIFIER}${SAFETY_ADJECTIVE}\\b`,
  'i',
);

const SAFETY_AUDIENCE_EXCLUSION_RE = new RegExp(`\\b(?:not\\s+(?:(?:the|your|our)\\s+)?(?:precautions?|guidance|review)\\s+for|not\\s+for|except(?:\\s+for)?|excluding)\\s+${SAFETY_AUDIENCE}\\b`, 'gi');

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
    || (claimScopes.has('human') && /^(?:human|child)$/.test(scope)));
}

function safetyAudienceExcluded(claimText, detailText) {
  const claimScopes = safetyAudienceScopes(claimText);
  return [...detailText.matchAll(SAFETY_AUDIENCE_EXCLUSION_RE)]
    .some((exclusion) => {
      if (!claimScopes.size) return true;
      const excludedText = exclusion[0].replace(/^(?:not\b.*?\bfor|except(?:\s+for)?|excluding)\s+/i, 'for ');
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
  // A generic product scope covers the whole class, not an absent subject.
  // A named subset cannot qualify an assurance about that broader class.
  if (!questionedProducts.size && SAFETY_GENERIC_PRODUCT_RE.test(questionText)
    && claimedProducts.size) return false;
  return !questionedProducts.size || !claimedProducts.size
    || [...questionedProducts].every((product) => claimedProducts.has(product));
}

const SAFETY_PRODUCT_EXCLUSION_RE = /\b(?:not(?!\s+only\b)|except(?:\s+for)?|excluding)\b[^,.!?;—–]*/gi;
const SAFETY_GENERIC_PRODUCT_RE = /\b(?:pesticides?|products?|treatments?|chemicals?)\b/i;

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

function safetyDryingCoversCircumstances(propositionText) {
  // A conversation consumer may combine several source propositions. Inspect
  // each sentence separately so one drying clause cannot hide a later
  // elliptical ingestion answer. Never transfer conditions across sentences.
  return sentenceSourceSpans(propositionText).filter((span) => span.text.trim()).every((span) => {
    const predicate = SAFETY_REFUSED_CLAIM_RE.exec(span.text);
    const evidence = predicate ? safetyScopeEvidence(span.text)
      : localCandidateEvidence(span.text, 'drying-scope', 0, 0);
    const scopes = safetyCircumstanceScopes(span.text, evidence);
    return !span.ambiguousBoundaries.length && !evidence.sentence.ambiguousBoundaries.length
      && evidence.adjacentConnectives.every((entry) => REDUCED_WHILE_BODY_RE.test(entry.body.text))
      && scopes.every((circumstance) => SAFETY_DRYING_QUESTION_CIRCUMSTANCE_RE.test(circumstance));
  });
}

function refusesSafetyGuarantee(text, questionText, afterIndex = -1, options = {}) {
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
    // harm dogs" still contains the unqualified "Yes".
    if (SAFETY_REFUSED_AFFIRMATIVE_HARM_RE.test(refusal)
      || !safetyAudienceCovers(refusal, questionText)
      || safetyAudienceExcluded(questionText, refusal)
      || !safetyRefusalCoversCircumstances(questionText, refusal, refusalEvidence, text)
      || safetyProductExcludedFromRefusal(questionText, refusal, options)) return [];
    return [refusal];
  });
  if (!refusals.length) return false;
  return refusals.some((refusal) => !safetyProductScope(refusal, options).size)
    || safetyProductCovers(refusals.join(' '), questionText, options);
}

const PET_SPECULATIVE_GUIDANCE_RE = /\b(?:might|may|could|would|should|maybe|perhaps|possibly|potentially|think|believe|hope[sd]?|refuse[sd]?|decline[sd]?|failed|unable)\b/i;

const PET_CONDITION = '(?:(?:only\\s+)?if|unless|only\\s+when|when\\s+(?:asked|requested)|only\\s+on\\s+request|only\\s+after\\s+you\\s+(?:ask|request)|provided(?:\\s+that)?|as\\s+long\\s+as)';

const PET_TRAILING_CONDITION_RE = new RegExp(`^(?:(?!\\b(?:and|or|but|however|then|so)\\b(?!\\s+(?:(?:not\\s+)?${PET_CONDITION})\\b))[^.!?;—–])*?\\b${PET_CONDITION}\\b`, 'i');

const PET_INDEPENDENT_CONDITIONAL_ACTION_RE = new RegExp(`^\\s*,?\\s*(?:and|or|but)\\s+${PET_CONDITION}\\b[^,.!?;—–]{0,60},\\s*(?:(?:they|you|the technician|the team member)\\s+)?(?:can|will|may|could|would|should|review|explain|answer|check|verify|go over|talk)\\b`, 'i');

module.exports = {
  safetyAudienceScopes, safetyProductScope, safetyScopeEvidence, safetyCircumstanceScopes,
  safetyPropositionText, safetyGuaranteeIsInterrogative, safetyExemptSpans,
  safetyOnceDryQualifies, safetyAudienceCovers, safetyAudienceExcluded,
  safetyProductCovers, safetyProductDetailCovers, safetyProductExcludedFromRefusal,
  safetyRefusalCoversCircumstances, safetyDryingCoversCircumstances, refusesSafetyGuarantee,
  SAFETY_GENERIC_PRODUCT_RE, SAFETY_DRYING_CONDITION_WITHDRAWAL_RE,
  SAFETY_REFERENTIAL_DRYING_WITHDRAWAL_RE,
};
