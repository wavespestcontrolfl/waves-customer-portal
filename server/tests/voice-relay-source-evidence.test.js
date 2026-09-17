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
    expect(evidence.conditions).toEqual([]);
    expect(evidence.adjacentConnectives).toHaveLength(1);
    expect(evidence.adjacentConnectives[0].marker.text.toLowerCase()).toBe('while');
    expect(evidence.adjacentConnectives[0].body.text.trim()).toBe('it is dry');
    expectExact(source, evidence.adjacentConnectives[0]);
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


test('clock minutes remain within a condition body', () => {
  const source = 'The bait is safe after 9:00 tonight';
  const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
  expect(evidence.conditions[0].text).toBe('after 9:00 tonight');
});

test.each(['cant', 'wont', 'dont', 'isnt', 'couldnt'])('ASR negation %s retains its source spelling', (word) => {
  const source = `I ${word} say the bait is safe`;
  const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
  expect(evidence.negations.map((span) => span.text)).toContain(word);
});

test.each(['until', 'till'])('inverse condition %s remains evidence for policy', (word) => {
  const source = `The treatment is safe ${word} dry`;
  const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
  expect(evidence.conditions[0].text).toBe(`${word} dry`);
});

test.each(['Eastern time', 'eastern daylight time', 'EST', 'UTC'])(
  'time-zone continuation %s retains the following condition', (zone) => {
    const source = `The bait is safe at 9 p.m. ${zone} if swallowed`;
    const index = source.indexOf('safe');
    const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
    expect(evidence.conditions.map((condition) => condition.text)).toEqual(['if swallowed']);
    expect(evidence.sentence.ambiguousBoundaries).toEqual([]);
    expectExact(source, evidence.sentence);
    expectExact(source, evidence.conditions[0]);
  },
);

test.each(['call', 'Call'])(
  'an independent %s instruction stays outside the earlier proposition', (verb) => {
    const source = `The bait is safe at 9 p.m. ${verb} a veterinarian if swallowed`;
    const index = source.indexOf('safe');
    const evidence = localCandidateEvidence(source, 'adjective', index, index + 4);
    expect(evidence.conditions).toEqual([]);
    expect(evidence.sentence.text).toBe('The bait is safe at 9 p.m');
    const instruction = localCandidateEvidence(source, 'instruction', source.indexOf(verb), source.indexOf(verb) + verb.length);
    expect(instruction.conditions.map((condition) => condition.text)).toEqual(['if swallowed']);
    expect(evidence.sentence.ambiguousBoundaries).toEqual(instruction.sentence.ambiguousBoundaries);
    expect(evidence.sentence.ambiguousBoundaries).toHaveLength(1);
    expectExact(source, evidence.sentence.ambiguousBoundaries[0]);
  },
);

test.each(['If swallowed', 'if swallowed'])(
  'ambiguous conditional casing %s is explicit on both candidate sides', (condition) => {
    const source = `The bait is safe at 9 p.m. ${condition}, call a veterinarian`;
    const safeIndex = source.indexOf('safe');
    const markerIndex = source.indexOf(condition);
    const proposition = localCandidateEvidence(source, 'adjective', safeIndex, safeIndex + 4);
    const conditional = localCandidateEvidence(source, 'condition', markerIndex, markerIndex + condition.length);
    const boundary = proposition.sentence.ambiguousBoundaries[0];
    expect(boundary).toMatchObject({
      reason: 'time_abbreviation', selectedBoundary: condition.startsWith('I'),
      index: source.indexOf('p.m.') + 3, end: source.indexOf('p.m.') + 4, text: '.',
    });
    expect(conditional.sentence.ambiguousBoundaries).toContainEqual(boundary);
    expectExact(source, boundary);
    if (boundary.selectedBoundary) expect(proposition.conditions).toEqual([]);
    else expect(proposition.conditions[0].text).toBe(condition);
  },
);

test('ambiguity offsets stay absolute when a consumer splits a subregion', () => {
  const source = 'First. The bait is safe at 9 p.m. If swallowed, call a veterinarian';
  const spans = splitSourceSpans(source, /[.!?;]+(?=\s|$)/, source.indexOf('The bait'));
  expect(spans[0].ambiguousBoundaries[0]).toEqual(spans[1].ambiguousBoundaries[0]);
  expectExact(source, spans[0].ambiguousBoundaries[0]);
});


test('a question subspan retains ambiguity from its abbreviation sentence boundary', () => {
  const source = 'Is the bait safe at 9 p.m. If swallowed, call a veterinarian';
  const sentence = sentenceSourceSpans(source)[0];
  const question = latestInterrogativeSpan(source);
  expect(question.ambiguousBoundaries).toEqual(sentence.ambiguousBoundaries);
  expect(question.ambiguousBoundaries).toHaveLength(1);
  const following = sentenceSourceSpans(source)[1];
  const subspan = splitSourceSpans(source, /;/, following.index, following.end)[0];
  expect(subspan.ambiguousBoundaries).toEqual(sentence.ambiguousBoundaries);
});


test.each(['After 9 p.m. is the bait safe?', 'Once dry at 9 p.m. is the bait safe?'])(
  'an auxiliary after a fronted condition retains boundary uncertainty: %s', (source) => {
    const question = latestInterrogativeSpan(source);
    expect(question).toMatchObject({ text: ' is the bait safe', index: source.indexOf(' is the bait'), end: source.indexOf('?') });
    expect(question.ambiguousBoundaries).toHaveLength(1);
    expect(question.ambiguousBoundaries[0]).toMatchObject({ text: '.', selectedBoundary: true, reason: 'time_abbreviation' });
    const safe = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
    expect(safe.sentence.ambiguousBoundaries).toEqual(question.ambiguousBoundaries);
    expectExact(source, question);
    expectExact(source, question.ambiguousBoundaries[0]);
  },
);

test.each(['If', 'call'])(
  'a whitespace-trimmed %s subregion inherits its source-sentence ambiguity', (lead) => {
    const source = 'The bait is safe at 9 p.m. If swallowed, call a veterinarian';
    const parent = sentenceSourceSpans(source)[1];
    const subspan = splitSourceSpans(source, /;/, source.indexOf(lead))[0];
    expect(subspan.ambiguousBoundaries).toEqual(parent.ambiguousBoundaries);
    expect(subspan.ambiguousBoundaries).toHaveLength(1);
    expectExact(source, subspan);
    expectExact(source, subspan.ambiguousBoundaries[0]);
  },
);

test('both comma-separated subclauses inherit their selected parent sentence', () => {
  const source = 'The bait is safe at 9 p.m. If swallowed, call a veterinarian. The office is closed.';
  const parent = sentenceSourceSpans(source)[1];
  const subclauses = splitSourceSpans(source, /,\s*/, source.indexOf('If'), parent.end);
  expect(subclauses).toHaveLength(2);
  for (const span of subclauses) expect(span.ambiguousBoundaries).toEqual(parent.ambiguousBoundaries);
  const independent = splitSourceSpans(source, /;/, source.indexOf('The office'))[0];
  expect(independent.ambiguousBoundaries).toEqual([]);
});


test.each(['The bait is safe so long as dry.', 'So long as dry, the bait is safe.'])(
  'so long as retains its exact lexical condition: %s', (source) => {
    const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
    expect(evidence.conditions[0].marker.text.toLowerCase()).toBe('so long as');
    expect(evidence.conditions[0].body.text.trim()).toBe('dry');
    expectExact(source, evidence.conditions[0]);
  },
);

test('neither and nor retain exact negation positions', () => {
  const source = 'I can neither confirm nor deny the bait is safe.';
  const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
  expect(evidence.negations.map((span) => span.text)).toEqual(['neither', 'nor']);
  for (const span of evidence.negations) expectExact(source, span);
});

test('a decimal token cannot detach the earlier lexical refusal', () => {
  const source = 'I cannot confirm that the 0.5% bait is safe.';
  const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
  expect(evidence.clause.text).toBe(source.slice(0, -1));
  expect(evidence.negations[0]).toMatchObject({ text: 'cannot', index: source.indexOf('cannot') });
  expectExact(source, evidence.clause);
});

test.each(['The spray is not safe, while the bait is safe.', 'The spray is not safe while the bait is safe.'])(
  'contrastive while preserves each assertion and its negation: %s', (source) => {
    const sprayIndex = source.indexOf('safe');
    const baitIndex = source.lastIndexOf('safe');
    const spray = localCandidateEvidence(source, 'adjective', sprayIndex, sprayIndex + 4);
    const bait = localCandidateEvidence(source, 'adjective', baitIndex, baitIndex + 4);
    expect(spray.clause.text).not.toContain('the bait');
    expect(spray.negations.map((span) => span.text)).toEqual(['not']);
    expect(bait.clause.text.trim()).toBe('the bait is safe');
    expect(bait.negations).toEqual([]);
    expect(spray.conditions).toEqual([]);
    expect(bait.conditions).toEqual([]);
    for (const evidence of [spray, bait]) {
      expect(evidence.adjacentConnectives[0].body.text.trim()).toBe('the bait is safe');
      expectExact(source, evidence.adjacentConnectives[0]);
      expectExact(source, evidence.adjacentConnectives[0].marker);
      expectExact(source, evidence.adjacentConnectives[0].body);
      expect(evidence.adjacentConnectives[0]).toMatchObject({ relation: 'unresolved' });
      expect(evidence.adjacentConnectives[0]).not.toHaveProperty('qualified');
    }
  },
);


test.each(['The bait is safe while dry.', 'While dry, the bait is safe.'])(
  'bare while body remains unresolved adjacent evidence: %s', (source) => {
    const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
    expect(evidence.adjacentConnectives[0]).toMatchObject({ relation: 'unresolved' });
    expect(evidence.adjacentConnectives[0].body.text.trim()).toBe('dry');
    expect(evidence.conditions).toEqual([]);
    expectExact(source, evidence.adjacentConnectives[0]);
  },
);

test.each(['U.S.', 'U. S.', 'e.g.', 'Dr.'])(
  'a lexical abbreviation retains governing negation or explicit uncertainty: %s', (abbreviation) => {
    const source = `I cannot say the ${abbreviation} product is safe`;
    const evidence = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
    expect(evidence.negations.map((token) => token.text)).toContain('cannot');
    expect(evidence.sentence.ambiguousBoundaries[0]).toMatchObject({ reason: 'lexical_abbreviation', selectedBoundary: false });
    for (const span of [evidence, evidence.clause, ...evidence.negations, ...evidence.sentence.ambiguousBoundaries]) expectExact(source, span);
  },
);

test('both sides of a potentially terminal lexical abbreviation retain its ambiguity', () => {
  const source = 'I cannot say the bait is safe in the U.S. If swallowed, call a veterinarian';
  const claim = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
  const condition = localCandidateEvidence(source, 'condition', source.indexOf('If'), source.indexOf('If') + 2);
  expect(claim.conditions).toEqual([]);
  expect(claim.sentence.ambiguousBoundaries).toEqual(condition.sentence.ambiguousBoundaries);
  expect(claim.sentence.ambiguousBoundaries[0]).toMatchObject({ reason: 'lexical_abbreviation', selectedBoundary: true });
  expectExact(source, claim.sentence.ambiguousBoundaries[0]);
});

test.each(['call us', 'Call us', 'you should call us', 'the technician will call us'])(
  'a comma-spliced independent clause keeps its own drying condition: %s', (instruction) => {
    const source = `The bait is safe, ${instruction} once dry`;
    const safe = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
    expect(safe.clause.text).toBe('The bait is safe');
    expect(safe.conditions).toEqual([]);
    const call = localCandidateEvidence(source, 'instruction', source.indexOf('once'), source.indexOf('once') + 4);
    expect(call.conditions[0].text).toBe('once dry');
    for (const span of [safe, safe.clause, call.clause, call.conditions[0]]) expectExact(source, span);
  },
);

test.each(['The bait is safe, once dry', 'Once it is dry, the bait is safe'])(
  'a comma before a reduced drying qualifier stays within its proposition: %s', (source) => {
    const safe = localCandidateEvidence(source, 'adjective', source.indexOf('safe'), source.indexOf('safe') + 4);
    expect(safe.conditions[0].marker.text.toLowerCase()).toBe('once');
    expect(safe.conditions[0].body.text.trim()).toMatch(/dry$/);
    expectExact(source, safe.clause);
  },
);

test.each(['Is the bait safe, or not?', 'Is the bait safe or not?', 'Is the bait safe, and harmless?'])(
  'an elliptical alternative retains the complete source question: %s', (source) => {
    const question = latestInterrogativeSpan(source);
    expect(question.text).toBe(source.slice(0, -1));
    expectExact(source, question);
  },
);

test.each(['and is the spray safe', 'or will it hurt dogs', 'but what about the spray'])(
  'a coordinated independent interrogative selects its exact last span: %s', (tail) => {
    const source = `Is the bait safe, ${tail}?`;
    const question = latestInterrogativeSpan(source);
    const expected = tail.replace(/^(?:and|or|but) /, '');
    expect(question.text).toBe(expected);
    expect(question.index).toBe(source.indexOf(expected));
    expectExact(source, question);
  },
);

test('comma-separated finite assertions retain separate local negations', () => {
  const source = 'The bait is not safe, the spray is safe once dry';
  const first = source.indexOf('safe');
  const second = source.lastIndexOf('safe');
  const negative = localCandidateEvidence(source, 'adjective', first, first + 4);
  const positive = localCandidateEvidence(source, 'adjective', second, second + 4);
  expect(negative.negations.map((token) => token.text)).toEqual(['not']);
  expect(negative.conditions).toEqual([]);
  expect(positive.negations).toEqual([]);
  expect(positive.conditions[0].text).toBe('once dry');
  expectExact(source, negative.clause);
  expectExact(source, positive.clause);
});
