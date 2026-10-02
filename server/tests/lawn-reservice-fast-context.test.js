// Lawn re-service Fast Complete context: refusal / eligibility reasons, the
// property's last completed lawn visit (line classification, paging, product
// filtering) and the customer's booking words. Synthetic data; a table-keyed
// fake knex that RECORDS each builder call, so the SQL scoping (completed only,
// same property, never after the visit) is asserted on the calls rather than
// interpreted.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(),
}));

const logger = require('../services/logger');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const {
  buildLawnReserviceFastContext,
  lawnReserviceIneligibleReason,
  lawnMethodChoices,
  LAWN_METHODS,
} = require('../services/lawn-reservice-fast-context');

const LAWN_PROFILE = {
  category: 'lawn_care', serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment',
  projectBacked: false, requiresProject: false, companions: [],
};

const visit = (extra = {}) => ({
  id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', service_type: 'Lawn Care Re-Service',
  service_id: 'cat-1', scheduled_date: '2026-10-01', status: 'confirmed', visit_id: null,
  customer_request: null, customer_request_pests: null,
  cust_address_line1: '100 Example Court', cust_city: 'Bradenton', cust_state: 'FL', cust_zip: '34201',
  ...extra,
});

// Rows the fake serves per table name. A value that is an Error rejects; a
// function receives the offset and returns the page. `calls` lists, per table,
// every builder call made on it.
function fakeKnex(tables, calls = {}) {
  const knex = jest.fn((table) => {
    const data = tables[table];
    const log = (calls[table] = calls[table] || []);
    let offsetValue = 0;
    const chain = {};
    for (const m of ['where', 'whereNot', 'whereIn', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'orderBy', 'limit', 'select', 'count']) {
      chain[m] = (...args) => { log.push([m, ...args]); return chain; };
    }
    chain.offset = (value) => { offsetValue = value; return chain; };
    const settle = () => {
      if (data instanceof Error) return Promise.reject(data);
      if (typeof data === 'function') return Promise.resolve(data(offsetValue));
      return Promise.resolve(Array.isArray(data) ? data : []);
    };
    chain.first = async () => {
      if (data instanceof Error) throw data;
      return Array.isArray(data) ? data[0] : data;
    };
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.raw = (sql) => ({ sql });
  return knex;
}

const cat = (id, name, extra = {}) => ({ id, name, category: null, active_ingredient: null, moa_group: null, ...extra });
const catalog = [
  cat('celsius', 'Celsius WG', { category: 'herbicide' }),
  cat('talak', 'Talak 7.9%', { category: 'insecticide' }),
  cat('headway', 'Headway G', { category: 'fungicide' }),
];

describe('lawnReserviceIneligibleReason', () => {
  const knex = (visitRow) => fakeKnex({ service_visits: visitRow });

  test('an eligible visit has no reason', async () => {
    expect(await lawnReserviceIneligibleReason(visit(), LAWN_PROFILE, knex())).toBeNull();
  });
  test('a profile that is no longer typed lawn is a reason', async () => {
    expect(await lawnReserviceIneligibleReason(visit(), { ...LAWN_PROFILE, findingsType: null }, knex())).toBe('not_typed_lawn');
    expect(await lawnReserviceIneligibleReason(visit(), { ...LAWN_PROFILE, findingsType: 'pest' }, knex())).toBe('not_typed_lawn');
  });
  test('project-backed profiles and companion sections take the full form', async () => {
    expect(await lawnReserviceIneligibleReason(visit(), { ...LAWN_PROFILE, projectBacked: true }, knex())).toBe('project_backed');
    expect(await lawnReserviceIneligibleReason(visit(), { ...LAWN_PROFILE, requiresProject: true }, knex())).toBe('project_backed');
    expect(await lawnReserviceIneligibleReason(visit(), { ...LAWN_PROFILE, companions: [{ type: 'tree_shrub' }] }, knex())).toBe('has_companions');
  });
  test('a live visit group, or an orphaned pointer, is ineligible; a dissolved one is not', async () => {
    expect(await lawnReserviceIneligibleReason(visit({ visit_id: 'v' }), LAWN_PROFILE, knex({ status: 'open' }))).toBe('grouped_visit');
    expect(await lawnReserviceIneligibleReason(visit({ visit_id: 'v' }), LAWN_PROFILE, knex(undefined))).toBe('grouped_visit');
    expect(await lawnReserviceIneligibleReason(visit({ visit_id: 'v' }), LAWN_PROFILE, knex({ status: 'dissolved' }))).toBeNull();
  });
  test.each(['completed', 'cancelled', 'skipped', 'no_show', 'incomplete', 'rescheduled'])('terminal status %s is ineligible', async (status) => {
    expect(await lawnReserviceIneligibleReason(visit({ status }), LAWN_PROFILE, knex())).toBe('terminal_status');
  });
  test.each(['pending', 'confirmed', 'en_route', 'on_site'])('live status %s is eligible', async (status) => {
    expect(await lawnReserviceIneligibleReason(visit({ status }), LAWN_PROFILE, knex())).toBeNull();
  });
});

describe('buildLawnReserviceFastContext', () => {
  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockReset();
    resolveCompletionProfileForScheduledService.mockResolvedValue(LAWN_PROFILE);
    logger.warn.mockClear();
  });

  test('a missing visit is not_found', async () => {
    expect(await buildLawnReserviceFastContext('nope', fakeKnex({ scheduled_services: undefined }))).toEqual({ ok: false, reason: 'not_found' });
  });

  test.each([
    ['pest_re_service', { ...LAWN_PROFILE, serviceKey: 'pest_re_service', category: 'pest_control', findingsType: null }],
    ['a recurring lawn visit', { ...LAWN_PROFILE, serviceKey: 'lawn_care_recurring', findingsType: null }],
  ])('%s is refused, not merely ineligible', async (_label, profile) => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({ scheduled_services: visit(), products_catalog: catalog }));
    expect(ctx).toEqual({ ok: false, reason: 'not_lawn_re_service' });
  });

  test('a failed profile lookup is a retryable ineligibility with the identity', async () => {
    resolveCompletionProfileForScheduledService.mockRejectedValue(new Error('db down'));
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({ scheduled_services: visit() }));
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'profile_unavailable', service: { id: 'visit-1', serviceKey: null } });
  });

  test('an ineligible lawn re-service answers the reason and identity only', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue({ ...LAWN_PROFILE, findingsType: null });
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({ scheduled_services: visit() }));
    expect(ctx).toMatchObject({
      ok: true, eligible: false, reason: 'not_typed_lawn',
      service: { id: 'visit-1', propertyId: 'prop-1', serviceKey: 'lawn_re_service' },
    });
    expect(ctx.products).toBeUndefined();
    expect(ctx.lastVisit).toBeUndefined();
  });

  test('a catalog that fails to load sends the visit to the full form', async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({ scheduled_services: visit(), products_catalog: new Error('db down') }));
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'catalog_unavailable', service: { id: 'visit-1' } });
    expect(ctx.products).toBeUndefined();
  });

  test('no prior lawn visit: eligible, catalog served, lastVisit null', async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog, 'service_records as sr': [],
    }));
    expect(ctx).toMatchObject({ ok: true, eligible: true, reason: null, lastVisit: null, customerRequest: null });
    expect(ctx.service).toMatchObject({ id: 'visit-1', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1', serviceKey: 'lawn_re_service' });
    expect(ctx.products.map((p) => p.id)).toEqual(['celsius', 'talak', 'headway']);
  });

  test('the last lawn visit: newest lawn record wins; non-lawn records are skipped; legacy null lines classify by label', async () => {
    const records = [
      { id: 'rec-pest', service_type: 'Pest Control Service', service_line: 'pest', service_date: '2026-09-28' },
      { id: 'rec-legacy', service_type: 'Lawn Care Treatment', service_line: null, service_date: '2026-09-20' },
      { id: 'rec-older', service_type: 'Lawn Care', service_line: 'lawn', service_date: '2026-08-20' },
    ];
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog, 'service_records as sr': records,
      service_products: [
        { product_id: 'celsius', product_name: 'Celsius WG', total_amount: '1.5', amount_unit: 'oz', application_method: 'spot_treatment' },
        { product_id: 'talak', product_name: 'Talak 7.9%', total_amount: '4', amount_unit: 'fl_oz', application_method: 'broadcast_spray' },
      ],
    }));
    expect(ctx.lastVisit).toEqual({
      serviceRecordId: 'rec-legacy', serviceDate: '2026-09-20', serviceType: 'Lawn Care Treatment',
      products: [
        { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null },
        { productId: 'talak', name: 'Talak 7.9%', totalAmount: 4, amountUnit: 'fl_oz', method: 'broadcast_spray', areaValue: null, areaUnit: null },
      ],
    });
  });

  test('a prior re-service callback is a valid last lawn visit', async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog,
      'service_records as sr': [{ id: 'rec-re', service_type: 'Lawn Care Re-Service', service_line: 'lawn', service_date: '2026-09-25' }],
    }));
    expect(ctx.lastVisit).toMatchObject({ serviceRecordId: 'rec-re', serviceDate: '2026-09-25' });
  });

  test('only non-lawn history: lastVisit null', async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog,
      'service_records as sr': [{ id: 'rec-pest', service_type: 'Pest Control Service', service_line: 'pest', service_date: '2026-09-28' }],
    }));
    expect(ctx).toMatchObject({ eligible: true, lastVisit: null });
  });

  test('products inactive or missing in the catalog, unlinked rows and a repeated product are dropped; rate units are not amounts', async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog,
      'service_records as sr': [{ id: 'rec-1', service_type: 'Lawn Care', service_line: 'lawn', service_date: '2026-09-20' }],
      service_products: [
        { product_id: 'retired', product_name: 'Retired Product', total_amount: '2', amount_unit: 'oz', application_method: null },
        { product_id: null, product_name: 'Hand-typed product', total_amount: '2', amount_unit: 'oz', application_method: null },
        { product_id: 'headway', product_name: 'Headway G', total_amount: '25', amount_unit: 'lb/1000sf', application_method: null },
        { product_id: 'celsius', product_name: 'Celsius WG', total_amount: '3', amount_unit: 'oz', application_method: 'spot_treatment' },
        { product_id: 'celsius', product_name: 'Celsius WG', total_amount: '5', amount_unit: 'oz', application_method: 'spot_treatment' },
      ],
    }));
    expect(ctx.lastVisit.products).toEqual([
      { productId: 'headway', name: 'Headway G', totalAmount: null, amountUnit: null, method: null, areaValue: null, areaUnit: null },
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 3, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null },
    ]);
  });

  test('the record walk pages past a full page of other lines', async () => {
    const other = Array.from({ length: 50 }, (_, i) => ({ id: `rec-p${i}`, service_type: 'Pest Control Service', service_line: 'pest', service_date: '2026-09-01' }));
    const lawn = [{ id: 'rec-deep', service_type: 'Lawn Care', service_line: 'lawn', service_date: '2026-03-01' }];
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog,
      'service_records as sr': (offset) => (offset === 0 ? other : lawn),
    }));
    expect(ctx.lastVisit).toMatchObject({ serviceRecordId: 'rec-deep', serviceDate: '2026-03-01' });
  });

  test('a known property scopes records through their scheduled visit; completed only, never after the visit date, never this visit', async () => {
    const calls = {};
    await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog, 'service_records as sr': [],
    }, calls));
    const sr = calls['service_records as sr'];
    expect(sr).toEqual(expect.arrayContaining([
      ['where', 'sr.customer_id', 'cust-1'],
      ['where', 'sr.status', 'completed'],
      ['where', 'sr.service_date', '<=', '2026-10-01'],
      ['whereRaw', 'sr.scheduled_service_id IS DISTINCT FROM ?', ['visit-1']],
      ['join', 'scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id'],
      ['where', 'ss.property_id', 'prop-1'],
    ]));
  });

  test('a visit with no property id falls back to the customer, with no property join', async () => {
    const calls = {};
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit({ property_id: null }), products_catalog: catalog,
      'service_records as sr': [{ id: 'rec-1', service_type: 'Lawn Care', service_line: 'lawn', service_date: '2026-09-20' }],
    }, calls));
    expect(ctx.lastVisit).toMatchObject({ serviceRecordId: 'rec-1' });
    const sr = calls['service_records as sr'];
    expect(sr).toEqual(expect.arrayContaining([['where', 'sr.customer_id', 'cust-1'], ['where', 'sr.status', 'completed']]));
    expect(sr.some(([method]) => method === 'join')).toBe(false);
  });

  test('a failed history read degrades to no suggestions without throwing or logging the driver message', async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog, 'service_records as sr': new Error('secret SQL text'),
    }));
    expect(ctx).toMatchObject({ ok: true, eligible: true, lastVisit: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toContain('secret SQL text');
  });

  test("the customer's booking words come back with their chip labels", async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit({ customer_request: 'Weeds are coming back by the driveway.', customer_request_pests: ['weeds', 'brown_patches', 'not_a_key'] }),
      products_catalog: catalog,
    }));
    expect(ctx.customerRequest).toEqual({ text: 'Weeds are coming back by the driveway.', pests: ['Weeds', 'Brown or dead patches'] });
  });

  test('chips with no typed words still show', async () => {
    const ctx = await buildLawnReserviceFastContext('visit-1', fakeKnex({
      scheduled_services: visit({ customer_request_pests: ['lawn_insects'] }), products_catalog: catalog,
    }));
    expect(ctx.customerRequest).toEqual({ text: null, pests: ['Bugs in the lawn'] });
  });
});

describe('methods, areas and lawn size', () => {
  const lawnRecord = [{ id: 'rec-1', service_type: 'Lawn Care', service_line: 'lawn', service_date: '2026-09-20' }];
  const build = (tables, visitExtra = {}) => buildLawnReserviceFastContext('visit-1', fakeKnex({
    scheduled_services: visit(visitExtra), products_catalog: catalog, ...tables,
  }));

  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockReset();
    resolveCompletionProfileForScheduledService.mockResolvedValue(LAWN_PROFILE);
  });

  test('the offered methods are exactly what /complete accepts for a lawn row, with its own sqft verdict', () => {
    const {
      normalizeServiceReportApplicationMethod, requiresSqftForReportApplication, requiresLinearFtForReportApplication,
    } = require('../services/complete-scheduled-service');
    const choices = lawnMethodChoices();
    expect(choices.map((c) => c.value)).toEqual(['spot_treatment', 'broadcast_spray', 'granular_broadcast']);
    for (const { value, requiresSqft } of choices) {
      expect(normalizeServiceReportApplicationMethod(value)).toBe(value);
      expect(requiresLinearFtForReportApplication(value)).toBe(false);
      expect(requiresSqft).toBe(requiresSqftForReportApplication(value, 'lawn'));
    }
    expect(Object.fromEntries(choices.map((c) => [c.value, c.requiresSqft]))).toEqual({
      spot_treatment: false, broadcast_spray: true, granular_broadcast: true,
    });
    // A method that needs linear feet is never offered (the sheet collects none).
    expect(LAWN_METHODS.some((m) => requiresLinearFtForReportApplication(m.value))).toBe(false);
    expect(requiresLinearFtForReportApplication('perimeter_spray')).toBe(true);
  });

  test('the context carries the methods, the recorded area per product, and the lawn size', async () => {
    const ctx = await build({
      'service_records as sr': lawnRecord,
      service_products: [
        { product_id: 'talak', product_name: 'Talak 7.9%', total_amount: '4', amount_unit: 'fl_oz', application_method: 'broadcast_spray', area_value: '5200.00', area_unit: 'sqft' },
        { product_id: 'celsius', product_name: 'Celsius WG', total_amount: '1.5', amount_unit: 'oz', application_method: 'spot_treatment', area_value: null, area_unit: null },
      ],
      customer_turf_profiles: { lawn_sqft: 6400 },
    });
    expect(ctx.methods).toEqual([
      { value: 'spot_treatment', label: 'Spot treatment', requiresSqft: false },
      { value: 'broadcast_spray', label: 'Broadcast spray', requiresSqft: true },
      { value: 'granular_broadcast', label: 'Granular broadcast', requiresSqft: true },
    ]);
    expect(ctx.lawnSqft).toBe(6400);
    expect(ctx.lastVisit.products).toEqual([
      expect.objectContaining({ productId: 'talak', method: 'broadcast_spray', areaValue: 5200, areaUnit: 'sqft' }),
      expect.objectContaining({ productId: 'celsius', method: 'spot_treatment', areaValue: null, areaUnit: null }),
    ]);
  });

  test('a recorded method the sheet does not offer (or cannot read) comes back null, never guessed', async () => {
    const ctx = await build({
      'service_records as sr': lawnRecord,
      service_products: [
        { product_id: 'talak', product_name: 'Talak', total_amount: '4', amount_unit: 'fl_oz', application_method: 'perimeter_spray', area_value: '300', area_unit: 'linear_ft' },
        { product_id: 'celsius', product_name: 'Celsius', total_amount: '1', amount_unit: 'oz', application_method: null },
        { product_id: 'headway', product_name: 'Headway', total_amount: '2', amount_unit: 'lb', application_method: 'Granular Broadcast' },
      ],
    });
    expect(ctx.lastVisit.products.map((p) => [p.productId, p.method])).toEqual([['talak', null], ['celsius', null], ['headway', 'granular_broadcast']]);
    // The recorded area travels with its own unit; the sheet only reads sqft.
    expect(ctx.lastVisit.products[0]).toMatchObject({ areaValue: 300, areaUnit: 'linear_ft' });
  });

  test('no turf profile, a zero size, or a failed read: lawnSqft null, the context still serves', async () => {
    expect((await build({ customer_turf_profiles: undefined })).lawnSqft).toBeNull();
    expect((await build({ customer_turf_profiles: { lawn_sqft: 0 } })).lawnSqft).toBeNull();
    const failed = await build({ customer_turf_profiles: new Error('boom') });
    expect(failed).toMatchObject({ eligible: true, lawnSqft: null });
  });

  test('a customer with more than one property: the per-customer lawn size prefills nothing', async () => {
    expect((await build({ customer_turf_profiles: { lawn_sqft: 6400 }, customer_properties: { n: '2' } })).lawnSqft).toBeNull();
    expect((await build({ customer_turf_profiles: { lawn_sqft: 6400 }, customer_properties: { n: '1' } })).lawnSqft).toBe(6400);
  });
});
