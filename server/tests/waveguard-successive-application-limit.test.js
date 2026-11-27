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
  latestApplicationEndsGroup,
  SUCCESSIVE_USE_LIMITS,
  SUCCESSIVE_USE_CODE,
} = require('../services/waveguard-approval-engine');
const lawnProtocol = require('../config/lawn-protocol-v13.json');

const VELISTA = SUCCESSIVE_USE_LIMITS.find((limit) => limit.epa === '100-1534');
const HOME = 'home';
// One history row = one product of one completed service record. `record` defaults to the date: one visit a day.
const row = (day, product, over = {}) => ({ service_record_id: over.record || `r-${day}`, service_date: day, recorded_at: `${day}T15:00:00Z`, treated_property_id: HOME, service_line: 'lawn', service_type: 'Lawn Care', ...product, ...over, record: undefined });
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
    // A visit whose property could not be established: every Velista application in the customer's history counts, and no
    // rotation ends the run (none can be tied to the lawn this visit treats).
    expect(run([velista('2026-11-03'), velista('2026-10-06', { treated_property_id: 'other-home' })], null)).toEqual(['2026-11-03', '2026-10-06']);
    expect(run([artavia('2026-11-20', { treated_property_id: 'other-home' }), velista('2026-11-03'), velista('2026-10-06')], null)).toEqual(['2026-11-03', '2026-10-06']);
    expect(run([artavia('2026-11-20'), velista('2026-11-03'), velista('2026-10-06')], null)).toEqual(['2026-11-03', '2026-10-06']);
  });

  test('a rotation on the shrubs is not the lawn\'s: only a lawn record ends the run', () => {
    const shrubs = { service_line: 'tree_shrub', service_type: 'Tree & Shrub Care' };
    expect(run([artavia('2026-11-20', shrubs), velista('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    // A record with no service line is read by its name.
    expect(run([artavia('2026-11-20', { service_line: null, service_type: 'Tree & Shrub Care' }), velista('2026-11-03'), velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    expect(run([artavia('2026-11-20', { service_line: null, service_type: 'Monthly Lawn Care Service' }), velista('2026-11-03'), velista('2026-10-06')])).toEqual([]);
    // Velista on the shrubs still counts toward the run.
    expect(run([velista('2026-11-03', shrubs), velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
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

  test('the registration recorded with the application names the product, before the catalog row of that name', () => {
    // The catalog row named Velista was since replaced by another registration: the application was still Velista.
    const recorded = velista('2026-11-03', { recorded_epa: '100-1534', catalog_epa: '999-1', catalog_group: '7' });
    expect(run([recorded, velista('2026-10-06')])).toEqual(['2026-11-03', '2026-10-06']);
    // A record of another registration under the name is not Velista.
    expect(run([velista('2026-11-03', { recorded_epa: '999-1', catalog_group: '11' }), velista('2026-10-06')])).toEqual([]);
  });

  test('latestApplicationEndsGroup: only a record at this property, with every group on file and none of them the group', () => {
    const ends = (rows, propertyId = HOME) => latestApplicationEndsGroup(rows, '11', { propertyId });
    expect(ends([velista('2026-11-03'), headway('2026-10-06'), velista('2026-10-06')])).toBe(true);
    // The latest application carried Group 11 beside the Velista.
    expect(ends([headway('2026-10-06'), velista('2026-10-06')])).toBe(false);
    // The latest names no property, or another one: it may not be this lawn's.
    expect(ends([velista('2026-11-03', { treated_property_id: null }), artavia('2026-09-08')])).toBe(false);
    expect(ends([velista('2026-11-03', { treated_property_id: 'other-home' })])).toBe(false);
    // A record that is not a lawn treatment says nothing of the lawn's Group 11 run.
    expect(ends([velista('2026-11-03', { service_line: 'tree_shrub' })])).toBe(false);
    // A product with no group on file may be Group 11.
    expect(ends([velista('2026-11-03'), row('2026-11-03', { product_name: 'Hand entry', catalog_epa: null, catalog_group: null })])).toBe(false);
    // No history, and a visit with no property.
    expect(ends([])).toBe(false);
    expect(ends([velista('2026-11-03', { treated_property_id: null })], null)).toBe(false);
  });
});

// The engine's reads: the catalog rows, the turf profile, the repeat-group lookup (answered empty here) and the
// category history read, which is the one that reads up to and including the visit's date ("<=").
function fakeKnex({ catalog = [], history = [], fail = false, failCatalog = false, seen = {} }) {
  const knex = (table) => {
    const state = { through: null, property: undefined, excluded: undefined, statuses: null };
    const settle = async () => {
      if (table === 'products_catalog') { if (failCatalog) throw new Error('catalog read failed'); return catalog; }
      if (table === 'customer_turf_profiles') return null;
      if (table !== 'service_products as sp' || !state.through) return [];
      if (fail) throw new Error('history read failed');
      Object.assign(seen, state);
      return history.filter((entry) => entry.service_date <= state.through
        && entry.scheduled_service_id !== state.excluded
        && (state.statuses || []).includes(entry.status || 'completed')
        // No property filter: a visit whose property could not be established reads the customer's whole history.
        && (state.property === undefined || entry.treated_property_id == null || entry.treated_property_id === state.property));
    };
    const query = {
      join: () => query, leftJoin: () => query, orderBy: () => query, select: () => query, limit: () => query, first: () => query,
      whereIn: (column, values) => { if (column === 'sr.status') state.statuses = values; return query; }, whereNull: () => query,
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

  test('a visit with no property is judged at the property its address resolves to', async () => {
    const resolver = jest.spyOn(require('../services/property-service-areas'), 'resolveVisitPropertyId').mockResolvedValue(HOME);
    const seen = {};
    expect(limitBlocks(await evaluate(fall, { propertyId: null, seen }))).toHaveLength(1);
    expect(seen.property).toBe(HOME);
    expect(resolver.mock.calls[0][0]).toMatchObject({ id: 'visit-dec', customer_id: 'customer-1' });
    // None resolves: the customer's whole history is judged, so the two applications recorded at the home still count.
    resolver.mockResolvedValue(null);
    const whole = {};
    expect(limitBlocks(await evaluate(fall, { propertyId: null, seen: whole }))).toHaveLength(1);
    expect(whole.property).toBeUndefined();
    // The resolver fails: strict throws, else the visit is judged on the whole history too.
    resolver.mockRejectedValue(new Error('resolver failed'));
    await expect(evaluate(fall, { propertyId: null, strict: true })).rejects.toThrow('resolver failed');
    expect(limitBlocks(await evaluate(fall, { propertyId: null }))).toHaveLength(1);
    resolver.mockRestore();
  });

  test('a visit closed as incomplete keeps its applications: Velista on one counts', async () => {
    const seen = {};
    const history = [velista('2026-11-03', { status: 'incomplete' }), velista('2026-10-06'), artavia('2026-09-08')];
    expect(limitBlocks(await evaluate(history, { seen }))).toHaveLength(1);
    expect(seen.statuses).toEqual(['completed', 'incomplete']);
    // Another status (a draft) is not an application.
    expect(limitBlocks(await evaluate([velista('2026-11-03', { status: 'draft' }), velista('2026-10-06')]))).toEqual([]);
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

describe('at the Velista limit the guide suggests Artavia; Velista stays on the list and in the search (an alert, never a stop)', () => {
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
    expect(guide.successiveHeldAddOns).toBeUndefined();
    // Both runs full (the latest application carried Group 11 too): no fungicide is suggested.
    expect(guide.pickAddOns(candidates, rows, { takeAllMapped: true, successiveHeld: [VELISTA] }).fungus).toBeNull();
  });

  test('fungicideHolds: October and November Velista mark the limit and release December\'s Artavia row', async () => {
    const holds = await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ catalog: CATALOG, history: fall }) });
    expect(holds).toEqual({ takeAllMapped: false, successiveHeld: [VELISTA] });
    // Velista once this fall: no limit, and the Group 11 pass-over stands, as before.
    expect(await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ catalog: CATALOG, history: fall.filter((entry) => entry.service_date !== '2026-11-03') }) }))
      .toEqual({ takeAllMapped: true, successiveHeld: [] });
    // The limit reached while the latest application carried Group 11 (Headway beside the Velista): both stay passed over.
    const stacked = [velista('2026-11-03'), headway('2026-11-03'), velista('2026-10-06')];
    expect(await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ catalog: CATALOG, history: stacked }) })).toEqual({ takeAllMapped: true, successiveHeld: [VELISTA] });
    // Two Velista records that name no property: the limit counts them, and nothing at this property ended the Group 11 run.
    const unplaced = [velista('2026-11-03', { treated_property_id: null }), velista('2026-10-06', { treated_property_id: null }), headway('2026-09-20'), artavia('2026-09-08')];
    expect(await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ catalog: CATALOG, history: unplaced }) })).toEqual({ takeAllMapped: true, successiveHeld: [VELISTA] });
    // October and November keep the Group 11 pass-over whatever the Velista run: the release is December's alone.
    const early = [velista('2026-09-22'), velista('2026-08-11')];
    for (const date of ['2026-10-06', '2026-11-03']) {
      expect(await fastComplete.fungicideHolds({ svc: { ...svc, scheduled_date: date }, knex: fakeKnex({ catalog: CATALOG, history: early }) }))
        .toEqual({ takeAllMapped: true, successiveHeld: [VELISTA] });
    }
    // Outside the Group 11 window nothing was passed over.
    expect(await fastComplete.fungicideHolds({ svc: { ...svc, scheduled_date: '2027-01-12' }, knex: fakeKnex({ catalog: CATALOG, history: fall }) }))
      .toEqual({ takeAllMapped: false, successiveHeld: [VELISTA] });
  });

  test('a visit with no property: the history is read at the property its address resolves to', async () => {
    const resolver = jest.spyOn(require('../services/property-service-areas'), 'resolveVisitPropertyId').mockResolvedValue(HOME);
    const seen = {};
    expect(await fastComplete.fungicideHolds({ svc: { ...svc, property_id: null }, knex: fakeKnex({ catalog: CATALOG, history: fall, seen }) }))
      .toEqual({ takeAllMapped: false, successiveHeld: [VELISTA] });
    expect(seen.property).toBe(HOME);
    expect(resolver).toHaveBeenCalled();
  });

  test('a failed history read: Velista is not suggested (nobody read its run) and the Group 11 pass-over stays', async () => {
    expect(await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ catalog: CATALOG, history: fall, fail: true }) }))
      .toEqual({ takeAllMapped: true, successiveHeld: [VELISTA] });
  });

  test('a visit with no program rows (one-time, per application): nothing is held from the search', async () => {
    jest.spyOn(featureGates, 'lawnV13Live').mockReturnValue(true);
    const knex = fakeKnex({ catalog: CATALOG, history: fall });
    for (const visitType of ['one_time', 'unknown']) {
      const out = await fastComplete.loadPlannedProducts(svc, knex, visitType, new Set(), null);
      expect(out).toMatchObject({ source: null, items: [], addOns: [] });
      expect(out.group11HeldProductIds).toBeUndefined();
    }
  });

  test('the sheet context: Artavia is the guided pick, and the Velista row stays on the list and in the search', async () => {
    jest.spyOn(featureGates, 'lawnTreatmentGuideLive').mockReturnValue(true);
    jest.spyOn(featureGates, 'lawnV13Live').mockReturnValue(true);
    jest.spyOn(require('../services/waveguard-plan-engine'), 'v13ProtocolRows').mockReturnValue(rows);
    const loaded = { eligible: true, plan: { protocol: { structured: {} } }, addOns: [{ product: { id: 'vel', name: N.VEL } }, { product: { id: 'art', name: N.ART } }] };
    const sheet = { addOns: [{ productId: 'vel', name: N.VEL }, { productId: 'art', name: N.ART }] };
    const holds = await fastComplete.fungicideHolds({ svc, knex: fakeKnex({ catalog: CATALOG, history: fall }) });
    expect(fastComplete.guidedProductIds(loaded, sheet, holds)).toEqual({ guidedProductIds: ['art'], takeAllProductIds: [] });
    expect(await fastComplete.group11HeldContext({ loaded, sheet, svc, knex: fakeKnex({ history: fall }), holds })).toEqual({});
    // The Group 11 pass-over alone, as before.
    expect(fastComplete.guidedProductIds(loaded, sheet, { takeAllMapped: true })).toEqual({ guidedProductIds: ['vel'], takeAllProductIds: ['art'] });
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
