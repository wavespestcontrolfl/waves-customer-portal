// A label's limit on applications in a row (protocols audit 2026-11-26, item 5).
//
// Velista (EPA 100-1534), Resistance Management: "Do not make more than two successive applications of Velista; these two
// applications should be followed by applications of fungicides from a different FRAC mode of action group." The fall
// large patch calendar could direct Velista in October, November and December on a lawn mapped for take-all too.

const {
  evaluateWaveGuardManagerApprovals,
  managerApprovalSummary,
  successiveRun,
  SUCCESSIVE_USE_LIMITS,
  SUCCESSIVE_USE_CODE,
} = require('../services/waveguard-approval-engine');
const lawnProtocol = require('../config/lawn-protocol-v13.json');

const VELISTA = SUCCESSIVE_USE_LIMITS.find((limit) => limit.epa === '100-1534');
const velista = (day, over = {}) => ({ service_date: day, product_name: 'Velista', catalog_epa: '100-1534', catalog_group: '7', ...over });
const artavia = (day, over = {}) => ({ service_date: day, product_name: 'Artavia 2 SC (Azoxy)', catalog_epa: '91234-74', catalog_group: '11', catalog_moa_group: 'Group 11', ...over });
const headway = (day) => ({ service_date: day, product_name: 'Headway Fungicide', catalog_epa: '100-1216', catalog_group: '3 + 11', catalog_moa_group: 'Group 11 + 3' });

describe('successiveRun: the product\'s unbroken run that ends at the lawn\'s latest fungicide date', () => {
  test('the list holds Velista at two in a row, by its registration number', () => {
    expect(VELISTA).toMatchObject({ max: 2, group: '7' });
    expect(VELISTA.source).toMatch(/100-1534/);
  });

  test('the fall calendar of a lawn mapped for take-all and large patch: October and November make two', () => {
    // September Artavia (take-all), October Headway (take-all) with Velista (large patch), November Velista.
    const rows = [velista('2026-11-03'), velista('2026-10-06'), headway('2026-10-06'), artavia('2026-09-08')];
    expect(successiveRun(VELISTA, rows)).toEqual(['2026-11-03', '2026-10-06']);
  });

  test('a date that carries Velista counts, alone or in a tank mix', () => {
    expect(successiveRun(VELISTA, [velista('2026-11-03'), velista('2026-10-06'), artavia('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
  });

  test('a date with a fungicide of another group and no Velista ends the run', () => {
    expect(successiveRun(VELISTA, [artavia('2026-12-01'), velista('2026-11-03'), velista('2026-10-06')])).toEqual([]);
    expect(successiveRun(VELISTA, [velista('2026-12-01'), artavia('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-12-01']);
    // A mixed product (Headway: groups 3 and 11) is another group too.
    expect(successiveRun(VELISTA, [velista('2026-12-01'), headway('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-12-01']);
  });

  test('a date whose fungicides are all Group 7, or of no group on file, neither counts nor ends the run', () => {
    const otherSeven = { service_date: '2026-10-20', product_name: 'Another SDHI', catalog_epa: '1-2', catalog_group: '7' };
    const unknown = { service_date: '2026-10-21', product_name: 'Hand entry', catalog_epa: null, catalog_group: null, moa_group: null };
    expect(successiveRun(VELISTA, [velista('2026-11-03'), unknown, otherSeven, velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
  });

  test('a history row with no catalog row is Velista by its name', () => {
    const byName = { service_date: '2026-11-03', product_name: 'Velista', catalog_epa: null, catalog_group: null };
    expect(successiveRun(VELISTA, [byName, velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    // Another product is not Velista by a like name, and a catalog row with another registration is not Velista.
    expect(successiveRun(VELISTA, [{ ...byName, product_name: 'Not Velista' }, velista('2026-10-06')])).toEqual(['2026-10-06']);
    expect(successiveRun(VELISTA, [{ ...byName, catalog_epa: '999-1', catalog_group: '11' }, velista('2026-10-06')])).toEqual([]);
  });

  test('a Date from the driver reads as its day, and no history is no run', () => {
    expect(successiveRun(VELISTA, [velista(new Date('2026-11-03T00:00:00Z')), velista(new Date('2026-10-06T00:00:00Z'))])).toEqual(['2026-11-03', '2026-10-06']);
    expect(successiveRun(VELISTA, [])).toEqual([]);
    expect(successiveRun(VELISTA, null)).toEqual([]);
  });
});

// The engine's reads: the catalog rows, the turf profile, the repeat-group lookup (answered empty here) and the
// fungicide history read, which is the one with a lower date bound.
function fakeKnex({ catalog, history = [], fail = false, seen = {} }) {
  return (table) => {
    const state = { since: null, before: null, property: undefined, scoped: false };
    const settle = async () => {
      if (table === 'products_catalog') return catalog;
      if (table === 'customer_turf_profiles') return null;
      if (table !== 'service_products as sp' || !state.since) return [];
      if (fail) throw new Error('history read failed');
      Object.assign(seen, state);
      return history.filter((row) => row.service_date < state.before && row.service_date >= state.since
        && (row.property_id == null || row.property_id === state.property));
    };
    const query = {
      join: () => query, leftJoin: () => query, orderBy: () => query, select: () => query, limit: () => query, first: () => query,
      whereIn: () => query, whereNull: () => query,
      modify: (fn) => { fn(query); return query; },
      whereRaw: (_sql, bindings) => { state.scoped = true; state.property = bindings?.[0]; return query; },
      where: (...args) => {
        if (typeof args[0] === 'function') {
          const group = { where: () => group, orWhere: () => group, orWhereRaw: () => group };
          args[0].call(group);
        } else if (args[0] === 'sr.service_date' && args[1] === '>=') state.since = args[2];
        else if (args[0] === 'sr.service_date' && args[1] === '<') state.before = args[2];
        return query;
      },
      then: (resolve, reject) => settle().then(resolve, reject),
      catch: (reject) => settle().catch(reject),
    };
    return query;
  };
}

const CATALOG = [
  { id: 'vel', name: 'Velista', category: 'fungicide', epa_reg_number: '100-1534', frac_group: '7' },
  { id: 'art', name: 'Artavia 2 SC (Azoxy)', category: 'fungicide', epa_reg_number: '91234-74', frac_group: '11' },
];
const plan = { protocol: { base: [], conditional: [] }, mixCalculator: { items: [{ productId: 'vel' }, { productId: 'art' }] }, propertyGate: { latestAssessment: { stressFlags: {} } } };
const evaluate = (history, { product = 'vel', serviceDate = '2026-12-01', propertyId = 'home', ...rest } = {}) => evaluateWaveGuardManagerApprovals(
  fakeKnex({ catalog: CATALOG, history, ...rest }),
  { customerId: 'customer-1', service: { service_type: 'Lawn Care', property_id: propertyId }, plan, serviceDate, products: [{ productId: product }], strict: rest.strict },
);
const limitBlocks = (result) => result.blocks.filter((block) => block.code === SUCCESSIVE_USE_CODE);

describe('the approval engine names a third Velista in a row', () => {
  const fall = [velista('2026-11-03'), velista('2026-10-06'), headway('2026-10-06'), artavia('2026-09-08')];

  test('December Velista after October and November: one finding, with the dates and the label limit', async () => {
    const [block, ...more] = limitBlocks(await evaluate(fall));
    expect(more).toEqual([]);
    expect(block).toMatchObject({
      severity: 'block', approvable: false, productId: 'vel', productName: 'Velista',
      evidence: { limit: 2, dates: ['2026-11-03', '2026-10-06'] },
    });
    expect(block.message).toBe("Velista was the lawn's last 2 fungicide applications (2026-10-06, 2026-11-03). Its label allows no more than 2 in a row: use a fungicide of another group.");
    // The job card cuts a block message at 200 characters.
    expect(block.message.length).toBeLessThanOrEqual(200);
  });

  test('the second Velista in a row, and Velista after another group, raise nothing', async () => {
    expect(limitBlocks(await evaluate(fall, { serviceDate: '2026-11-03' }))).toEqual([]);
    expect(limitBlocks(await evaluate([artavia('2026-11-20'), ...fall]))).toEqual([]);
    expect(limitBlocks(await evaluate([]))).toEqual([]);
  });

  test('another product is never judged, and reads no history', async () => {
    const seen = {};
    expect(limitBlocks(await evaluate(fall, { product: 'art', seen }))).toEqual([]);
    expect(seen).toEqual({});
  });

  test('the history is this lawn\'s, one year back: another property and an older pair do not count', async () => {
    const seen = {};
    const elsewhere = fall.map((row) => ({ ...row, property_id: 'other-home' }));
    expect(limitBlocks(await evaluate(elsewhere, { seen }))).toEqual([]);
    expect(seen).toMatchObject({ scoped: true, property: 'home', before: '2026-12-01', since: '2025-12-01' });
    expect(limitBlocks(await evaluate([velista('2025-11-03'), velista('2025-10-06')]))).toEqual([]);
    // An application that names no property may have been made here: it counts.
    expect(limitBlocks(await evaluate(fall.map((row) => ({ ...row, property_id: null }))))).toHaveLength(1);
  });

  test('a failed history read throws when strict (the job card withholds), else reads as no finding', async () => {
    await expect(evaluate(fall, { fail: true, strict: true })).rejects.toThrow('history read failed');
    expect(limitBlocks(await evaluate(fall, { fail: true }))).toEqual([]);
  });

  test('the close-out record keeps the mark: an approval does not make it a permitted application', async () => {
    const { blocks } = await evaluate(fall);
    const summary = managerApprovalSummary({ reasonCode: 'reviewed' }, blocks, { technicianId: 't1', role: 'admin' });
    expect(summary.blocks.find((block) => block.code === SUCCESSIVE_USE_CODE)).toMatchObject({ approvable: false, evidence: { limit: 2 } });
    expect(managerApprovalSummary({ reasonCode: 'reviewed' }, [{ code: 'off_protocol_product', message: 'x' }], {}).blocks[0]).not.toHaveProperty('approvable');
  });
});

describe('the lawn card no longer directs a third Velista', () => {
  test.each(['st_augustine', 'bermuda', 'zoysia'])('%s: December gives Artavia after Velista in October and November', (track) => {
    const { notes, visits } = lawnProtocol[track];
    const lines = (month) => visits.find((visit) => visit.month === month).secondary.split('\n');
    const line = (month, product) => lines(month).find((text) => text.startsWith(`${product} — `));

    expect(line('Dec', 'Velista')).toMatch(/took Velista in only one of October and November/);
    expect(line('Dec', 'Velista')).toMatch(/never a third Velista application in a row \(label\)/);
    expect(line('Dec', 'Artavia 2 SC (Azoxy)')).toMatch(/also mapped for take-all that took Velista in both October and November/);
    expect(line('Nov', 'Velista')).toMatch(/never as a third Velista application in a row/);

    const largePatch = notes.find((note) => note.startsWith('Large patch:'));
    expect(largePatch).toMatch(/no more than two Velista applications in a row/);
    expect(largePatch).not.toMatch(/its December curative is Velista\./);
  });
});
