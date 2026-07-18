/**
 * Call-research miner — pure-helper contracts.
 * All transcripts/names here are SYNTHETIC (never real customer data).
 */

const {
  CALL_RESEARCH_ROUTE,
  _test: { normalizeForMatch, isVerbatim, normalizeChunks, redactChunkText, buildRedactionContexts, mapSegmentRefs },
} = require('../services/call-research-miner');
const { RESEARCH_TAGS } = require('../services/call-research-taxonomy');
const { validateResearchOutput, PROMPT_HASH, buildCallResearchPrompt } = require('../services/prompts/call-research-v1');

const TRANSCRIPT = `Agent: Thanks for calling Waves Pest Control, how can I help?
Caller: Hi, I keep finding little ants in the kitchen every single morning. It's driving me crazy.
Agent: We can absolutely help with that.
Caller: Do you guys also treat for iguanas? My neighbor has a huge problem.
Agent: We don't handle iguana removal, but I can point you to someone who does.
Caller: Okay. And honestly your quote was more than I wanted to spend this month.`;

describe('call-research prompt contract', () => {
  test('PROMPT_HASH is versioned, hash-stamped, and fits the column', () => {
    expect(PROMPT_HASH).toMatch(/^v1-[0-9a-f]{12}$/);
    expect(PROMPT_HASH.length).toBeLessThanOrEqual(30);
  });

  test('prompt embeds the transcript and every tag definition', () => {
    const prompt = buildCallResearchPrompt(TRANSCRIPT);
    expect(prompt).toContain('little ants in the kitchen');
    for (const tag of RESEARCH_TAGS) expect(prompt).toContain(tag);
  });

  test('valid payload passes schema validation', () => {
    const { valid } = validateResearchOutput({
      chunks: [{
        speaker: 'caller',
        quote: 'I keep finding little ants in the kitchen every single morning.',
        context: null,
        tag: 'need',
        topics: ['ants', 'kitchen'],
        service_mentioned: 'pest control',
      }],
    });
    expect(valid).toBe(true);
  });

  test('unknown tag, missing quote, and extra properties all fail', () => {
    expect(validateResearchOutput({ chunks: [{ speaker: 'caller', quote: 'hello there', tag: 'vibe' }] }).valid).toBe(false);
    expect(validateResearchOutput({ chunks: [{ speaker: 'caller', tag: 'need' }] }).valid).toBe(false);
    expect(validateResearchOutput({ chunks: [{ speaker: 'caller', quote: 'hello there', tag: 'need', customer_name: 'x' }] }).valid).toBe(false);
    expect(validateResearchOutput({}).valid).toBe(false);
  });

  test('extraction route crosses providers and defaults to the bake-off winner', () => {
    expect(CALL_RESEARCH_ROUTE.primary).toEqual({ provider: 'openai', model: expect.stringMatching(/^gpt-/) });
    expect(CALL_RESEARCH_ROUTE.fallback.provider).toBe('anthropic');
    // dispatchWithFallback rejects same-provider policies — the route must
    // never collapse to one provider, whatever the env overrides say.
    expect(CALL_RESEARCH_ROUTE.fallback.provider).not.toBe(CALL_RESEARCH_ROUTE.primary.provider);
  });
});

describe('verbatim guard', () => {
  const normalized = normalizeForMatch(TRANSCRIPT);

  test('exact quotes pass regardless of case and whitespace', () => {
    expect(isVerbatim('I keep finding little ants in the kitchen', normalized)).toBe(true);
    expect(isVerbatim('do you guys  ALSO treat for iguanas?', normalized)).toBe(true);
  });

  test('paraphrases and fabrications are rejected', () => {
    expect(isVerbatim('The customer has an ant infestation in her kitchen', normalized)).toBe(false);
    expect(isVerbatim('I want to cancel my service', normalized)).toBe(false);
  });
});

describe('chunk normalization', () => {
  const mk = (over = {}) => ({
    speaker: 'caller',
    quote: 'Do you guys also treat for iguanas?',
    context: null,
    tag: 'capability_question',
    topics: ['iguanas'],
    service_mentioned: null,
    ...over,
  });

  test('drops non-verbatim chunks and counts them', () => {
    const { chunks, dropped } = normalizeChunks([mk(), mk({ quote: 'Totally invented sentence here.', tag: 'need' })], TRANSCRIPT);
    expect(chunks).toHaveLength(1);
    expect(dropped.quote_not_verbatim).toBe(1);
  });

  test('dedupes identical tag+quote pairs', () => {
    const { chunks, dropped } = normalizeChunks([mk(), mk()], TRANSCRIPT);
    expect(chunks).toHaveLength(1);
    expect(dropped.duplicate_quote).toBe(1);
  });

  test('topics are lowercased, trimmed, and capped at 8', () => {
    const { chunks } = normalizeChunks(
      [mk({ topics: [' Iguanas ', 'WILDLIFE', ...'abcdefgh'.split('').map((c) => `topic ${c}`)] })],
      TRANSCRIPT,
    );
    expect(chunks[0].topics[0]).toBe('iguanas');
    expect(chunks[0].topics[1]).toBe('wildlife');
    expect(chunks[0].topics).toHaveLength(8);
  });
});

describe('redaction contract (double-pass, multi-context)', () => {
  test('customer name from context plus structured PII always redact', () => {
    const contexts = [{ first_name: 'Marisol', last_name: 'Vegatron', phone: '9415550000' }];
    const out = redactChunkText(
      'Hi this is Marisol Vegatron, call me back at 941-555-0000 or marisol@example.com',
      contexts,
    );
    expect(out).not.toContain('Marisol');
    expect(out).not.toContain('Vegatron');
    expect(out).not.toContain('941-555-0000');
    expect(out).not.toContain('marisol@example.com');
  });

  test('buildRedactionContexts folds in linked customer and extracted caller names', () => {
    const call = {
      ai_extraction_enriched: JSON.stringify({
        caller: { first_name: 'Rodrigo', last_name: 'Quintanilla' },
        secondary_contacts: [{ name: 'Beatrix Follywobble' }],
      }),
    };
    const contexts = buildRedactionContexts(call, { first_name: 'Marisol', last_name: 'Vegatron' });
    expect(contexts).toHaveLength(3);
    const out = redactChunkText('Rodrigo said Beatrix Follywobble and Marisol already called', contexts);
    expect(out).not.toContain('Rodrigo');
    expect(out).not.toContain('Follywobble');
    expect(out).not.toContain('Marisol');
  });

  test('unsplit name_full from the persisted extraction schema still redacts standalone first names', () => {
    const call = { ai_extraction_enriched: { caller: { name_full: 'Rodrigo Quintanilla' } } };
    const contexts = buildRedactionContexts(call, null);
    expect(contexts).toHaveLength(1);
    const out = redactChunkText('Rodrigo asked about the Quintanilla account this morning', contexts);
    expect(out).not.toContain('Rodrigo');
    expect(out).not.toContain('Quintanilla');
  });

  test('malformed enriched payloads degrade to the customer context alone', () => {
    expect(buildRedactionContexts({ ai_extraction_enriched: '{not json' }, null)).toHaveLength(0);
    expect(buildRedactionContexts({}, { first_name: 'Marisol' })).toHaveLength(1);
  });

  test('PII-bearing topics and service_mentioned are dropped, never stored with markers', () => {
    const contexts = [{ first_name: 'Marisol', last_name: 'Vegatron' }];
    const probe = (value) => redactChunkText(value, contexts) === value;
    // Mirror of the miner's dropIfPii predicate: any facet redaction would
    // alter must not survive as a facet.
    expect(probe('marisol callback request')).toBe(false);
    expect(probe('call me at 941-555-0000')).toBe(false);
    expect(probe('german roaches')).toBe(true);
    expect(probe('prepay discount')).toBe(true);
  });
});

describe('segment refs (mechanical jump-to-audio)', () => {
  const structured = JSON.stringify({
    provider: 'openai',
    segments: [
      { id: 'seg_001', index: 0, speaker: 'A', start_ms: 0, end_ms: 4000, text: 'Thanks for calling Waves Pest Control, how can I help?' },
      { id: 'seg_002', index: 1, speaker: 'B', start_ms: 4000, end_ms: 9000, text: 'I keep finding little ants in the kitchen every single morning.' },
    ],
  });

  test('maps a quote to its overlapping segment', () => {
    const refs = mapSegmentRefs('I keep finding little ants in the kitchen every single morning.', structured);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: 'seg_002', index: 1, start_ms: 4000, end_ms: 9000 });
  });

  test('returns null when nothing matches or structure is absent', () => {
    expect(mapSegmentRefs('completely unrelated words', structured)).toBeNull();
    expect(mapSegmentRefs('anything', null)).toBeNull();
    expect(mapSegmentRefs('anything', '{broken')).toBeNull();
  });
});
