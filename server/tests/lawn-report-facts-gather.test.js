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

function fakeKnex(tables, { failTable = null, record = {}, failUpdates = 0 } = {}) {
  const state = { notes: { ...(record.notes || {}) }, writes: 0, updateAttempts: 0 };
  const knex = (table) => {
    if (failTable === String(table).split(' as ')[0]) {
      const dead = { where: () => dead, orderBy: () => dead, whereIn: () => dead, select: () => dead, first: () => Promise.reject(new Error('down')), catch: (fn) => Promise.resolve(fn(new Error('down'))), then: (r, j) => Promise.reject(new Error('down')).then(r, j) };
      return dead;
    }
    const base = String(table).split(' as ')[0];
    let rows = [...(tables[base] || [])];
    const q = {};
    q.where = (criteria, value) => {
      if (criteria && typeof criteria === 'object') rows = rows.filter((row) => Object.entries(criteria).every(([key, val]) => row[key] === val));
      else if (typeof criteria === 'string' && value !== undefined) rows = rows.filter((row) => row[criteria] === value);
      return q;
    };
    q.whereIn = (key, values) => { const col = key.split('.').pop(); rows = rows.filter((row) => values.includes(row[col])); return q; };
    q.whereRaw = () => q;
    q.orderBy = () => q;
    q.select = () => q;
    q.first = () => Promise.resolve(table === 'service_records' ? { structured_notes: JSON.stringify(state.notes) } : (rows[0] || null));
    q.update = async ({ structured_notes: raw }) => {
      state.updateAttempts += 1;
      if (state.updateAttempts <= failUpdates) throw new Error('write failed');
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

// The program's staged rows the guide resolves its products from (lawn-treatment-guide.js): a fungicide, the
// caterpillar row, a chinch rung.
const STAGED = [
  { product_id: UUID(3), role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } },
  { product_id: UUID(4), role: 'insecticide_spot', gates: { trigger: 'chinch_20_to_25_per_sqft' } },
];
const tables = (productRows, extra = {}) => ({
  service_products: productRows, products_catalog: CATALOG, lawn_assessments: [ASSESSMENT], lawn_assessment_runs: [RUN], lawn_protocol_products: STAGED, ...extra,
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
    const notes = { lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] }, lawnSpotAreaRecorded: { v: 1, productIds: [UUID(1), UUID(3)] } };
    const out = await facts.gatherAndFreezeReportFacts({ record: record(notes), knex, withTies: true, now: new Date('2026-10-08T20:00:00Z') });
    expect(out).toEqual(state.notes.lawnReportFacts);
    expect(out).toMatchObject({
      v: 1,
      frozenAt: '2026-10-08T20:00:00.000Z',
      reentry: { rule: 'watered_in_and_dry', source: 'facts' },
      // Only the rows the technician recorded a spot area for state one; sp-4 was sized another way (a typed amount).
      productUse: { 'sp-2': { sqft: 250 }, 'sp-3': { sqft: 500 }, 'sp-4': { sqft: null } },
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
    await facts.gatherAndFreezeReportFacts({ record: record({ lawnSpotAreaRecorded: { v: 1, productIds: [UUID(1)] } }), knex });
    const stored = JSON.stringify(state.notes);
    expect(facts.frozenReentryRule(stored)).toMatchObject({ rule: 'dry' });
    expect(facts.frozenProductUseTexts(stored)).toEqual({ 'sp-1': 'Spot treatment, about 250 sq ft' });
    expect(facts.frozenReportFactsStamp(stored)).toMatch(/^:rf=/);
  });

  test('the lawn Fast Complete sheet (marker present) with no recorded area for the row: plain "Spot treatment"', async () => {
    const { knex, state } = fakeKnex(tables([productRow(1, 1, 'spot_treatment', { area_value: 5000, area_unit: 'sqft' })]));
    await facts.gatherAndFreezeReportFacts({ record: record({ lawnSpotAreaRecorded: { v: 1, productIds: [] } }), knex });
    expect(facts.frozenProductUseTexts(JSON.stringify(state.notes))).toEqual({ 'sp-1': 'Spot treatment' });
  });

  test('another surface (no marker): no spot text is frozen, so the recorded application area renders as today', async () => {
    const { knex, state } = fakeKnex(tables([
      productRow(1, 1, 'spot_treatment', { area_value: 5000, area_unit: 'sqft', application_area: 'Front lawn' }),
      productRow(3, 2, 'spot_treatment', { area_value: 400, area_unit: 'sqft' }),
    ]));
    await facts.gatherAndFreezeReportFacts({ record: record(), knex });
    expect(state.notes.lawnReportFacts.productUse).toEqual({});
    expect(facts.frozenProductUseTexts(JSON.stringify(state.notes))).toEqual({});
    // The block still carries the re-entry rule: only the spot text is surface-specific.
    expect(state.notes.lawnReportFacts.reentry.rule).toBe('dry');
  });

  test('the lawn Fast Complete sheet: a row with an explicit recorded location keeps it (no spot text); the others are described', async () => {
    const { knex, state } = fakeKnex(tables([
      productRow(1, 1, 'spot_treatment', { area_value: 250, area_unit: 'sqft', application_area: 'Front lawn' }),
      productRow(3, 2, 'spot_treatment', { area_value: 400, area_unit: 'sqft', application_area: 'Front yard, Back yard, Side yards' }),
      productRow(4, 3, 'spot_treatment', { area_value: 5000, area_unit: 'sqft' }),
    ]));
    await facts.gatherAndFreezeReportFacts({ record: record({ lawnSpotAreaRecorded: { v: 1, productIds: [UUID(3)] } }), knex });
    expect(facts.frozenProductUseTexts(JSON.stringify(state.notes))).toEqual({ 'sp-2': 'Spot treatment, about 400 sq ft', 'sp-3': 'Spot treatment' });
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

  describe('one attempt decides: a failed attempt records a MARKED block, so nothing can freeze different facts later', () => {
    const FAILED = { v: 1, failed: true, productUse: {} };

    test.each(['service_products', 'products_catalog', 'lawn_assessments', 'lawn_assessment_runs', 'lawn_protocol_products'])('a failed %s read records the marker (no rule, no spot text, no ties)', async (failTable) => {
      const notes = { lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] } };
      const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray'), productRow(4, 2, 'spot_treatment', { area_value: 100, area_unit: 'sqft' })]), { failTable });
      const out = await facts.gatherAndFreezeReportFacts({ record: record(notes), knex, withTies: true });
      expect(out).toMatchObject(FAILED);
      expect(state.notes.lawnReportFacts).toMatchObject(FAILED);
      expect(state.notes.lawnReportFacts).not.toHaveProperty('reentry');
      expect(state.notes.lawnReportFacts).not.toHaveProperty('ties');
      expect(state.writes).toBe(1);
    });

    test('what a render reads from the marker is today\'s default: no rule (the clock), no spot text, no ties, no PDF-key change', async () => {
      const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]), { failTable: 'products_catalog' });
      await facts.gatherAndFreezeReportFacts({ record: record(), knex, withTies: true });
      const stored = JSON.stringify(state.notes);
      expect(facts.readFrozenReportFacts(stored)).not.toBeNull();
      expect(facts.frozenReentryRule(stored)).toBeNull();
      expect(facts.frozenReentryForRecord({ structured_notes: stored })).toBeNull();
      expect(facts.frozenProductUseTexts(stored)).toEqual({});
      expect(facts.frozenTies(stored, 'as-1')).toEqual([]);
      expect(facts.frozenTiedFamilies(stored, 'as-1')).toEqual([]);
      expect(facts.hasFrozenTieBlock(stored, 'as-1')).toBe(false);
      expect(facts.frozenReportFactsStamp(stored)).toBe('');
    });

    test('a failing early attempt followed by a succeeding later call: the later call changes nothing (the marker stands)', async () => {
      const failing = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]), { failTable: 'lawn_assessment_runs' });
      await facts.gatherAndFreezeReportFacts({ record: record(), knex: failing.knex, withTies: true });
      expect(failing.state.notes.lawnReportFacts).toMatchObject({ failed: true });
      // The read recovers; the record the later call loads carries the marker.
      const healthy = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]));
      healthy.state.notes = JSON.parse(JSON.stringify(failing.state.notes));
      const later = await facts.gatherAndFreezeReportFacts({ record: record(healthy.state.notes), knex: healthy.knex, withTies: true });
      expect(later).toBeNull();
      expect(healthy.state.writes).toBe(0);
      expect(healthy.state.notes.lawnReportFacts).toMatchObject({ failed: true });
      expect(healthy.state.notes.lawnReportFacts).not.toHaveProperty('ties');
    });

    test('a find whose verification READ failed fails the attempt (the visit is not frozen without a find it could not check)', async () => {
      const notes = { lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] } };
      const { knex, state } = fakeKnex(tables([productRow(4, 1, 'spot_treatment')]), { failTable: 'lawn_protocol_products' });
      await facts.gatherAndFreezeReportFacts({ record: record(notes), knex, withTies: true });
      expect(state.notes.lawnReportFacts).toMatchObject({ failed: true });
      expect(state.notes.lawnReportFacts).not.toHaveProperty('ties');
    });

    test('ties are not frozen after the copy or the summary already froze without a block (they would disagree with it)', async () => {
      for (const frozenKey of ['lawnCopyV6', 'lawnVisitSummary']) {
        const notes = { [frozenKey]: { 'as-1': { v: 1 } }, lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] } };
        const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray'), productRow(4, 2, 'spot_treatment')]));
        const out = await facts.gatherAndFreezeReportFacts({ record: record(notes), knex, withTies: true });
        expect(out).toMatchObject({ v: 1, reentry: { rule: 'dry' } });
        expect(state.notes.lawnReportFacts).not.toHaveProperty('ties');
        expect(state.notes.lawnReportFacts).not.toHaveProperty('failed');
      }
    });

    test('the FIRST WRITE fails (freezeReportFacts answers null): that is a failed attempt, so the marker is attempted', async () => {
      const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]), { failUpdates: 1 });
      const out = await facts.gatherAndFreezeReportFacts({ record: record(), knex, withTies: true });
      expect(state.updateAttempts).toBe(2);
      expect(out).toMatchObject({ v: 1, failed: true });
      expect(state.notes.lawnReportFacts).toMatchObject({ failed: true });
      expect(state.notes.lawnReportFacts).not.toHaveProperty('ties');
      expect(state.notes.lawnReportFacts).not.toHaveProperty('reentry');
    });

    test('the marker write fails TOO: nothing is on the record, nothing throws, and the answer is the unresolved sentinel (never a block)', async () => {
      const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')]), { failUpdates: 2 });
      const out = await facts.gatherAndFreezeReportFacts({ record: record(), knex, withTies: true });
      expect(state.updateAttempts).toBe(2);
      expect(out).toBe(facts.UNRESOLVED_FREEZE);
      expect(facts.isUnresolvedFreeze(out)).toBe(true);
      expect(state.notes.lawnReportFacts).toBeUndefined();
      expect(facts.frozenBlockOf(out)).toBeNull();
      expect(facts.frozenBlockOf(null)).toBeNull();
      expect(facts.frozenBlockOf({ v: 1 })).toEqual({ v: 1 });
    });

    test('while the freeze is unresolved the PDF pre-render gets no token; otherwise the token passes through', () => {
      expect(facts.pdfPreRenderToken('tok', facts.UNRESOLVED_FREEZE)).toBeNull();
      for (const early of [null, undefined, { v: 1 }, { v: 1, failed: true }]) expect(facts.pdfPreRenderToken('tok', early)).toBe('tok');
    });

    test('...then, once the v6 copy has frozen without a block, the later call freezes NO ties (first write and marker both failed earlier)', async () => {
      const first = fakeKnex(tables([productRow(1, 1, 'broadcast_spray'), productRow(4, 2, 'spot_treatment')]), { failUpdates: 2 });
      const notes = { lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] } };
      expect(await facts.gatherAndFreezeReportFacts({ record: record(notes), knex: first.knex, withTies: true })).toBe(facts.UNRESOLVED_FREEZE);
      // A render (the PDF worker, a view) now freezes the v6 copy with no block on the record.
      const withCopy = { ...notes, lawnCopyV6: { 'as-1': { v: 1, fields: {} } } };
      const later = fakeKnex(tables([productRow(1, 1, 'broadcast_spray'), productRow(4, 2, 'spot_treatment')]));
      const out = await facts.gatherAndFreezeReportFacts({ record: record(withCopy), knex: later.knex, withTies: true });
      expect(out).toMatchObject({ v: 1, reentry: { rule: 'dry' } });
      expect(later.state.notes.lawnReportFacts).not.toHaveProperty('ties');
      expect(later.state.notes.lawnReportFacts).not.toHaveProperty('failed');
    });

    test('...and with no copy yet, the later call may simply succeed with its ties (copy then freezes with them)', async () => {
      const later = fakeKnex(tables([productRow(1, 1, 'broadcast_spray'), productRow(4, 2, 'spot_treatment')]));
      const notes = { lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] } };
      const out = await facts.gatherAndFreezeReportFacts({ record: record(notes), knex: later.knex, withTies: true });
      expect(out.ties.items).toContainEqual({ source: 'technician', kind: 'chinch', product: 'insecticide' });
    });
  });

  test('a visit with no assessment still freezes its re-entry rule, with no photo ties', async () => {
    const { knex } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray')], { lawn_assessments: [], lawn_assessment_runs: [] }));
    const out = await facts.gatherAndFreezeReportFacts({ record: record(), knex, withTies: true });
    expect(out.reentry.rule).toBe('dry');
    expect(out.ties).toEqual({ assessmentId: null, items: [] });
  });

  test('the tie part not live (the default): no assessment or run is read, no tie key is stored, the key is unchanged by a tie', async () => {
    const notes = { lawnTreatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [UUID(4)] }] } };
    const { knex, state } = fakeKnex(tables([productRow(1, 1, 'broadcast_spray'), productRow(3, 2, 'spot_treatment'), productRow(4, 3, 'spot_treatment')]), { failTable: 'lawn_assessments' });
    const out = await facts.gatherAndFreezeReportFacts({ record: record(notes), knex });
    expect(out).toMatchObject({ v: 1, reentry: { rule: 'dry' } });
    expect(out).not.toHaveProperty('ties');
    expect(state.notes.lawnReportFacts).not.toHaveProperty('ties');
    expect(facts.frozenTies(JSON.stringify(state.notes), 'as-1')).toEqual([]);
    expect(facts.frozenTiedFamilies(JSON.stringify(state.notes), 'as-1')).toEqual([]);
  });

  test('a record with no id, or no knex, does nothing and never throws', async () => {
    expect(await facts.gatherAndFreezeReportFacts({ record: null, knex: () => null })).toBeNull();
    expect(await facts.gatherAndFreezeReportFacts({ record: { id: 'x' }, knex: null })).toBeNull();
  });
});
