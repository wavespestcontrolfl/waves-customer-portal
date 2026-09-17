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

module.exports = {
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
