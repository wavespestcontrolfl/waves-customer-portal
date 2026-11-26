// A label's limit on applications in a row (protocols audit 2026-11-26, item 5).
//
// Velista (EPA 100-1534), Resistance Management: "Do not make more than two successive applications of Velista; these two
// applications should be followed by applications of fungicides from a different FRAC mode of action group." The fall
// large patch calendar could direct Velista in October, November and December on a lawn mapped for take-all too.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  evaluateWaveGuardManagerApprovals,
  managerApprovalSummary,
  successiveRun,
  latestApplicationCarries,
  SUCCESSIVE_USE_LIMITS,
  SUCCESSIVE_USE_CODE,
} = require('../services/waveguard-approval-engine');
const lawnProtocol = require('../config/lawn-protocol-v13.json');

const VELISTA = SUCCESSIVE_USE_LIMITS.find((limit) => limit.epa === '100-1534');
const HOME = 'home';
// One history row = one product of one completed service record. `record` defaults to the date: one visit a day.
const row = (day, product, over = {}) => ({ service_record_id: over.record || `r-${day}`, service_date: day, recorded_at: `${day}T15:00:00Z`, treated_property_id: HOME, ...product, ...over, record: undefined });
const VEL = { product_name: 'Velista', catalog_epa: '100-1534', catalog_group: '7' };
const ART = { product_name: 'Artavia 2 SC (Azoxy)', catalog_epa: '91234-74', catalog_group: '11', catalog_moa_group: 'Group 11' };
const HEAD = { product_name: 'Headway Fungicide', catalog_epa: '100-1216', catalog_group: '3 + 11', catalog_moa_group: 'Group 11 + 3' };
const velista = (day, over) => row(day, VEL, over);
const artavia = (day, over) => row(day, ART, over);
const headway = (day, over) => row(day, HEAD, over);
const run = (rows, propertyId = HOME) => successiveRun(VELISTA, rows, { propertyId });

describe('successiveRun: the product\'s unbroken run that ends at the lawn\'s latest fungicide application', () => {
  test('the list holds Velista at two in a row, by its registration number', () => {
    expect(VELISTA).toMatchObject({ max: 2, group: '7', category: 'fungicide' });
    expect(VELISTA.source).toMatch(/100-1534/);
  });

  test('the fall calendar of a lawn mapped for take-all and large patch: October and November make two', () => {
    // September Artavia (take-all), October Headway (take-all) with Velista (large patch), November Velista.
    expect(run([velista('2026-11-03'), velista('2026-10-06'), headway('2026-10-06'), artavia('2026-09-08')])).toEqual(['2026-11-03', '2026-10-06']);
  });

  test('an application that carries Velista counts, alone or in a tank mix', () => {
    expect(run([velista('2026-11-03'), velista('2026-10-06'), artavia('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
  });

  test('an application of another group with no Velista ends the run', () => {
    expect(run([artavia('2026-12-01'), velista('2026-11-03'), velista('2026-10-06')])).toEqual([]);
    expect(run([velista('2026-12-01'), artavia('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-12-01']);
    // A mixed product (Headway: groups 3 and 11) is another group too.
    expect(run([velista('2026-12-01'), headway('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-12-01']);
  });

  test('only a rotation placed at this property ends the run; Velista counts wherever it is placed', () => {
    // An Artavia record that names no property may have been made at another home.
    expect(run([artavia('2026-11-20', { treated_property_id: null }), velista('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    expect(run([artavia('2026-11-20', { treated_property_id: 'other-home' }), velista('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    expect(run([velista('2026-11-03', { treated_property_id: null }), velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    // A visit that names no property: history that names none is its own.
    expect(run([artavia('2026-11-20', { treated_property_id: null }), velista('2026-11-03', { treated_property_id: null })], null)).toEqual([]);
  });

  test('one service record is one application: two visits on one date are two, a tank mix is one', () => {
    const morning = velista('2026-11-03', { record: 'r-am', recorded_at: '2026-11-03T14:00:00Z' });
    const afternoon = velista('2026-11-03', { record: 'r-pm', recorded_at: '2026-11-03T19:00:00Z' });
    expect(run([afternoon, morning])).toEqual(['2026-11-03', '2026-11-03']);
    // A later record of another group on the same date ends the run; an earlier one does not.
    expect(run([artavia('2026-11-03', { record: 'r-pm', recorded_at: '2026-11-03T19:00:00Z' }), morning, velista('2026-10-06')])).toEqual([]);
    expect(run([afternoon, artavia('2026-11-03', { record: 'r-am', recorded_at: '2026-11-03T14:00:00Z' }), velista('2026-10-06')])).toEqual(['2026-11-03']);
  });

  test('an application whose fungicides are all Group 7, or of no group on file, neither counts nor ends the run', () => {
    const otherSeven = row('2026-10-20', { product_name: 'Another SDHI', catalog_epa: '1-2', catalog_group: '7' });
    const unknown = row('2026-10-21', { product_name: 'Hand entry', catalog_epa: null, catalog_group: null, moa_group: null });
    expect(run([velista('2026-11-03'), unknown, otherSeven, velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
  });

  test('no time ends a run: two Velista applications a year back still count', () => {
    expect(run([velista('2025-11-03'), velista('2025-10-06')])).toEqual(['2025-11-03', '2025-10-06']);
  });

  test('a history row with no catalog row is Velista by its name', () => {
    const byName = velista('2026-11-03', { catalog_epa: null, catalog_group: null });
    expect(run([byName, velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    // Another product is not Velista by a like name, and a catalog row with another registration is not Velista.
    expect(run([{ ...byName, product_name: 'Not Velista' }, velista('2026-10-06')])).toEqual(['2026-10-06']);
    expect(run([{ ...byName, catalog_epa: '999-1', catalog_group: '11' }, velista('2026-10-06')])).toEqual([]);
  });

  test('a Date from the driver reads as its day, and no history is no run', () => {
    expect(run([velista(new Date('2026-11-03T00:00:00Z'), { record: 'a' }), velista(new Date('2026-10-06T00:00:00Z'), { record: 'b' })])).toEqual(['2026-11-03', '2026-10-06']);
    expect(run([])).toEqual([]);
    expect(run(null)).toEqual([]);
  });

  test('latestApplicationCarries: the group of the lawn\'s latest application', () => {
    expect(latestApplicationCarries([velista('2026-11-03'), headway('2026-10-06'), velista('2026-10-06')], '11')).toBe(false);
    expect(latestApplicationCarries([headway('2026-10-06'), velista('2026-10-06')], '11')).toBe(true);
    expect(latestApplicationCarries([], '11')).toBeNull();
  });
});

// The engine's reads: the catalog rows, the turf profile, the repeat-group lookup (answered empty here) and the
// category history read, which is the one that reads up to and including the visit's date ("<=").
function fakeKnex({ catalog = [], history = [], fail = false, seen = {} }) {
  const knex = (table) => {
    const state = { through: null, property: undefined, excluded: undefined };
    const settle = async () => {
      if (table === 'products_catalog') return catalog;
      if (table === 'customer_turf_profiles') return null;
      if (table !== 'service_products as sp' || !state.through) return [];
      if (fail) throw new Error('history read failed');
      Object.assign(seen, state);
      return history.filter((entry) => entry.service_date <= state.through
        && entry.scheduled_service_id !== state.excluded
        && (entry.treated_property_id == null || entry.treated_property_id === state.property));
    };
    const query = {
      join: () => query, leftJoin: () => query, orderBy: () => query, select: () => query, limit: () => query, first: () => query,
      whereIn: () => query, whereNull: () => query,
      modify: (fn) => { fn(query); return query; },
      whereRaw: (sql, bindings) => {
        if (/scheduled_service_id/.test(sql)) state.excluded = bindings?.[0];
        else state.property = bindings?.[0];
        return query;
      },
      where: (...args) => {
        if (typeof args[0] === 'function') {
          const group = { where: () => group, orWhere: () => group, orWhereRaw: () => group };
          args[0].call(group);
        } else if (args[0] === 'sr.service_date' && args[1] === '<=') state.through = args[2];
        return query;
      },
      then: (resolve, reject) => settle().then(resolve, reject),
      catch: (reject) => settle().catch(reject),
    };
    return query;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const CATALOG = [
  { id: 'vel', name: 'Velista', category: 'fungicide', epa_reg_number: '100-1534', frac_group: '7' },
  { id: 'art', name: 'Artavia 2 SC (Azoxy)', category: 'fungicide', epa_reg_number: '91234-74', frac_group: '11' },
];
const plan = { protocol: { base: [], conditional: [] }, mixCalculator: { items: [{ productId: 'vel' }, { productId: 'art' }] }, propertyGate: { latestAssessment: { stressFlags: {} } } };
const evaluate = (history, { product = 'vel', serviceDate = '2026-12-01', propertyId = HOME, serviceId = 'visit-dec', ...rest } = {}) => evaluateWaveGuardManagerApprovals(
  fakeKnex({ catalog: CATALOG, history, ...rest }),
  { customerId: 'customer-1', service: { id: serviceId, service_type: 'Lawn Care', property_id: propertyId }, plan, serviceDate, products: [{ productId: product }], strict: rest.strict },
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
    expect(limitBlocks(await evaluate(fall.filter((entry) => entry.service_date < '2026-11-03'), { serviceDate: '2026-11-03' }))).toEqual([]);
    expect(limitBlocks(await evaluate([artavia('2026-11-20'), ...fall]))).toEqual([]);
    expect(limitBlocks(await evaluate([]))).toEqual([]);
  });

  test('the visit judged is not its own history; an earlier visit on the same date is', async () => {
    const seen = {};
    // The November visit read again after its record exists: its own record is left out, so October alone is one.
    const withOwn = fall.map((entry) => (entry.service_date === '2026-11-03' ? { ...entry, scheduled_service_id: 'visit-nov' } : entry));
    expect(limitBlocks(await evaluate(withOwn, { serviceDate: '2026-11-03', serviceId: 'visit-nov', seen }))).toEqual([]);
    expect(seen).toMatchObject({ through: '2026-11-03', excluded: 'visit-nov', property: HOME });
    // A second visit that day, after the first one's Velista: the first counts.
    expect(limitBlocks(await evaluate(withOwn, { serviceDate: '2026-11-03', serviceId: 'visit-nov-2' }))).toHaveLength(1);
  });

  test('another product is never judged, and reads no history', async () => {
    const seen = {};
    expect(limitBlocks(await evaluate(fall, { product: 'art', seen }))).toEqual([]);
    expect(seen).toEqual({});
  });

  test('the history is this lawn\'s: another property\'s applications are not read; unplaced ones are', async () => {
    expect(limitBlocks(await evaluate(fall.map((entry) => ({ ...entry, treated_property_id: 'other-home' }))))).toEqual([]);
    expect(limitBlocks(await evaluate(fall.map((entry) => ({ ...entry, treated_property_id: null }))))).toHaveLength(1);
    // A year with no fungicide between does not end the run.
    expect(limitBlocks(await evaluate([velista('2025-11-03'), velista('2025-10-06')]))).toHaveLength(1);
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

describe('Fast Complete and the treatment guide pass the Velista row over at its limit, and give Artavia', () => {
  const featureGates = require('../config/feature-gates');
  const guide = require('../services/lawn-treatment-guide');
  const fastComplete = require('../services/lawn-fast-complete');
  const N = { ART: 'Artavia 2 SC (Azoxy)', VEL: 'Velista' };
  const cand = (id, name) => ({ raw: { product: { id, name } }, item: { productId: id, name } });
  // December's rows in program order: Velista (take-all mapped), then Artavia.
  const rows = new Map([
    ['vel', { productName: N.VEL, role: 'fungicide_spot', gates: { trigger: 'active_large_patch_take_all_mapped' } }],
    ['art', { productName: N.ART, role: 'fungicide_spot', gates: { trigger: 'active_large_patch' } }],
  ]);
  const candidates = [cand('vel', N.VEL), cand('art', N.ART)];
  const fall = [velista('2026-11-03'), velista('2026-10-06'), headway('2026-10-06'), artavia('2026-09-08')];
  const svc = { id: 'visit-dec', customer_id: 'customer-1', property_id: HOME, scheduled_date: '2026-12-01' };
  // The places gate off: take-all status is unknown, which counts as mapped (the Group 11 pass-over is on, October to December).
  beforeEach(() => { jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(false); });
  afterEach(() => jest.restoreAllMocks());

  test('the guide: a take-all lawn gets Velista; at the Velista limit with the Group 11 run ended it gets Artavia', () => {
    expect(guide.pickAddOns(candidates, rows, { takeAllMapped: true }).fungus.item.productId).toBe('vel');
    expect(guide.pickAddOns(candidates, rows, { takeAllMapped: false, successiveHeld: [VELISTA] }).fungus.item.productId).toBe('art');
    expect(guide.successiveHeldAddOns(candidates, rows, { successiveHeld: [VELISTA] }).map((c) => c.item.productId)).toEqual(['vel']);
    expect(guide.successiveHeldAddOns(candidates, rows)).toEqual([]);
    // Both runs full (the latest application carried Group 11 too): no fungicide is offered.
    expect(guide.pickAddOns(candidates, rows, { takeAllMapped: true, successiveHeld: [VELISTA] }).fungus).toBeNull();
  });

  test('fungicideHolds: October and November Velista hold the Velista row and release December\'s Artavia row', async () => {
    const holds = await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ history: fall }) });
    expect(holds).toEqual({ takeAllMapped: false, successiveHeld: [VELISTA] });
    // Velista once this fall: the row is open and the Group 11 pass-over stands, as before.
    expect(await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ history: fall.filter((entry) => entry.service_date !== '2026-11-03') }) }))
      .toEqual({ takeAllMapped: true, successiveHeld: [] });
    // The limit reached while the latest application carried Group 11 (Headway beside the Velista): both stay passed over.
    const stacked = [velista('2026-11-03'), headway('2026-11-03'), velista('2026-10-06')];
    expect(await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ history: stacked }) })).toEqual({ takeAllMapped: true, successiveHeld: [VELISTA] });
    // Outside the Group 11 window nothing was passed over; the Velista limit still holds its row.
    expect(await fastComplete.fungicideHolds({ svc: { ...svc, scheduled_date: '2027-01-12' }, knex: fakeKnex({ history: fall }) }))
      .toEqual({ takeAllMapped: false, successiveHeld: [VELISTA] });
  });

  test('a failed history read holds nothing for a run nobody read and keeps the Group 11 pass-over', async () => {
    expect(await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ history: fall, fail: true }) })).toEqual({ takeAllMapped: true, successiveHeld: [] });
  });

  test('the sheet context: Artavia is the guided pick, and the Velista row is held from the list and the search', async () => {
    jest.spyOn(featureGates, 'lawnTreatmentGuideLive').mockReturnValue(true);
    jest.spyOn(featureGates, 'lawnV13Live').mockReturnValue(true);
    jest.spyOn(require('../services/waveguard-plan-engine'), 'v13ProtocolRows').mockReturnValue(rows);
    const loaded = { eligible: true, plan: { protocol: { structured: {} } }, addOns: [{ product: { id: 'vel', name: N.VEL } }, { product: { id: 'art', name: N.ART } }] };
    const sheet = { addOns: [{ productId: 'vel', name: N.VEL }, { productId: 'art', name: N.ART }] };
    const holds = await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ history: fall }) });
    expect(fastComplete.guidedProductIds(loaded, sheet, holds)).toEqual({ guidedProductIds: ['art'], takeAllProductIds: ['vel'] });
    expect(await fastComplete.group11HeldContext({ loaded, sheet, svc, knex: fakeKnex({ history: fall }), holds })).toEqual({ group11HeldProductIds: ['vel'] });
    // The older boolean call still reads as the Group 11 pass-over alone.
    expect(fastComplete.guidedProductIds(loaded, sheet, true)).toEqual({ guidedProductIds: ['vel'], takeAllProductIds: ['art'] });
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
