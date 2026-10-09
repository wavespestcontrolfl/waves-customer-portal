// GATE_LAWN_REPORT_FACTS: the completion step that reads the visit's rows, run and taps and freezes the block
// (gatherAndFreezeReportFacts), over the real catalog enrichment. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const facts = require('../services/service-report/lawn-report-facts');

const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ASSESSMENT = { id: 'as-1', customer_id: 'c-1', service_record_id: 'sr-1', confirmed_by_tech: true, confirmed_at: '2026-10-08T15:00:00Z', created_at: '2026-10-08T14:00:00Z' };
const RUN = {
  assessment_id: 'as-1',
  customer_id: 'c-1',
  reviewed_at: '2026-10-08T15:01:00Z',
  reviewed_findings: JSON.stringify([{ finding_id: 'f1', keep: true, label: 'gray leaf spot', confidence: 'high', severity: 'moderate', can_determine: true }]),
};

const catalog = (n, extra) => ({
  id: UUID(n), name: `Catalog ${n}`, category: 'herbicide', epa_reg_number: '12345-67', approved_for_service_report: true,
  rei_hours: 0, reentry_summary: 'Keep people and pets off treated areas until dry.', ...extra,
});
const CATALOG = [
  catalog(1, { category: 'herbicide' }),
  catalog(2, { category: 'fertilizer', epa_reg_number: null, product_type: 'fertilizer', post_application_watering: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' } }),
  catalog(3, { category: 'fungicide' }),
  catalog(4, { category: 'insecticide' }),
];
const productRow = (n, id, method, extra = {}) => ({
  id: `sp-${id}`, service_record_id: 'sr-1', product_id: UUID(n), product_name: `Catalog ${n}`, application_method: method, created_at: `2026-10-08T15:0${id}:00Z`, ...extra,
});

function fakeKnex(tables, { failTable = null, record = {} } = {}) {
  const state = { notes: { ...(record.notes || {}) }, writes: 0 };
  const knex = (table) => {
    if (failTable === table) {
      const dead = { where: () => dead, orderBy: () => dead, whereIn: () => dead, select: () => dead, first: () => Promise.reject(new Error('down')), catch: (fn) => Promise.resolve(fn(new Error('down'))), then: (r, j) => Promise.reject(new Error('down')).then(r, j) };
      return dead;
    }
    let rows = [...(tables[table] || [])];
    const q = {};
    q.where = (criteria, value) => {
      if (criteria && typeof criteria === 'object') rows = rows.filter((row) => Object.entries(criteria).every(([key, val]) => row[key] === val));
      else if (typeof criteria === 'string' && value !== undefined) rows = rows.filter((row) => row[criteria] === value);
      return q;
    };
    q.whereIn = (key, values) => { rows = rows.filter((row) => values.includes(row[key])); return q; };
    q.whereRaw = () => q;
    q.orderBy = () => q;
    q.select = () => q;
    q.first = () => Promise.resolve(table === 'service_records' ? { structured_notes: JSON.stringify(state.notes) } : (rows[0] || null));
    q.update = async ({ structured_notes: raw }) => {
      if (state.notes.lawnReportFacts) return 0;
      Object.assign(state.notes, JSON.parse(raw.bindings[0]));
      state.writes += 1;
      return 1;
    };
    q.catch = () => Promise.resolve(rows);
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  };
  knex.raw = (sql, bindings) => ({ sql, bindings });
  return { knex, state };
}

const tables = (productRows, extra = {}) => ({
  service_products: productRows, products_catalog: CATALOG, lawn_assessments: [ASSESSMENT], lawn_assessment_runs: [RUN], ...extra,
});
const record = (notes = {}) => ({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', structured_notes: JSON.stringify(notes) });

describe('gatherAndFreezeReportFacts', () => {
  test('freezes the re-entry rule, the spot text and the ties from one visit', async () => {
    const { knex, state } = fakeKnex(tables([
      productRow(2, 1, 'granular_broadcast'),
      productRow(1, 2, 'spot_treatment', { area_value: 250, area_unit: 'sqft' }),
      productRow(3, 3, 'spot_treatment', { area_value: 500, area_unit: 'sqft' }),
      productRow(4, 4, 'spot_treatment', { area_value: 100, area_unit: 'sqft' }),
    ]));
    const notes = { lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] } };
    const out = await facts.gatherAndFreezeReportFacts({ record: record(notes), knex, now: new Date('2026-10-08T20:00:00Z') });
    expect(out).toEqual(state.notes.lawnReportFacts);
    expect(out).toMatchObject({
      v: 1,
      frozenAt: '2026-10-08T20:00:00.000Z',
      reentry: { rule: 'watered_in_and_dry', source: 'facts' },
      productUse: { 'sp-2': { sqft: 250 }, 'sp-3': { sqft: 500 }, 'sp-4': { sqft: 100 } },
      ties: {
        assessmentId: 'as-1',
        items: [
          { source: 'technician', kind: 'chinch', product: 'insecticide' },
          { source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' },
        ],
      },
    });
    expect(out.reentry.products).toEqual([
      { id: 'sp-1', rule: 'watered_in_and_dry', source: 'facts' },
      { id: 'sp-2', rule: 'dry', source: 'facts' },
      { id: 'sp-3', rule: 'dry', source: 'facts' },
      { id: 'sp-4', rule: 'dry', source: 'facts' },
    ]);
  });

  test('the freeze is read back by every reader from the record alone', async () => {
    const { knex, state } = fakeKnex(tables([productRow(1, 1, 'spot_treatment', { area_value: 250, area_unit: 'sqft' })]));
    await facts.gatherAndFreezeReportFacts({ record: record(), knex });
    const stored = JSON.stringify(state.notes);
    expect(facts.frozenReentryRule(stored)).toMatchObject({ rule: 'dry' });
    expect(facts.frozenProductUseTexts(stored)).toEqual({ 'sp-1': 'Spot treatment, about 250 sq ft' });
    expect(facts.frozenReportFactsStamp(stored)).toMatch(/^:rf=/);
  });

  test('a spray-only visit is dry; a product with no usable fact marks the visit default', async () => {
    const spray = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]));
    expect((await facts.gatherAndFreezeReportFacts({ record: record(), knex: spray.knex })).reentry).toMatchObject({ rule: 'dry', source: 'facts' });
    const unknown = fakeKnex(tables([productRow(1, 1, 'broadcast_spray'), productRow(2, 2, 'granular_broadcast', { product_id: UUID(99) })]));
    const out = await facts.gatherAndFreezeReportFacts({ record: record(), knex: unknown.knex });
    expect(out.reentry).toMatchObject({ rule: 'default', source: 'default' });
    expect(out.reentry.products.find((p) => p.id === 'sp-2')).toEqual({ id: 'sp-2', rule: null, source: 'default' });
  });

  test('label hours default the visit (there is no timed rule); an unapproved product defaults it too', async () => {
    const catalogWithRei = [{ ...CATALOG[0], rei_hours: 12, reentry_summary: 'Keep people and pets off treated areas for 12 hours.' }, ...CATALOG.slice(1)];
    const hours = fakeKnex({ ...tables([productRow(1, 1, 'broadcast_spray')]), products_catalog: catalogWithRei });
    const out = await facts.gatherAndFreezeReportFacts({ record: record(), knex: hours.knex });
    expect(out.reentry).toMatchObject({ rule: 'default', source: 'default' });
    expect(out.reentry).not.toHaveProperty('hours');
    const unapproved = fakeKnex({ ...tables([productRow(1, 1, 'broadcast_spray')]), products_catalog: [{ ...CATALOG[0], approved_for_service_report: false }] });
    expect((await facts.gatherAndFreezeReportFacts({ record: record(), knex: unapproved.knex })).reentry).toMatchObject({ rule: 'default' });
  });

  test('already frozen: no rebuild, no second write', async () => {
    const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]));
    const done = record({ lawnReportFacts: { v: 1, reentry: { rule: 'dry', source: 'facts', products: [{ id: 'a', rule: 'dry', source: 'facts' }] }, productUse: {}, ties: { assessmentId: null, items: [] } } });
    expect(await facts.gatherAndFreezeReportFacts({ record: done, knex })).toBeNull();
    expect(state.writes).toBe(0);
  });

  test('no product rows: nothing is frozen', async () => {
    const { knex, state } = fakeKnex(tables([]));
    expect(await facts.gatherAndFreezeReportFacts({ record: record(), knex })).toBeNull();
    expect(state.writes).toBe(0);
  });

  test.each(['service_products', 'products_catalog', 'lawn_assessments', 'lawn_assessment_runs'])('a failed %s read freezes nothing', async (failTable) => {
    const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]), { failTable });
    expect(await facts.gatherAndFreezeReportFacts({ record: record(), knex })).toBeNull();
    expect(state.writes).toBe(0);
  });

  test('a visit with no assessment still freezes its re-entry rule, with no photo ties', async () => {
    const { knex } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')], { lawn_assessments: [], lawn_assessment_runs: [] }));
    const out = await facts.gatherAndFreezeReportFacts({ record: record(), knex });
    expect(out.reentry.rule).toBe('dry');
    expect(out.ties).toEqual({ assessmentId: null, items: [] });
  });

  test('a record with no id, or no knex, does nothing and never throws', async () => {
    expect(await facts.gatherAndFreezeReportFacts({ record: null, knex: () => null })).toBeNull();
    expect(await facts.gatherAndFreezeReportFacts({ record: { id: 'x' }, knex: null })).toBeNull();
  });
});
