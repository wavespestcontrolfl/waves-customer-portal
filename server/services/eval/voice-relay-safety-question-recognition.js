// Source-backed lexical questions. Polarity and antecedent evidence remain
// separate from the policy that decides whether an answer guarantees safety.
const { QUESTION_AUX_RE_SOURCE, QUESTION_AUX_WH_RE_SOURCE } = require('./voice-relay-spoken-language');
const {
  sourceSpan, sentenceSourceSpans, latestInterrogativeSpan, localCandidateEvidence, lexicalSourceSpans,
} = require('./voice-relay-source-evidence');
const {
  SAFETY_SUBJECT_MODIFIER, SAFETY_SUBJECT_WITH_PRODUCT, SAFETY_SUBJECT_VERB,
  SAFETY_BRAND_SUBJECT, SAFETY_BRAND_IDENTITY_RE, SAFETY_BRAND_MENTION_RE,
  SAFETY_AUDIENCE_SUBJECT, SAFETY_AUDIENCE_PRODUCT_RELATION, SAFETY_AUDIENCE_MENTION_RE,
  SAFETY_ADJECTIVE, HARM_ADJECTIVE, SAFETY_HARM_VERB, safetyNamesProduct,
} = require('./voice-relay-safety-response-recognition');

const SAFETY_QUESTION_PRODUCT_SUBJECT_RE = `(?:(?:this|that|the|our|your|these|those)\\s+)?(?:${SAFETY_SUBJECT_MODIFIER}\\s+){1,3}`;

const SAFETY_QUESTION_PRONOUN_RE = '(?:it|that|they|this|these|those)\\b';

const SAFETY_QUESTION_NEGATIVE_AUXILIARY = `(?:isn|aren|wasn|weren|doesn|don|didn|wouldn|won|can|couldn|shouldn|shan|mayn|mightn|mustn|hasn|haven|hadn)[\\x27\\u2019]t`;

const SAFETY_QUESTION_AUXILIARY = `(?:${SAFETY_QUESTION_NEGATIVE_AUXILIARY}|${QUESTION_AUX_RE_SOURCE})`;

const SAFETY_QUESTION_BRIDGE = `(?:[^.!?;]{0,20}?|\\s+you\\s+(?:(?:please\\s+)?tell\\s+me|(?:happen\\s+to\\s+)?know|let\\s+me\\s+know|check|confirm)\\s+(?:whether|if)\\s+)`;

const SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE = new RegExp(`^${SAFETY_QUESTION_NEGATIVE_AUXILIARY}\\b`, 'i');

const SAFETY_DECLARATIVE_TAG_RE = /(?:,\s*|\s+)(?:right|ok(?:ay)?|correct|yes|isn['’]t it|aren['’]t they|doesn['’]t it|don['’]t they)\s*\??$/i;

const SAFETY_DECLARATIVE_PRODUCT_SUBJECT_RE = new RegExp(`^(?:${SAFETY_SUBJECT_WITH_PRODUCT})$`, 'i');

const SAFETY_DECLARATIVE_AUDIENCE_SUBJECT_RE = new RegExp(`^(?:${SAFETY_AUDIENCE_SUBJECT})$`, 'i');

const SAFETY_DECLARATIVE_PRONOUN_SUBJECT_RE = new RegExp(`^(?:${SAFETY_QUESTION_PRONOUN_RE})$`, 'i');

function declarativeSafetyTagCandidate(source, text, keywordAlt, questionOffset) {
  const tag = SAFETY_DECLARATIVE_TAG_RE.exec(text);
  if (!tag) return null;
  const assertion = text.slice(0, tag.index);
  // Without a comma, the final adjective may complete a condition rather
  // than be a tag: 'safe if the schedule is correct' has no completed
  // assertion before 'correct'.
  if (!tag[0].startsWith(',') && /\b(?:is|are|was|were|has|have|had|will|would|should|can|could|does|do|did)\s*$/i.test(assertion)) return null;
  const declarative = new RegExp(`\\b(${SAFETY_SUBJECT_WITH_PRODUCT}|${SAFETY_BRAND_SUBJECT}|${SAFETY_QUESTION_PRONOUN_RE}|${SAFETY_AUDIENCE_SUBJECT})${SAFETY_SUBJECT_VERB}\\s+([^.!?;]{0,80}?\\b(?:${keywordAlt})\\b)[^.!?;]{0,60}$`, 'i');
  const match = declarative.exec(assertion);
  if (!match) return null;
  const pronoun = SAFETY_DECLARATIVE_PRONOUN_SUBJECT_RE.test(match[1]);
  const audience = SAFETY_DECLARATIVE_AUDIENCE_SUBJECT_RE.test(match[1]);
  if (audience && !(new RegExp(SAFETY_AUDIENCE_PRODUCT_RELATION, 'i').test(match[0]) && safetyNamesProduct(match[0]))) return null;
  if (!pronoun && !audience && !SAFETY_DECLARATIVE_PRODUCT_SUBJECT_RE.test(match[1]) && !SAFETY_BRAND_IDENTITY_RE.test(match[1])) return null;
  return {
    predicate: match[2],
    evidence: questionSourceEvidence(source, match, questionOffset),
    // The tag asks to confirm the assertion; its negative auxiliary does
    // not negate the safety predicate in the assertion itself.
    negatedAuxiliary: false,
    ...(pronoun ? {
      requiresProductAntecedent: !safetyNamesProduct(assertion),
      index: questionOffset + match.index,
      localAntecedent: source.slice(0, questionOffset + match.index),
    } : {}),
  };
}

function questionAboutProduct(source, text, keywordAlt, questionOffset) {
  const tagged = declarativeSafetyTagCandidate(source, text, keywordAlt, questionOffset);
  if (tagged) return tagged;
  const productSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}\\b${SAFETY_QUESTION_PRODUCT_SUBJECT_RE}([^.!?;]{0,80}?\\b(?:${keywordAlt})\\b)[^.!?;]{0,60}?(?:[?.]|$)`, 'i');
  const productMatch = productSubject.exec(text);
  if (productMatch) return { evidence: questionSourceEvidence(source, productMatch, questionOffset), predicate: productMatch[1], negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(productMatch[0]) };
  const brandSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}(${SAFETY_BRAND_SUBJECT})([^.!?;]{0,80}?\\b(?:${keywordAlt})\\b)[^.!?;]{0,60}?(?:[?.]|$)`, 'i');
  const brandMatch = brandSubject.exec(text);
  if (brandMatch && SAFETY_BRAND_MENTION_RE.test(brandMatch[1])) return { evidence: questionSourceEvidence(source, brandMatch, questionOffset), predicate: brandMatch[2], negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(brandMatch[0]) };
  const audienceSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}\\b${SAFETY_AUDIENCE_SUBJECT}\\s+((?:be\\s+)?[^.!?;]{0,80}?\\b(?:${keywordAlt})\\b${SAFETY_AUDIENCE_PRODUCT_RELATION})`, 'i');
  const audienceMatch = audienceSubject.exec(text);
  if (audienceMatch && safetyNamesProduct(audienceMatch[0])) return { evidence: questionSourceEvidence(source, audienceMatch, questionOffset), predicate: audienceMatch[1], negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(audienceMatch[0]) };
  const pronounSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}${SAFETY_QUESTION_PRONOUN_RE}([^.!?;]{0,80}?\\b(?:${keywordAlt})\\b)[^.!?;]{0,60}?(?:[?.]|$)`, 'i');
  const match = pronounSubject.exec(text);
  if (!match) return null;
  return {
    predicate: match[1],
    evidence: questionSourceEvidence(source, match, questionOffset),
    negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(match[0]),
    requiresProductAntecedent: !safetyNamesProduct(match[0]),
    index: questionOffset + match.index,
    localAntecedent: source.slice(0, questionOffset + match.index),
  };
}

const SAFETY_KEYWORDS_POSITIVE = SAFETY_ADJECTIVE;

const SAFETY_NON_PREFIX = '(?<!non[-\\s])';

const SAFETY_KEYWORDS_HARM = `${SAFETY_NON_PREFIX}(?:${HARM_ADJECTIVE}|${SAFETY_HARM_VERB}|risk|danger)`;

const SAFETY_ASR_QUESTION_START_RE = new RegExp(
  `\\b${SAFETY_QUESTION_AUXILIARY}\\s+(?=(?:(${SAFETY_QUESTION_PRODUCT_SUBJECT_RE}|${SAFETY_QUESTION_PRONOUN_RE}|${SAFETY_AUDIENCE_SUBJECT})|(${SAFETY_BRAND_SUBJECT})))`,
  'i',
);

function questionSourceEvidence(source, match, questionOffset) {
  const matchIndex = questionOffset + match.index;
  // Question punctuation is a sentence separator rather than proposition
  // text. A fresh auxiliary plus subject can end an unpunctuated leading
  // condition; keep its body and the question at their actual positions.
  const end = matchIndex + match[0].replace(/[?.]$/, '').length;
  const auxiliary = lexicalSourceSpans(source, SAFETY_ASR_QUESTION_START_RE, matchIndex, end)
    .find((span) => !span.captures[1] || SAFETY_BRAND_IDENTITY_RE.test(span.captures[1]));
  const index = auxiliary?.index ?? matchIndex;
  const evidence = localCandidateEvidence(source, 'safety-question', index, end);
  evidence.conditions = evidence.conditions.map((condition) => {
    if (!auxiliary || condition.marker.index >= index || condition.end <= index) return condition;
    const bodyEnd = condition.marker.end + source.slice(condition.marker.end, index).trimEnd().length;
    return {
      ...condition, ...sourceSpan(source, condition.index, bodyEnd),
      body: sourceSpan(source, condition.marker.end, bodyEnd), position: 'before',
    };
  });
  return evidence;
}

const SAFETY_ELLIPTICAL_WET_QUESTION_RE = /^\s*(?:(?:what about|and)\s+)?(?:even\s+)?(?:while|if|before)\b[^.!?;,]*?\b(?:wet|dry|dries|drying)\b/i;

const SAFETY_FOLLOWUP_NEW_QUESTION_RE = new RegExp(`(?:[,;]\\s*(?:(?:and|or|but)\\s+)?|\\b(?:and|or|but)\\s+)${QUESTION_AUX_WH_RE_SOURCE}\\b`, 'i');

const SAFETY_FOLLOWUP_CONFIRMATION_QUESTION_RE = /^\s*(?:is|was)\s+(?:that|this|it)\s+(?:right|correct|true)\s*$/i;

function recognizeSafetyQuestion(text) {
  const sentences = sentenceSourceSpans(text);
  const lastSentence = sentences.filter((sentence) => sentence.text.trim()).at(-1);
  const latest = latestInterrogativeSpan(text);
  // ASR often omits both the comma and question mark in a declarative tag.
  // A later tag must replace an earlier, unrelated auxiliary-led question.
  const laterTag = lastSentence && (!latest || lastSentence.index > latest.index)
    && [SAFETY_KEYWORDS_POSITIVE, SAFETY_KEYWORDS_HARM].some((keywords) =>
      declarativeSafetyTagCandidate(text, lastSentence.text, keywords, lastSentence.index));
  const segment = laterTag
    ? lastSentence : latest || sourceSpan(text, 0, text.length);
  const questionOffset = segment.index;
  const questionText = segment.text;
  const schedulingSafety = new RegExp(`\\b(?:(?:is|are|would|will|can|could)\\s+(?:it|that|this)|(?:it|that|this)${SAFETY_SUBJECT_VERB})\\s+[^.!?;]{0,20}?\\bsafe\\s+to\\s+(?:reschedule|schedule|move|change|cancel|book)\\b`, 'i').test(questionText)
    && !(safetyNamesProduct(questionText) && SAFETY_AUDIENCE_MENTION_RE.test(questionText));
  const drying = SAFETY_ELLIPTICAL_WET_QUESTION_RE.exec(questionText);
  const dryingSuffix = drying ? questionText.slice(drying[0].length) : '';
  const independentQuestion = SAFETY_FOLLOWUP_NEW_QUESTION_RE.exec(dryingSuffix);
  const confirmsProposition = independentQuestion
    && SAFETY_FOLLOWUP_CONFIRMATION_QUESTION_RE.test(dryingSuffix.slice(independentQuestion.index).replace(/^[,;]\s*/, ''));
  return {
    text: questionText,
    positive: schedulingSafety ? null : questionAboutProduct(text, questionText, SAFETY_KEYWORDS_POSITIVE, questionOffset),
    harm: questionAboutProduct(text, questionText, SAFETY_KEYWORDS_HARM, questionOffset),
    dryingEvidence: drying ? questionSourceEvidence(text, drying, questionOffset) : null,
    dryingFollowup: Boolean(drying && (!independentQuestion || confirmsProposition)),
  };
}

module.exports = {
  recognizeSafetyQuestion, SAFETY_KEYWORDS_POSITIVE, SAFETY_KEYWORDS_HARM, SAFETY_NON_PREFIX,
};
