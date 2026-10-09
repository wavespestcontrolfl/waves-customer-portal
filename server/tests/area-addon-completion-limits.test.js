/**
 * Codex round 18 P1 on #6135: the closeout's hard-limit audit never judged an area add-on that rides a Tree & Shrub or pest host
 * (the audit returned early for a non-lawn host and needed GATE_LAWN_V13), and the chemical add-ons have no product_limits rows
 * (owner ruling: add-on-only limits), so Snapshot twice on one T&S visit produced no finding at all. flagAddOnYearlyLimits judges
 * each application recorded for an add-on (a service_products row tagged area_addon_key) against the add-on's own limit on the
 * place-based history the booking uses, with this visit's own ledger rows left out, and raises the existing advisory and office
 * alert. It never blocks and never judges a host program row on its own.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The scope itself is application-limits' own; here it keeps the rows of the property (or unplaced) and leaves out this
// visit's own record, the way scopeHistoryToTreatment leaves out excludeScheduledServiceId.
jest.mock('../services/application-limits', () => ({
  scopeHistoryToTreatment: (query, _db, { propertyId, excludeScheduledServiceId } = {}) => {
    if (propertyId) query.where(function placedHereOrUnplaced() { this.whereNull('property_id').orWhere('property_id', propertyId); });
    if (excludeScheduledServiceId) query.whereNot('service_record_id', 'rec-1');
    return query;
  },
}));
jest.mock('../services/slot-reservation', () => ({ commitGraceMinutes: () => 10 }));

const { fakeDb } = require('./helpers/area-addon-fake-db');
const limits = require('../services/area-addon-limits');
const { addDays } = require('../services/pricing-engine/area-addon-limits');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const PROPERTY = '22222222-2222-4222-8222-222222222222';
const VISIT = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-10-09';
const SNAP_KEY = 'area_addon_bed_pre_emergent';
const svc = { id: VISIT, customer_id: CUSTOMER, property_id: PROPERTY, scheduled_date: TODAY, service_type: 'Tree & Shrub Care' };
const record = { id: 'rec-1', service_date: TODAY };
const CATALOG = [
  { id: 'p-snap', name: 'Snapshot 2.5TG', active: true }, { id: 'p-arena', name: 'Arena 50 WDG', active: true },
  { id: 'p-top', name: 'Topchoice Granular Insecticide', active: true }, { id: 'p-acel', name: 'Acelepryn Insecticide', active: true },
  { id: 'p-round', name: 'Roundup QuikPro SC', active: true },
];
const tagged = (key = SNAP_KEY, product = ['p-snap', 'Snapshot 2.5TG']) => ({ service_record_id: 'rec-1', product_id: product[0], product_name: product[1], area_addon_key: key });
const ledger = (daysAgo, extra = {}) => ({ customer_id: CUSTOMER, product_id: 'p-snap', application_date: addDays(TODAY, -daysAgo), property_id: PROPERTY, retracted_at: null, service_record_id: 'old-record', ...extra });
const world = (over = {}) => ({
  products_catalog: CATALOG,
  product_aliases: [],
  customer_properties: [{ id: PROPERTY, customer_id: CUSTOMER, active: true }],
  property_application_history: [],
  scheduled_services: [],
  scheduled_service_addons: [],
  estimates: [],
  service_products: [tagged()],
  ...over,
});
const run = async (tables, extra = {}) => {
  const notify = jest.fn(async () => {});
  const calls = [];
  const advisory = extra.advisory === undefined ? { advisory: true, blocks: [{ code: 'earlier', message: 'earlier' }] } : extra.advisory;
  const out = await limits.flagAddOnYearlyLimits({ svc, record, database: fakeDb(tables, calls), advisory, notify, ...extra.args });
  return { out, notify, calls, advisory };
};

describe('an add-on application is judged against the add-on\'s own limit, whatever the host', () => {
  test('Snapshot for the bed add-on 20 days after another Snapshot application: one finding, the advisory keeps its earlier blocks, the office is told', async () => {
    const { out, notify } = await run(world({ property_application_history: [ledger(20)] }));
    expect(notify).toHaveBeenCalledTimes(1);
    const { findings } = notify.mock.calls[0][0];
    expect(findings).toEqual([expect.objectContaining({
      code: 'application_limit_exceeded', productId: 'p-snap', productName: 'Snapshot 2.5TG', limitType: limits.YEARLY_LIMIT_TYPE, max: 4,
      message: expect.stringContaining('Recorded. The office will review: Snapshot 2.5TG was applied or booked 1 time at this property'),
    })]);
    expect(findings[0].message).toContain(`The next one is allowed on ${addDays(addDays(TODAY, -20), 60)}.`);
    expect(out.advisory).toBe(true);
    expect(out.blocks.map((b) => b.code)).toEqual(['earlier', 'application_limit_exceeded']);
  });

  test('an application that meets the limit raises nothing and hands the same advisory back', async () => {
    const { out, notify, advisory } = await run(world({ property_application_history: [ledger(70)] }));
    expect(notify).not.toHaveBeenCalled();
    expect(out).toBe(advisory);
  });

  test('an application at the place under ANOTHER customer record counts (the history is the place\'s)', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const { notify } = await run(world({
      customer_properties: [{ id: PROPERTY, customer_id: CUSTOMER, active: true, address_key: 'home-key' }, { id: OTHER, customer_id: '55555555-5555-4555-8555-555555555555', active: true, address_key: 'home-key' }],
      property_application_history: [ledger(10, { customer_id: '55555555-5555-4555-8555-555555555555', property_id: OTHER })],
    }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('a same-visit duplicate: the host\'s Snapshot row plus the add-on\'s row make a second application on the same day, flagged though no other visit is near', async () => {
    const twice = [ledger(0, { service_record_id: 'rec-1' }), ledger(0, { service_record_id: 'rec-1' })];
    const { notify } = await run(world({ property_application_history: twice, service_products: [tagged(), { ...tagged(), area_addon_key: null }] }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].findings[0]).toMatchObject({ limitType: limits.YEARLY_LIMIT_TYPE, productId: 'p-snap' });
  });

  test('one application on the visit and nothing else on record is within every limit (this visit\'s own ledger row is left out)', async () => {
    const { notify } = await run(world({ property_application_history: [ledger(0, { service_record_id: 'rec-1' })] }));
    expect(notify).not.toHaveBeenCalled();
  });

  test('a count limit: Topchoice (once in 12 months) applied 100 days ago', async () => {
    const { notify } = await run(world({
      service_products: [tagged('area_addon_fire_ant_yard', ['p-top', 'Topchoice Granular Insecticide'])],
      property_application_history: [ledger(100, { product_id: 'p-top' })],
    }));
    expect(notify.mock.calls[0][0].findings[0]).toMatchObject({ productId: 'p-top', max: 1 });
  });

  test('the web sweep has no limit and no product: nothing is read for it', async () => {
    const { notify, calls } = await run(world({ service_products: [tagged('area_addon_web_sweep', [null, 'none'])] }));
    expect(notify).not.toHaveBeenCalled();
    expect(calls).not.toContain('property_application_history');
  });
});

describe('what the check never does', () => {
  test('a closeout with no row tagged to an add-on reads nothing and returns the advisory untouched', async () => {
    const { out, notify, calls, advisory } = await run(world(), { args: { addOnRows: false } });
    expect(out).toBe(advisory);
    expect(notify).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test('a host program row with no tag is never judged: the record\'s Snapshot row without an add-on tag raises nothing even beside a recent application', async () => {
    const { notify, calls } = await run(world({ service_products: [{ ...tagged(), area_addon_key: null }], property_application_history: [ledger(5)] }));
    expect(notify).not.toHaveBeenCalled();
    expect(calls).not.toContain('property_application_history');
  });

  test('a history that cannot be read is the existing "could not be checked" finding, not a throw and not a block', async () => {
    const tables = world();
    delete tables.property_application_history;
    const { out, notify } = await run(tables);
    expect(notify.mock.calls[0][0].findings).toEqual([expect.objectContaining({ code: 'application_limit_check_unavailable', message: 'Recorded. The office will review: product limits could not be checked for this visit.' })]);
    expect(out.advisory).toBe(true);
  });

  test('an environment before the tag column existed reads nothing', async () => {
    const { notify } = await run(world({ service_products: [{ service_record_id: 'rec-1', product_id: 'p-snap', product_name: 'Snapshot 2.5TG' }] }));
    expect(notify).not.toHaveBeenCalled();
  });

  test('it does not read GATE_AREA_ADDONS: the data decides (a visit booked gate-on is completed gate-off)', async () => {
    const prev = process.env.GATE_AREA_ADDONS;
    delete process.env.GATE_AREA_ADDONS;
    try {
      const { notify } = await run(world({ property_application_history: [ledger(20)] }));
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      if (prev !== undefined) process.env.GATE_AREA_ADDONS = prev;
    }
  });
});
