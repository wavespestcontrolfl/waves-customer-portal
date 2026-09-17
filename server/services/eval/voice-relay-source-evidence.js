// Lexical evidence only: source offsets do not assert a guarantee, resolve
// an antecedent, or decide whether a condition qualifies a proposition.
const {
  SENTENCE_SPLIT_RE, QUESTION_LEAD_RE, INTERROGATIVE_CLAUSE_SPLIT_RE, clauseBounds,
} = require('./voice-relay-spoken-language');

function sourceSpan(source, index, end) {
  if (!Number.isInteger(index) || !Number.isInteger(end) || index < 0 || end < index || end > source.length) {
    throw new RangeError('source span must be a valid half-open interval');
  }
  return { index, end, text: source.slice(index, end) };
}

// Mask rather than normalize: every character keeps its original position.
function maskTimeAbbreviations(source) {
  return source.replace(/\b[ap]\.\s*m\./gi, (value) => value.replace(/\./g, ' '));
}

function splitSourceSpans(source, separator, index = 0, end = source.length) {
  const region = sourceSpan(source, index, end);
  const pattern = new RegExp(separator.source, separator.flags.replace(/[gy]/g, '') + 'g');
  const spans = [];
  let start = index;
  for (const match of maskTimeAbbreviations(region.text).matchAll(pattern)) {
    if (!match[0].length) throw new RangeError('source separator must consume characters');
    const boundary = index + match.index;
    spans.push({ ...sourceSpan(source, start, boundary), separator: sourceSpan(source, boundary, boundary + match[0].length) });
    start = boundary + match[0].length;
  }
  spans.push({ ...sourceSpan(source, start, end), separator: sourceSpan(source, end, end) });
  return spans;
}

function sentenceSourceSpans(source) {
  return splitSourceSpans(source, SENTENCE_SPLIT_RE);
}

function latestInterrogativeSpan(source) {
  let found = null;
  for (const sentence of sentenceSourceSpans(source)) {
    if (!sentence.text.trim()) continue;
    if (sentence.separator.text.includes('?') || QUESTION_LEAD_RE.test(sentence.text)) {
      found = splitSourceSpans(source, INTERROGATIVE_CLAUSE_SPLIT_RE, sentence.index, sentence.end).at(-1);
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

const CONDITION_MARKER_RE = /\b(?:if|unless|when|while|before|after|once|provided(?:\s+that)?|as\s+long\s+as)\b/gi;
const GRAMMATICAL_NEGATION_RE = /\b(?:not|never|cannot|no|nothing|nobody|\w+n[\x27\u2019]t)\b/gi;

function localCandidateEvidence(source, kind, index, end) {
  const proposition = sourceSpan(source, index, end);
  const sentence = sentenceSourceSpans(source).find((span) => index >= span.index && end <= span.end);
  if (!sentence) throw new RangeError('candidate must remain within one source sentence');
  const [start, stop] = clauseBounds(maskTimeAbbreviations(sentence.text), index - sentence.index);
  // A matched proposition can include coordinated predicates. Keep its full
  // span; policy must interpret the retained clause/sentence independently.
  const clause = sourceSpan(source, Math.min(index, sentence.index + start), Math.max(end, sentence.index + stop));
  const markers = lexicalSourceSpans(source, CONDITION_MARKER_RE, clause.index, clause.end);
  const conditions = markers.map((marker, offset) => {
    const next = markers[offset + 1]?.index ?? clause.end;
    const punctuation = /[,;:—–]/.exec(source.slice(marker.end, next));
    const bodyEnd = punctuation ? marker.end + punctuation.index : next;
    return {
      ...sourceSpan(source, marker.index, bodyEnd), marker,
      body: sourceSpan(source, marker.end, bodyEnd),
      position: bodyEnd <= index ? 'before' : marker.index >= end ? 'after' : 'overlapping',
    };
  });
  return {
    kind, ...proposition, sentence, clause, conditions,
    negations: lexicalSourceSpans(source, GRAMMATICAL_NEGATION_RE, clause.index, clause.end),
  };
}

module.exports = {
  sourceSpan, splitSourceSpans, sentenceSourceSpans, latestInterrogativeSpan,
  lexicalSourceSpans, localCandidateEvidence,
};
