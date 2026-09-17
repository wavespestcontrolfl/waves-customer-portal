const {
  sourceSpan, splitSourceSpans, sentenceSourceSpans, latestInterrogativeSpan,
  lexicalSourceSpans, localCandidateEvidence,
} = require('../services/eval/voice-relay-source-evidence');
const { latestInterrogativeSegment } = require('../services/eval/voice-relay-spoken-language');

function expectExact(source, span) {
  expect(span.text).toBe(source.slice(span.index, span.end));
}

test.each(['a.m.', 'p.m.', 'A. M.', 'P.  M.'])('question offsets retain %s spelling and spacing', (time) => {
  const source = `The treatment is at 9 ${time} Is the bait safe for my dog? I need to know.`;
  const span = latestInterrogativeSpan(source);
  expect(span.text).toBe(' Is the bait safe for my dog');
  expectExact(source, span);
  expect(sentenceSourceSpans(source)).toHaveLength(4);
  expect(latestInterrogativeSegment(source)).toBe(`The treatment is at 9 ${time[0]}m Is the bait safe for my dog`);
});

test('the last independent question has its own exact source position', () => {
  const source = 'Is it safe, and is it safe? I need to know.';
  const span = latestInterrogativeSpan(source);
  expect(span).toMatchObject({ index: 16, end: 26, text: 'is it safe' });
  expectExact(source, span);
  expect(latestInterrogativeSpan('So I need to know. What a mess.')).toBeNull();
});

test('answer splitting keeps discourse markers in source until a consumer explicitly selects its content', () => {
  const source = 'No, I cannot confirm. However, yes, the bait is safe.';
  const answer = splitSourceSpans(source, /[.!?;]+(?=\s|$)/)[1];
  const prefix = /^\s*however\b\s*,?\s*/i.exec(answer.text)[0];
  const content = sourceSpan(source, answer.index + prefix.length, answer.end);
  expect(content.text).toBe('yes, the bait is safe');
  expect(content.index).toBe(source.indexOf('yes'));
  expectExact(source, answer);
  expectExact(source, content);
});

test.each([
  'The bait is safe. Keep pets away until the spray is dry.',
  'The bait is safe. If swallowed, call a veterinarian.',
  'The bait is safe; once dry, the technician will confirm timing.',
])('later instruction conditions stay outside an earlier candidate: %s', (source) => {
  const index = source.indexOf('safe');
  const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
  expect(evidence.conditions).toEqual([]);
  expect(evidence.sentence.text).toBe('The bait is safe');
  expectExact(source, evidence);
  expectExact(source, evidence.clause);
});

test('condition evidence keeps nested marker positions without deciding their qualification', () => {
  const source = 'If it is dry, the bait is safe even if swallowed once dry.';
  const index = source.indexOf('safe');
  const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
  expect(evidence.conditions.map((item) => [item.marker.text, item.body.text, item.position])).toEqual([
    ['If', ' it is dry', 'before'], ['if', ' swallowed ', 'after'], ['once', ' dry', 'after'],
  ]);
  for (const item of evidence.conditions) {
    expectExact(source, item);
    expectExact(source, item.marker);
    expectExact(source, item.body);
  }
  expect(evidence).not.toHaveProperty('qualified');
  expect(evidence).not.toHaveProperty('guarantee');
});

test('a fresh coordinated instruction has a separate clause', () => {
  const source = 'The bait is safe, and you should call if swallowed.';
  const index = source.indexOf('safe');
  const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
  expect(evidence.clause.text).toBe('The bait is safe, ');
  expect(evidence.conditions).toEqual([]);
});

test('product, audience and negation evidence retains original lexical text', () => {
  const source = 'Actually, Bifen I/T is NOT safe for YOUR Dog at 9 p.m. if swallowed.';
  const index = source.indexOf('safe');
  const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
  const product = lexicalSourceSpans(source, /Bifen I\/T/gi, evidence.clause.index, evidence.clause.end)[0];
  const audience = lexicalSourceSpans(source, /(?:your\s+)?(dog)/gi, evidence.clause.index, evidence.clause.end)[0];
  expect(product.text).toBe('Bifen I/T');
  expect(audience).toMatchObject({ text: 'YOUR Dog', captures: ['Dog'] });
  expect(evidence.negations.map((span) => span.text)).toEqual(['NOT']);
  expect(evidence.conditions[0].text).toBe('if swallowed');
  for (const span of [product, audience, ...evidence.negations]) expectExact(source, span);
});

test('invalid and cross-sentence candidate intervals fail instead of silently attaching unrelated evidence', () => {
  expect(() => sourceSpan('safe', -1, 2)).toThrow(RangeError);
  expect(() => sourceSpan('safe', 1, 6)).toThrow(RangeError);
  expect(() => localCandidateEvidence('safe. If dry.', 'adjective', 0, 12)).toThrow(RangeError);
  expect(() => splitSourceSpans('safe', /(?=safe)/)).toThrow(RangeError);
});


test.each(['The bait is safe while it is dry.', 'While it is dry, the bait is safe.'])(
  'while conditions retain exact evidence: %s', (source) => {
    const index = source.indexOf('safe');
    const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
    expect(evidence.conditions).toHaveLength(1);
    expect(evidence.conditions[0].marker.text.toLowerCase()).toBe('while');
    expect(evidence.conditions[0].body.text.trim()).toBe('it is dry');
    expectExact(source, evidence.conditions[0]);
  },
);

test('a time abbreviation may also end the candidate sentence', () => {
  const source = 'The bait is safe at 9 p.m. If swallowed, call a veterinarian.';
  const index = source.indexOf('safe');
  const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
  expect(evidence.conditions).toEqual([]);
  expect(evidence.sentence.text).toBe('The bait is safe at 9 p.m');
  expectExact(source, evidence.sentence);
});
