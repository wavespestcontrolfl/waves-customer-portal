// Pest Insider writer: one single-turn JSON call on the pest_insider lane, model mocked.
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const { writeIssue, shapeProblem, systemPrompt, userText, OUTPUT_SCHEMA } = require('../services/pest-insider/writer');
const { factById } = require('../services/pest-insider/facts');
const { SPECIES } = require('../services/pest-insider/plan');
const { LANES } = require('../services/model-switchboard');

const FACT = factById('M01');
const SPECIES_ENTRY = SPECIES.find((s) => s.slug === 'aedes-mosquito');
const REPLY = {
  subject: '🦟 Mosquito eggs wait 8 months dry',
  preview: 'Dry does not mean gone.',
  lead: { headline: 'Dry eggs', sentences: [{ text: 'a', fact_id: 'M01' }, { text: 'b', fact_id: 'M01' }] },
  id_item: { text: 'c' },
};

beforeEach(() => dispatchWithFallback.mockReset());

describe('writeIssue', () => {
  test('makes one JSON call on the pest_insider lane with the newsletterWriter policy and the schema', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: REPLY, provider: 'anthropic', model: 'm' });
    const out = await writeIssue({ sendDate: '2026-12-03', leadFact: FACT, idItem: SPECIES_ENTRY });
    expect(out).toEqual({ ok: true, draft: REPLY, provider: 'anthropic', model: 'm' });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    // newsletterWriter models and fallback, with the primary effort lowered to 'medium' (the job is a short restatement)
    expect(policy.primary).toEqual({ ...MODELS.TEXT_POLICIES.newsletterWriter.primary, effort: 'medium' });
    expect(policy.fallback).toBe(MODELS.TEXT_POLICIES.newsletterWriter.fallback);
    expect(payload.laneId).toBe('pest_insider');
    expect(payload.jsonMode).toBe(true);
    expect(payload.jsonSchema).toBe(OUTPUT_SCHEMA);
    expect(typeof payload.system).toBe('string');
    expect(typeof payload.text).toBe('string');
    // single turn, no tools, no images, no documents, no streaming
    for (const key of ['tools', 'images', 'documents', 'messages', 'stream']) expect(payload).not.toHaveProperty(key);
    expect(options.reserveFallbackBudget).toBe(true);
  });

  test('the user message carries only the lead fact and the species entry', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: REPLY, provider: 'anthropic', model: 'm' });
    await writeIssue({ sendDate: '2026-12-03', leadFact: FACT, idItem: SPECIES_ENTRY });
    const sent = JSON.parse(dispatchWithFallback.mock.calls[0][1].text);
    expect(sent.send_month).toBe('December');
    expect(sent.lead_fact).toMatchObject({ fact_id: 'M01', statement: FACT.statement });
    expect(sent.lead_fact.source_text).toEqual(FACT.quotes.map((text) => ({ text, say_the_source_as: 'CDC' })));
    expect(sent.species).toEqual({ name: SPECIES_ENTRY.name, category: SPECIES_ENTRY.category, fact: SPECIES_ENTRY.fact, note: SPECIES_ENTRY.note });
    expect(Object.keys(sent).sort()).toEqual(['lead_fact', 'send_month', 'species']);
  });

  test('each quote of a two-publisher fact carries its own publisher', async () => {
    const { factById } = require('../services/pest-insider/facts');
    const M02 = factById('M02');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: REPLY, provider: 'anthropic', model: 'm' });
    await writeIssue({ sendDate: '2026-07-02', leadFact: M02, idItem: SPECIES_ENTRY });
    const sent = JSON.parse(dispatchWithFallback.mock.calls[0][1].text);
    const byLabel = sent.lead_fact.source_text.map((q) => q.say_the_source_as);
    expect(byLabel).toEqual(['CDC', 'CDC', 'UF/IFAS', 'UF/IFAS']);
    expect(sent.lead_fact.source_text[2].text).toMatch(/long flight range/);
    expect(sent.lead_fact).not.toHaveProperty('say_the_source_as');
  });

  test('a reply that is not the schema shape fails over through the chain validator', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: REPLY, provider: 'anthropic', model: 'm' });
    await writeIssue({ sendDate: '2026-12-03', leadFact: FACT, idItem: SPECIES_ENTRY });
    const validate = dispatchWithFallback.mock.calls[0][2].validate;
    expect(validate({ json: REPLY })).toBeNull();
    expect(validate({ json: { ...REPLY, id_item: {} } })).toBe('missing_id_item');
  });

  test('reports the chain failure reason', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'anthropic_timeout', failures: [] });
    expect(await writeIssue({ sendDate: '2026-12-03', leadFact: FACT, idItem: SPECIES_ENTRY })).toEqual({ ok: false, reason: 'anthropic_timeout' });
    dispatchWithFallback.mockResolvedValue({ ok: true });
    expect((await writeIssue({ sendDate: '2026-12-03', leadFact: FACT, idItem: SPECIES_ENTRY })).ok).toBe(false);
  });

  test('a caller can ask for another effort; only the primary leg changes', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: REPLY, provider: 'anthropic', model: 'm' });
    await writeIssue({ sendDate: '2026-12-03', leadFact: FACT, idItem: SPECIES_ENTRY, effort: 'high' });
    const policy = dispatchWithFallback.mock.calls[0][0];
    expect(policy.primary.effort).toBe('high');
    expect(policy.fallback).toBe(MODELS.TEXT_POLICIES.newsletterWriter.fallback);
  });
});

describe('prompt, schema and lane registration', () => {
  test('the prompt carries the writing rules', () => {
    const p = systemPrompt();
    for (const rule of [/Restate the lead fact/, /Name a publisher once/, /Credit each publisher only for its own source text/, /never move a number from one claim to another/, /DIY steps/, /pesticide, active ingredient, product or brand/, /price or a dollar sign/, /"safe"/, /At most one sentence may mention Waves/, /80 characters/]) expect(p).toMatch(rule);
    expect(userText({ month: 'December', leadFact: FACT, idItem: SPECIES_ENTRY })).not.toMatch(/\bnull\b/);
  });

  test('the schema is strict: every object closed with every key required (llm/call.js jsonSchema contract)', () => {
    const walk = (node) => {
      if (node && node.type === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
        Object.values(node.properties).forEach(walk);
      }
      if (node && node.type === 'array') walk(node.items);
    };
    walk(OUTPUT_SCHEMA);
  });

  test('shapeProblem names what is missing', () => {
    expect(shapeProblem(null)).toBe('not_an_object');
    expect(shapeProblem({ ...REPLY, subject: '' })).toBe('missing_subject_or_preview');
    expect(shapeProblem({ ...REPLY, lead: { headline: 'x', sentences: [] } })).toBe('missing_lead');
    expect(shapeProblem({ ...REPLY, lead: { headline: 'x', sentences: [{ text: 'a' }] } })).toBe('bad_lead_sentence');
    expect(shapeProblem(REPLY)).toBeNull();
  });

  test('pest_insider is a registered switchboard lane on the newsletterWriter policy', () => {
    const lane = LANES.find((l) => l.id === 'pest_insider');
    expect(lane).toBeTruthy();
    expect(lane.file).toBe('pest-insider/writer.js');
  });
});
