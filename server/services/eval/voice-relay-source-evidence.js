// Lexical evidence only: source offsets do not assert a guarantee, resolve
// an antecedent, or decide whether a condition qualifies a proposition.
const {
  SENTENCE_SPLIT_RE, QUESTION_LEAD_RE, QUESTION_AUX_WH_RE_SOURCE,
  CLAUSE_FINITE_PREDICATE_RE, clauseBounds,
} = require('./voice-relay-spoken-language');

function sourceSpan(source, index, end) {
  if (!Number.isInteger(index) || !Number.isInteger(end) || index < 0 || end < index || end > source.length) {
    throw new RangeError('source span must be a valid half-open interval');
  }
  return { index, end, text: source.slice(index, end) };
}

const TIME_ZONE_CONTINUATION_RE = /^(?:(?:Eastern|Central|Mountain|Pacific|Alaska|Hawaii(?:-Aleutian)?)(?:\s+(?:standard|daylight))?\s+time\b|(?:[ECMP][DS]?T|UTC|GMT)\b)/i;
const INSTRUCTION_LEAD_RE = /^(?:call|contact|ask|keep|leave|avoid|follow|wait)\b/i;

// Mask rather than normalize: every character keeps its original position.
// Casing is only a fallback choice, never proof of a sentence boundary.
// Consumers must not use a condition across an ambiguous boundary as proof
// that a proposition is qualified. Both adjacent selected spans carry it.
function maskAbbreviations(source, ambiguities = []) {
  // Dotted acronyms and this bounded lexical list can contain a terminal
  // sentence period too. Preserve uncertainty instead of claiming that a
  // capitalized successor proves the governing clause has ended.
  const abbreviation = /\b(?:[ap]\.\s*m\.|[a-z]\.(?:\s*[a-z]\.)+|(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc)\.)/gi;
  return source.replace(abbreviation, (value, offset) => {
    const time = /^[ap]\.\s*m\.$/i.test(value);
    const remainder = source.slice(offset + value.length).trimStart();
    const continuation = (time && TIME_ZONE_CONTINUATION_RE.test(remainder)) || /^[,;:!?]/.test(remainder);
    const question = QUESTION_LEAD_RE.test(remainder);
    const closesSentence = !remainder || (!continuation
      && (question || INSTRUCTION_LEAD_RE.test(remainder) || /^[A-Z]/.test(remainder)));
    if (remainder && !continuation) {
      const dot = offset + value.length - 1;
      ambiguities.push({
        ...sourceSpan(source, dot, dot + 1),
        reason: time ? 'time_abbreviation' : 'lexical_abbreviation', selectedBoundary: closesSentence,
      });
    }
    const masked = value.replace(/\./g, ' ');
    return closesSentence ? masked.slice(0, -1) + '.' : masked;
  });
}

function splitSourceSpans(source, separator, index = 0, end = source.length) {
  const region = sourceSpan(source, index, end);
  const pattern = new RegExp(separator.source, separator.flags.replace(/[gy]/g, '') + 'g');
  const spans = [];
  let start = index;
  const ambiguities = [];
  const maskedSource = maskAbbreviations(source, ambiguities);
  const masked = maskedSource.slice(region.index, region.end);
  const sentenceSeparators = [...maskedSource.matchAll(new RegExp(SENTENCE_SPLIT_RE.source, 'g'))];
  for (const match of masked.matchAll(pattern)) {
    if (!match[0].length) throw new RangeError('source separator must consume characters');
    const boundary = index + match.index;
    spans.push({ ...sourceSpan(source, start, boundary), separator: sourceSpan(source, boundary, boundary + match[0].length) });
    start = boundary + match[0].length;
  }
  spans.push({ ...sourceSpan(source, start, end), separator: sourceSpan(source, end, end) });
  return spans.map((span) => {
    // A trimmed or later clause still belongs to its selected source sentence.
    // Inherit that parent's uncertainty, including its adjacent boundary.
    const preceding = sentenceSeparators.filter((boundary) => boundary.index + boundary[0].length <= span.index).at(-1);
    const contextStart = preceding ? preceding.index + preceding[0].length : 0;
    const contextEnd = sentenceSeparators.find((boundary) => boundary.index >= span.end)?.index ?? source.length;
    return {
      ...span,
      ambiguousBoundaries: ambiguities.filter((ambiguity) =>
        (ambiguity.index >= contextStart && ambiguity.index <= contextEnd)
        || ambiguity.end === contextStart),
    };
  });
}

function sentenceSourceSpans(source) {
  return splitSourceSpans(source, SENTENCE_SPLIT_RE);
}

// Elliptical alternatives ('or not', 'and harmless') belong to the original
// question. Only an independent auxiliary/WH lead selects a new question.
const SOURCE_INTERROGATIVE_SPLIT_RE = new RegExp(`(?:,\\s*)?\\b(?:and|or|but)\\s+(?=${QUESTION_AUX_WH_RE_SOURCE}\\b)|;\\s*`, 'i');

function latestInterrogativeSpan(source) {
  let found = null;
  for (const sentence of sentenceSourceSpans(source)) {
    if (!sentence.text.trim()) continue;
    if (sentence.separator.text.includes('?') || QUESTION_LEAD_RE.test(sentence.text)) {
      found = splitSourceSpans(source, SOURCE_INTERROGATIVE_SPLIT_RE, sentence.index, sentence.end).at(-1);
    }
  }
  return found;
}

// Consumers supply their shared lexical vocabulary. No case conversion,
// trimming, or discourse-marker removal is allowed to move source offsets.
function lexicalSourceSpans(source, pattern, index = 0, end = source.length) {
  const region = sourceSpan(source, index, end);
  const global = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g');
  return [...region.text.matchAll(global)].map((match) => ({
    ...sourceSpan(source, index + match.index, index + match.index + match[0].length),
    captures: match.slice(1),
  }));
}

const CONDITION_MARKER_RE = /\b(?:if|unless|when|while|before|after|once|until|till|provided(?:\s+that)?|(?:as\s+long|so\s+long)\s+as)\b/gi;
const GRAMMATICAL_NEGATION_RE = /\b(?:not|never|cannot|no|nothing|nobody|neither|nor|\w+n[\x27\u2019]t|(?:ca|wo|sha|do|does|did|is|are|was|were|has|have|had|could|would|should|must)n[\x27\u2019]?t)\b/gi;

// Refine evidence bounds only; the shared mechanical grammar stays intact.
// Commas before reduced condition/audience phrases remain inside the clause.
const FINITE_CLAUSE_LEAD_RE = new RegExp(
  `^\\s*(?:(?:i|we|you|he|she|it|they|this|that|these|those|there)\\s+|(?:an?|the|our|your|their|my|his|her)\\s+(?:[\\w\\x27\\u2019-]+\\s+){1,5})${CLAUSE_FINITE_PREDICATE_RE.source}`,
  'i',
);
const CONDITION_CLAUSE_LEAD_RE = new RegExp(`^${CONDITION_MARKER_RE.source}`, 'i');
function maskIndependentCommas(source) {
  return source.replace(/,/g, (comma, offset) => {
    const before = source.slice(0, offset).split(/[,;—–]/).at(-1).trimStart();
    if (CONDITION_CLAUSE_LEAD_RE.test(before)) return comma;
    const after = source.slice(offset + 1).trimStart();
    return INSTRUCTION_LEAD_RE.test(after) || FINITE_CLAUSE_LEAD_RE.test(after) ? ';' : comma;
  });
}

function localCandidateEvidence(source, kind, index, end) {
  const proposition = sourceSpan(source, index, end);
  const sentence = sentenceSourceSpans(source).find((span) => index >= span.index && end <= span.end);
  if (!sentence) throw new RangeError('candidate must remain within one source sentence');
  // Protect punctuation inside decimal tokens and the multiword marker
  // without changing the shared clause grammar or any source offsets.
  const clauseSource = maskIndependentCommas(maskAbbreviations(sentence.text))
    .replace(/(?<=\d)\.(?=\d)/g, ' ')
    .replace(/\bso\s+long\s+as\b/gi, (marker) => ' '.repeat(marker.length));
  const [start, stop] = clauseBounds(clauseSource, index - sentence.index);
  // A matched proposition can include coordinated predicates. Keep its full
  // span; policy must interpret the retained clause/sentence independently.
  const clause = sourceSpan(source, Math.min(index, sentence.index + start), Math.max(end, sentence.index + stop));
  const markers = lexicalSourceSpans(source, CONDITION_MARKER_RE, clause.index, clause.end)
    .filter((marker) => !/^while$/i.test(marker.text));
  const conditions = markers.map((marker, offset) => {
    const next = markers[offset + 1]?.index ?? clause.end;
    const punctuation = /[,;—–]|(?<!\d):|:(?!\d)/.exec(source.slice(marker.end, next));
    const bodyEnd = punctuation ? marker.end + punctuation.index : next;
    return {
      ...sourceSpan(source, marker.index, bodyEnd), marker,
      body: sourceSpan(source, marker.end, bodyEnd),
      position: bodyEnd <= index ? 'before' : marker.index >= end ? 'after' : 'overlapping',
    };
  });
  // While may introduce a condition or contrast two assertions. Retain its
  // adjacent lexical body separately; never merge the clauses or negations.
  const adjacentConnectives = lexicalSourceSpans(source, /\bwhile\b/gi, sentence.index, sentence.end)
    .filter((marker) => marker.end === clause.index || marker.index === clause.end
      || (marker.index >= clause.index && marker.end <= clause.end))
    .map((marker) => {
      const [, bodyStop] = clauseBounds(clauseSource, marker.end - sentence.index);
      const bodyLimit = sentence.index + bodyStop;
      const punctuation = /[,;—–]|(?<!\d):|:(?!\d)/.exec(source.slice(marker.end, bodyLimit));
      const bodyEnd = punctuation ? marker.end + punctuation.index : bodyLimit;
      return {
        ...sourceSpan(source, marker.index, bodyEnd), marker, relation: 'unresolved',
        body: sourceSpan(source, marker.end, bodyEnd),
        position: bodyEnd <= index ? 'before' : marker.index >= end ? 'after' : 'overlapping',
      };
    });
  return {
    kind, ...proposition, sentence, clause, conditions, adjacentConnectives,
    negations: lexicalSourceSpans(source, GRAMMATICAL_NEGATION_RE, clause.index, clause.end),
  };
}

module.exports = {
  INSTRUCTION_LEAD_RE,
  sourceSpan, splitSourceSpans, sentenceSourceSpans, latestInterrogativeSpan,
  lexicalSourceSpans, localCandidateEvidence,
};
