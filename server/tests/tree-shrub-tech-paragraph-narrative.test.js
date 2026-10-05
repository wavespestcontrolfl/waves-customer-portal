// The tree & shrub paragraph's input gather builds the report WITHOUT any model
// call: buildTreatmentNarrative({ skipGeneration: true }) serves the cached text
// or the deterministic template, never claims the cache key and never dispatches
// the narrative lane, so the completion step makes exactly one model call.
// Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const { buildTreatmentNarrative } = require('../services/service-report/treatment-narrative');

const TREATMENT = {
  products: [{ name: 'Merit 2F', activeIngredient: 'imidacloprid', kind: 'systemic', whatItDoes: 'protects the plants from foliage-feeding pests', targets: ['scale'], method: null }],
  focus: ['Pest protection'],
  kinds: ['systemic'],
};

// A table-aware fake that records every write.
function fakeKnex({ cached = null } = {}) {
  const writes = [];
  const knex = (table) => {
    const q = {};
    ['where', 'update'].forEach((m) => { q[m] = () => q; });
    q.first = async () => cached;
    q.insert = (row) => {
      writes.push({ table, row });
      const chain = { onConflict: () => chain, ignore: () => chain, returning: () => chain, catch: async () => [{ service_record_id: 'sr-1' }] };
      return chain;
    };
    q.update = () => { writes.push({ table, update: true }); return { catch: async () => 1 }; };
    return q;
  };
  return { knex, writes };
}

beforeEach(() => dispatchWithFallback.mockReset());

test('skipGeneration with nothing cached: the template, no claim row, no model call', async () => {
  const { knex, writes } = fakeKnex();
  const out = await buildTreatmentNarrative({ serviceRecordId: 'sr-1', serviceLine: 'tree_shrub', treatment: TREATMENT, knex, skipGeneration: true });
  expect(out.text).toBeTruthy();
  expect(out.signature).toBeNull();
  expect(writes).toEqual([]);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});

test('skipGeneration with a cached narrative: the cached text, still no write and no model call', async () => {
  const cached = { summary_json: { text: 'Cached narrative text.' }, status: 'ok', generated_at: '2026-10-05T12:00:00Z' };
  const { knex, writes } = fakeKnex({ cached });
  const out = await buildTreatmentNarrative({ serviceRecordId: 'sr-1', serviceLine: 'tree_shrub', treatment: TREATMENT, knex, skipGeneration: true });
  expect(out.text).toBe('Cached narrative text.');
  expect(writes).toEqual([]);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});

test('control: without the option the narrative lane is claimed and dispatched', async () => {
  dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
  const { knex, writes } = fakeKnex();
  await buildTreatmentNarrative({ serviceRecordId: 'sr-1', serviceLine: 'tree_shrub', treatment: TREATMENT, knex });
  expect(writes.some((w) => w.row)).toBe(true);
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  expect(dispatchWithFallback.mock.calls[0][1]).toMatchObject({ laneId: 'treatment_narrative' });
});
