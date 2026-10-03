// P19b: the answer validator is the dispatcher's per-leg check, so an
// INCOMPLETE answer must fail its leg and let the fallback provider run.
// Unlike lawn-paired-recheck.test.js this file uses the REAL dispatcher
// (services/llm/call.js), mocking only the two providers' HTTP transport, so
// "the second provider was called" is observed, not assumed. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const recheck = require('../services/lawn-paired-recheck');
const shotList = require('../services/lawn-photo-shots');

const CUR = 'as-cur';
const PRIOR = 'as-prior';
const META = JSON.stringify([{ photoVocabulary: shotList.PHOTO_VOCABULARY }]);
const photo = (assessmentId, zone) => ({
  id: `${assessmentId}-${zone}`, assessment_id: assessmentId, zone, s3_key: `k/${assessmentId}/${zone}`, mime_type: 'image/jpeg',
  quality_score: '80', quality_gate_passed: true, photo_order: 0,
});

const complete = () => ({
  pairs: [1, 2].map((pair) => ({ pair, verdict: 'better', what_changed: ['color'] })),
  items: [
    { item: 'weeds', verdict: 'better', what_changed: ['color'], pairs: [1] },
    { item: 'water', verdict: 'cannot_tell', what_changed: [], pairs: [] },
  ],
});

function world() {
  const entry = {
    v: 1, assessmentId: CUR, serviceDate: '2026-09-30', applied: [], checks: [],
    sinceLast: { v: 1, priorAssessmentId: PRIOR, priorDate: '2026-08-30', applied: [], checks: [{ key: 'weeds', status: 'watch' }, { key: 'water', status: 'watch' }] },
  };
  const rows = [
    { id: CUR, customer_id: 'c1', property_id: 'p1', photos: META },
    { id: PRIOR, customer_id: 'c1', property_id: 'p1', photos: META },
  ];
  const photos = ['front', 'back', 'side'].flatMap((z) => [photo(CUR, z), photo(PRIOR, z)]);
  const record = { structured_notes: { lawnVisitMemory: { [CUR]: entry } } };
  const writes = [];
  const knex = (table) => {
    const ctx = { ids: [], where: {}, raw: null };
    const chain = {
      whereIn(_c, ids) { ctx.ids = ids.map(String); return chain; },
      select() { return Promise.resolve(table === 'lawn_assessments' ? rows.filter((r) => ctx.ids.includes(r.id)) : photos.filter((r) => ctx.ids.includes(r.assessment_id))); },
      where() { return chain; },
      whereRaw(_s, b) { ctx.raw = b; return chain; },
      async first() { return { structured_notes: record.structured_notes }; },
      async update(patch) {
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        record.structured_notes = { ...record.structured_notes, lawnVisitMemory: { ...record.structured_notes.lawnVisitMemory, ...add } };
        writes.push(add);
        return 1;
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { entry, knex, record, writes };
}

const geminiBody = (json) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }] }) });
const openaiBody = (json) => ({ ok: true, json: async () => ({ output_text: JSON.stringify(json) }) });

describe('an incomplete answer fails its leg and the fallback provider runs', () => {
  let originalFetch; let saved; let calls;
  beforeEach(() => {
    saved = { g: process.env.GEMINI_API_KEY, o: process.env.OPENAI_API_KEY, gate: process.env.GATE_LAWN_PAIRED_RECHECK, mem: process.env.GATE_LAWN_VISIT_MEMORY, ph: process.env.GATE_LAWN_PROPERTY_HISTORY };
    process.env.GEMINI_API_KEY = 'test'; process.env.OPENAI_API_KEY = 'test';
    process.env.GATE_LAWN_PAIRED_RECHECK = 'true'; process.env.GATE_LAWN_VISIT_MEMORY = 'true'; process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    originalFetch = global.fetch;
    calls = [];
  });
  afterEach(() => {
    global.fetch = originalFetch;
    for (const [k, v] of [['GEMINI_API_KEY', saved.g], ['OPENAI_API_KEY', saved.o], ['GATE_LAWN_PAIRED_RECHECK', saved.gate], ['GATE_LAWN_VISIT_MEMORY', saved.mem], ['GATE_LAWN_PROPERTY_HISTORY', saved.ph]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const route = (gemini, openai) => {
    global.fetch = jest.fn(async (url) => {
      const which = String(url).includes('generativelanguage') ? 'gemini' : 'openai';
      calls.push(which);
      return which === 'gemini' ? gemini() : openai();
    });
  };
  const run = (w) => recheck.runPairedRecheck(
    { serviceRecordId: 'svc', assessmentId: CUR, entry: w.entry },
    { knex: w.knex, photoService: { getPhotoBase64: async () => ({ data: 'QQ==', mimeType: 'image/jpeg' }) } },
  );

  const p = (n) => ({ pair: n, verdict: 'better', what_changed: ['color'] });
  const it = (item) => ({ item, verdict: 'better', what_changed: ['color'], pairs: [1] });
  const incomplete = {
    'a missing pair': { ...complete(), pairs: [p(1)] },
    'an extra pair': { ...complete(), pairs: [p(1), p(2), p(3)] },
    'a duplicate pair': { ...complete(), pairs: [p(1), p(2), p(2)] },
    'a missing item': { ...complete(), items: [it('weeds')] },
    'an unknown item': { ...complete(), items: [it('weeds'), it('water'), it('mowing')] },
    'a duplicate item': { ...complete(), items: [it('weeds'), it('weeds')] },
    'empty arrays': { pairs: [], items: [] },
  };

  test.each(Object.entries(incomplete))('%s from Gemini: Gemini\'s leg is rejected, OpenAI answers, and its complete answer is stored', async (_name, bad) => {
    const w = world();
    route(() => geminiBody(bad), () => openaiBody(complete()));
    const out = await run(w);
    expect(calls).toEqual(['gemini', 'openai']);
    expect(out).toMatchObject({ status: 'stored', written: ['weeds'] });
    expect(w.record.structured_notes.lawnVisitMemory[CUR].sinceLast.checks[0].recheck).toMatchObject({ verdict: 'better', source: 'photo_pair' });
  });

  test('a complete Gemini answer is accepted and the fallback is never called', async () => {
    const w = world();
    route(() => geminiBody(complete()), () => openaiBody(complete()));
    await run(w);
    expect(calls).toEqual(['gemini']);
  });

  test('every leg incomplete: both providers tried, nothing written, nothing thrown', async () => {
    const w = world();
    route(() => geminiBody({ pairs: [], items: [] }), () => openaiBody({ ...complete(), items: [] }));
    const out = await run(w);
    expect(calls).toEqual(['gemini', 'openai']);
    expect(out.status).toBe('unavailable');
    expect(w.writes).toEqual([]);
    expect(w.record.structured_notes.lawnVisitMemory[CUR].sinceLast.checks).toEqual([{ key: 'weeds', status: 'watch' }, { key: 'water', status: 'watch' }]);
  });
});
