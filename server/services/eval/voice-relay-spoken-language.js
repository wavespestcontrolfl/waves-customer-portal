// Shared spoken-language grammar. Existing evaluator consumers and safety
// recognition use the same hedge, question, and acknowledgment rules.

const escapeRegexLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '[\'\u2019]');

const wordAlt = (words) => words.map((w) => (w.startsWith('be ') ? `(?:be )?${escapeRegexLiteral(w.slice(3))}` : escapeRegexLiteral(w))).join('|');

const vocabAlt = (words) => `(?:${wordAlt(words)})`;

const EPISTEMIC_REFUSAL_VERBS = Object.freeze(['say', 'promise', 'guarantee', 'confirm', 'check', 'verify', 'be sure', 'be certain', 'know', 'think', 'believe', 'tell you', 'vouch', 'speak to']);

const EPISTEMIC_DENIAL_WORDS = Object.freeze(['doubt', 'doubtful', 'unsure', 'uncertain', 'unclear']);

const SENTENCE_SPLIT_RE = /[.!?;]+(?=\s|$)/;

const normalizeTimeAbbreviations = (text) => text.replace(/\b([ap])\.\s*m\./gi, '$1m');

const COORDINATED_REPORT_VERBS = vocabAlt([...EPISTEMIC_REFUSAL_VERBS, 'deny']);

const EPISTEMIC_HEDGE_PREFIX_SOURCE = `(?:\\b(?:not|never|cannot|unable|no way to|\\w+n[\\x27\\u2019]t)[\\s,]+(?:[\\w\\x27\\u2019]+[\\s,]+)*?${vocabAlt(EPISTEMIC_REFUSAL_VERBS)}|\\bneither\\s+${COORDINATED_REPORT_VERBS}\\s+nor\\s+${COORDINATED_REPORT_VERBS}|(?<!\\bwithout (?:a |any )?|\\bno |\\bbeyond )\\b${vocabAlt(EPISTEMIC_DENIAL_WORDS)}\\b)`;

const AFFIRMATION = '(?:yes|yeah|yep|sure|certainly|absolutely|definitely|indeed|of course|correct|that[\\x27\\u2019]s right|that is right|it (?:(?:sure(?:ly)?|certainly|definitely|absolutely|indeed|really) )?(?:is|was|did)|it[\\x27\\u2019]s)';

const BARE_CONFIRMATION = '(?:right|exactly|that[\\x27\\u2019]s correct|that is correct)';

const SHORT_AFFIRMATION_RE = new RegExp(`^\\s*(?:${AFFIRMATION}|${BARE_CONFIRMATION})(?:[\\s,]+(?:${AFFIRMATION}|${BARE_CONFIRMATION}))*[.!\\s]*$`, 'i');

const QUESTION_AUX_RE_SOURCE = '(?:is|are|was|were|will|would|can|could|do|does|did|has|have|had|should|shall|may|might|must)';

const QUESTION_AUX_WH_RE_SOURCE = `(?:${QUESTION_AUX_RE_SOURCE}|what|when|where|which|who|whom|whose|why|how)`;

const QUESTION_LEAD_RE = new RegExp(`^\\s*(?:so\\s+)?${QUESTION_AUX_RE_SOURCE}\\b`, 'i');

const INTERROGATIVE_CLAUSE_SPLIT_RE = new RegExp(`,\\s*(?:and|or|but)\\s+|;\\s*|\\b(?:and|or|but)\\s+(?=${QUESTION_AUX_WH_RE_SOURCE}\\b)`, 'i');

function latestInterrogativeSegment(text) {
  const parts = normalizeTimeAbbreviations(text).split(new RegExp(`(${SENTENCE_SPLIT_RE.source})`));
  let found = null;
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    if (!sentence || !sentence.trim()) continue;
    if ((parts[i + 1] || '').includes('?') || QUESTION_LEAD_RE.test(sentence)) {
      const clauses = sentence.split(INTERROGATIVE_CLAUSE_SPLIT_RE);
      found = clauses[clauses.length - 1];
    }
  }
  return found;
}

const CONVERSATIONAL_CONDITION_RE = /^\s*(?:(?:that|this|it)(?:[\x27\u2019]s|\s+(?:is|was|helps|answers|clarifies|makes sense))\b|you(?:[\x27\u2019]re|\s+(?:are|were|was))\s+(?:(?:just|still|simply|only)\s+)?(?:asking|wondering|curious|interested|referring|inquiring|unsure|not sure|looking|trying|calling about|checking|confused)\b|you(?:[\x27\u2019]d|\s+(?:want|wanted|need|needed|would like|care|asked|ask|like|mean|meant))\b|(?:anyone|anybody)\s+(?:is|was)\s+(?:wondering|asking)\b|your\s+(?:question|concern|call)\b|[^,;]{0,40}?\bwhat\s+you\s+(?:mean|meant|are asking|were asking|want|wanted|need)\b)/i;

const SUBJECT = '(?:i|we|they|the office|the team|someone|billing|(?:a |the |our )?(?:waves )?(?:team member|billing team|manager))(?:[\\x27\\u2019]ve| have| has| will|[\\x27\\u2019]ll| just| already| am going to| is going to|[\\x27\\u2019]m going to|[\\x27\\u2019]s)?';

const EPISTEMIC_HEDGE_RE = new RegExp(EPISTEMIC_HEDGE_PREFIX_SOURCE, 'i');

const CLAUSE_BOUNDARY_TOKEN_RE = /[.!?;:]|[—–]|\b(?:but|and|or|though|although|however|yet|so|then|while|because|pero|sin embargo|aunque)\b/gi;
const REFUND_PAYMENT_ACTION_RE = /\b(?:refund(?:ed|ing)?|revers(?:e|ed|ing)|return(?:ed|ing)?)\s+(?:(?:your|the|that|a|an)\s+)?(?:last\s+|full\s+|partial\s+|original\s+)?(?:payment|charge|amount)\b/i;
const CLAUSE_FINITE_PREDICATE_RE = /\b(?:is|are|was|were|has|have|had|will|would|should|can|cannot|could|did|does|do|\w+n[\x27\u2019]t|applied|placed|processed|refunded|came)\b/i;
const RIGHT_NOUN_PHRASE_SUBJECT_RE = new RegExp(
  `^\\s*(?:an?|the|this|that|these|those)\\s+(?:[\\w\\x27\\u2019-]+\\s+){0,5}${CLAUSE_FINITE_PREDICATE_RE.source}`,
  'i',
);
function colonContinuesClause(token, left, independentSubject) {
  if (!/^:$/.test(token)) return false;
  const hedge = EPISTEMIC_HEDGE_RE.exec(left);
  const complement = hedge ? left.slice(hedge.index + hedge[0].length).trim() : null;
  return !independentSubject || (complement !== null && /^(?:(?:any of )?(?:this|that|it))?$/i.test(complement));
}
/** [start, end) of the clause in `text` containing character index `at`. */
function clauseBounds(text, at) {
  let start = 0;
  let end = text.length;
  CLAUSE_BOUNDARY_TOKEN_RE.lastIndex = 0;
  let m = CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
  while (m) {
    const left = text.slice(start, m.index);
    // "whether X or Y" presents two alternatives under the same inquiry.
    // A refusal also governs the alternatives when "whether" is omitted:
    // "can't confirm X or Y". Keep both complements intact without teaching
    // the general clause splitter more finite predicates.
    if (/^or$/i.test(m[0]) && new RegExp(`(?:\\bwhether\\b|${EPISTEMIC_HEDGE_PREFIX_SOURCE}|^\\s*(?:(?:only\\s+)?if(?!\\s+(?:anything|you ask me)\\b)|unless)\\b[^,]*$)`, 'i').test(left)) {
      m = CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
      continue;
    }
    // "If eligible, then X" keeps the result under the introductory
    // condition; "then" does not begin an independent assertion there.
    if (/^then$/i.test(m[0]) && /^\s*(?:only\s+)?(?:if|unless)\b/i.test(left)) {
      m = CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
      continue;
    }
    const nominal = left.split(new RegExp(`,|\\b(?:if|unless|whether|${COORDINATED_REPORT_VERBS})\\b`, 'i')).pop().trim();
    // A pair of subjects/objects has no completed predicate on the left:
    // "whether a cancellation or refund was processed", or "Talstar P
    // and bait were applied". Keep its governing refusal/condition.
    const right = text.slice(m.index + m[0].length);
    const independentSubject = new RegExp(`^\\s*(?:(?:you|he|she|it|your|our|their|his|her)|${SUBJECT})\\b`, 'i').test(right)
      // An article-led noun phrase with its own predicate starts a fresh
      // assertion after a coordinator or colon.
      || (/^(?:and|:)$/i.test(m[0]) && RIGHT_NOUN_PHRASE_SUBJECT_RE.test(right))
      || (/^and$/i.test(m[0])
        && new RegExp(`^\\s*(?:${CLAUSE_FINITE_PREDICATE_RE.source}|${REFUND_PAYMENT_ACTION_RE.source})`, 'i').test(right));
    // A colon only separates a fresh subject. A bare hedge or deictic
    // object still governs its colon-introduced complement.
    if (colonContinuesClause(m[0], left, independentSubject)
        || (/^(?:and|or)$/i.test(m[0]) && !independentSubject && nominal && !/^(?:it|this|that)$/i.test(nominal)
          && !CLAUSE_FINITE_PREDICATE_RE.test(nominal))) {
      m = CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
      continue;
    }
    // "confirm or deny" shares one governing modal/refusal. Its second
    // reporting verb does not begin an independent assertion.
    if (/^(?:and|or)$/i.test(m[0])
        && new RegExp(`\\b${COORDINATED_REPORT_VERBS}\\s*$`, 'i').test(text.slice(start, m.index))
        && new RegExp(`^\\s*${COORDINATED_REPORT_VERBS}\\b`, 'i').test(text.slice(m.index + m[0].length))) {
      m = CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
      continue;
    }
    if (m.index + m[0].length <= at) start = m.index + m[0].length;
    else { end = m.index; break; }
    m = CLAUSE_BOUNDARY_TOKEN_RE.exec(text);
  }
  return [start, end];
}
/** The clause of `text` containing character index `at`. */
function clauseOf(text, at) {
  const [start, end] = clauseBounds(text, at);
  return text.slice(start, end);
}

// Shared predicates retain the original spoken-check grammar. Source-evidence
// consumers supply their own source-backed clause bounds.
const CERTAINTY_IDIOM_RE = /\b(?:without (?:a |any )?|no |beyond )doubt\b/gi;
const NEGATION_RE = /\b(?:not(?!\s+only\b)|never|cannot|can[\x27\u2019]?t|\w+n[\x27\u2019]t|whether|if|nothing|nobody|no[- ]one|anything|no|until|unless|before|yet)\b/i;
/** Does `clause` carry a negation or conditional marker anywhere in it? */
function clauseIsNegated(clause) {
  // These reassurance prefixes do not deny the claim that follows them.
  return NEGATION_RE.test(clause.replace(CERTAINTY_IDIOM_RE, '').replace(/^\s*(?:no worries|no problem|do not worry|don['’]t worry)\b[\s,:—–]*/i, ''));
}
/** Does `clause` carry an epistemic hedge or refusal? */
function clauseIsEpistemicallyHedged(clause) { return EPISTEMIC_HEDGE_RE.test(clause); }

const FREE_VISIT_ACKNOWLEDGMENT_RE = /^\s*,?\s*(?:ok(?:ay)?|all\s*right|alright|sounds?\s+good|got\s+it|you\s+(?:follow|understand|know)|understood|yeah|yes|good)(?:\s+then)?(?=\s*(?:$|[,;]))/i;

module.exports = {
  FREE_VISIT_ACKNOWLEDGMENT_RE,
  CERTAINTY_IDIOM_RE, EPISTEMIC_HEDGE_RE, clauseIsNegated, clauseIsEpistemicallyHedged,
  SUBJECT,
  REFUND_PAYMENT_ACTION_RE,
  CLAUSE_FINITE_PREDICATE_RE,
  clauseBounds,
  clauseOf,
  EPISTEMIC_HEDGE_PREFIX_SOURCE,
  vocabAlt,
  wordAlt,
  escapeRegexLiteral,
  EPISTEMIC_REFUSAL_VERBS,
  COORDINATED_REPORT_VERBS,
  EPISTEMIC_DENIAL_WORDS,
  SHORT_AFFIRMATION_RE,
  AFFIRMATION,
  BARE_CONFIRMATION,
  latestInterrogativeSegment,
  normalizeTimeAbbreviations,
  SENTENCE_SPLIT_RE,
  QUESTION_LEAD_RE,
  QUESTION_AUX_RE_SOURCE,
  INTERROGATIVE_CLAUSE_SPLIT_RE,
  QUESTION_AUX_WH_RE_SOURCE,
  CONVERSATIONAL_CONDITION_RE
};
