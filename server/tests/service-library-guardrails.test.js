jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({
  auditServiceCatalogChange: jest.fn(async () => ({})),
  auditServicePackageChange: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const { auditServiceCatalogChange } = require('../services/audit-log');
const serviceLibrary = require('../services/service-library');
const { validatePackagePayload, assertPackagePriceRange } = serviceLibrary.__private;

function serviceRow(overrides = {}) {
  return {
    id: 'service-1',
    service_key: 'general_pest',
    name: 'General Pest Control',
    category: 'pest_control',
    billing_type: 'recurring',
    pricing_type: 'fixed',
    is_active: true,
    is_archived: false,
    ...overrides,
  };
}

function countQuery(count) {
  const query = {
    join: jest.fn(() => query),
    where: jest.fn(() => query),
    whereNull: jest.fn(() => query),
    orWhere: jest.fn(() => query),
    orWhereNot: jest.fn(() => query),
    whereNotIn: jest.fn(() => query),
    whereRaw: jest.fn(() => query),
    count: jest.fn(() => query),
    first: jest.fn(async () => ({ count })),
  };
  return query;
}

function servicesQuery(before, after) {
  const query = {
    where: jest.fn(() => query),
    forUpdate: jest.fn(() => query),
    first: jest.fn(async () => before),
    update: jest.fn(() => ({
      returning: jest.fn(async () => [after]),
    })),
  };
  return query;
}

function mockServiceDb({ before = serviceRow(), after = serviceRow(), counts = {} } = {}) {
  const calls = {};
  db.mockImplementation((table) => {
    if (table === 'services') return servicesQuery(before, after);
    calls[table] = calls[table] || 0;
    const call = calls[table]++;
    const configured = counts[table];
    if (Array.isArray(configured)) return countQuery(configured[call] || 0);
    return countQuery(call === 0 ? (configured || 0) : 0);
  });
}

describe('service library guardrails', () => {
  test.each([[30, true], [30, false], [40, true], [40, false]])('distinguishes echoed policy from duration edits: %i minutes (full form %s)', async (duration, fullForm) => {
    const previousGate = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const policy = { version: 1, min_duration_minutes: 30, default_duration_minutes: 30, max_duration_minutes: 40 };
    const before = serviceRow({ min_duration_minutes: 60, default_duration_minutes: 60,
      max_duration_minutes: 120, scheduling_duration_policy: policy });
    const query = servicesQuery(before, before);
    db.mockImplementation(() => query);
    try {
      await serviceLibrary.updateService(before.id, { name: 'Renamed', default_duration_minutes: duration,
        ...(fullForm ? { min_duration_minutes: 30, max_duration_minutes: 40 } : {}) });
      const patch = query.update.mock.calls[0][0];
      if (duration === 30) {
        for (const key of ['default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes', 'scheduling_duration_policy']) expect(patch).not.toHaveProperty(key);
      } else expect(patch).toMatchObject({ min_duration_minutes: 30, default_duration_minutes: 40,
        max_duration_minutes: 40, scheduling_duration_policy: null });
    } finally {
      if (previousGate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = previousGate;
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    // deactivateService takes the catalog writer table lock as its first
    // statement (codex #4369 r4 P1); the transaction fake must look like one.
    db.isTransaction = true;
    db.raw = db.raw || jest.fn().mockResolvedValue(undefined);
    db.transaction = jest.fn(async (callback) => callback(db));
  });

  test.each([['true', 45, false], ['false', 60, true], ['false', 90, true]])('validates edits against the effective bounds (gate %s, duration %i)', async (gate, duration, valid) => {
    const previousGate = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = gate;
    const before = serviceRow({ min_duration_minutes: 60, default_duration_minutes: 60, max_duration_minutes: 120,
      scheduling_duration_policy: { version: 1, min_duration_minutes: 30, default_duration_minutes: 30, max_duration_minutes: 40 } });
    const query = servicesQuery(before, before);
    db.mockImplementation(() => query);
    try {
      const save = serviceLibrary.updateService(before.id, { default_duration_minutes: duration });
      if (!valid) {
        await expect(save).rejects.toMatchObject({ status: 400 });
        expect(query.update).not.toHaveBeenCalled();
      } else {
        await save;
        const patch = query.update.mock.calls[0][0];
        expect(patch.default_duration_minutes).toBe(duration);
        if (duration === 60) expect(patch).not.toHaveProperty('scheduling_duration_policy');
        else expect(patch.scheduling_duration_policy).toBeNull();
      }
    } finally {
      if (previousGate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = previousGate;
    }
  });

  test('rejects service key changes after creation', async () => {
    mockServiceDb();

    await expect(serviceLibrary.updateService('service-1', { service_key: 'termite_inspection' }))
      .rejects.toMatchObject({
        status: 400,
        message: 'Service key cannot be changed after creation',
      });

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('writes an audit event when a service is updated', async () => {
    const before = serviceRow();
    const after = serviceRow({ name: 'General Pest Plus' });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.updateService('service-1', { name: 'General Pest Plus' }, {
      audit: {
        actorId: 'tech-1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      },
    })).resolves.toEqual(after);

    expect(auditServiceCatalogChange).toHaveBeenCalledWith(expect.objectContaining({
      tech_user_id: 'tech-1',
      service_id: 'service-1',
      change_type: 'update',
      changed_fields: ['name'],
      ip_address: '127.0.0.1',
      user_agent: 'jest',
    }));
  });

  test('audits archived service restoration as a reactivation', async () => {
    const before = serviceRow({ is_active: false, is_archived: true });
    const after = serviceRow({ is_active: true, is_archived: false });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.updateService('service-1', {
      is_active: true,
      is_archived: false,
    })).resolves.toEqual(after);

    expect(auditServiceCatalogChange).toHaveBeenCalledWith(expect.objectContaining({
      service_id: 'service-1',
      change_type: 'reactivate',
      changed_fields: expect.arrayContaining(['is_active', 'is_archived']),
    }));
  });

  test('blocks direct update attempts that archive referenced services', async () => {
    mockServiceDb({ counts: { scheduled_services: 1 } });

    await expect(serviceLibrary.updateService('service-1', { is_archived: true }))
      .rejects.toMatchObject({
        status: 409,
        references: expect.objectContaining({
          scheduled_services: 1,
          blocking_total: 1,
        }),
      });

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('normalizes string booleans before archive guard checks', async () => {
    mockServiceDb({ counts: { scheduled_services: 1 } });

    await expect(serviceLibrary.updateService('service-1', { is_archived: 'true' }))
      .rejects.toMatchObject({
        status: 409,
        references: expect.objectContaining({
          scheduled_services: 1,
          blocking_total: 1,
        }),
      });

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('archives through update with the same audit semantics when no references exist', async () => {
    const before = serviceRow();
    const after = serviceRow({ is_active: false, is_archived: true });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.updateService('service-1', { is_archived: true }))
      .resolves.toEqual(after);

    expect(auditServiceCatalogChange).toHaveBeenCalledWith(expect.objectContaining({
      service_id: 'service-1',
      change_type: 'archive',
      references: expect.objectContaining({ blocking_total: 0 }),
    }));
  });

  test('blocks archiving when active references exist', async () => {
    mockServiceDb({ counts: { scheduled_services: 2 } });

    await expect(serviceLibrary.deactivateService('service-1'))
      .rejects.toMatchObject({
        status: 409,
        message: 'Service is still referenced and cannot be archived',
        references: expect.objectContaining({
          scheduled_services: 2,
          blocking_total: 2,
        }),
      });

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('blocks archiving when live schedules reference the legacy service type text', async () => {
    mockServiceDb({ counts: { scheduled_services: [0, 1] } });

    await expect(serviceLibrary.deactivateService('service-1'))
      .rejects.toMatchObject({
        status: 409,
        references: expect.objectContaining({
          scheduled_services: 0,
          scheduled_services_by_type: 1,
          blocking_total: 1,
        }),
      });

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('fails closed when archive reference checks error', async () => {
    db.mockImplementation((table) => {
      if (table === 'services') return servicesQuery(serviceRow(), serviceRow({ is_active: false, is_archived: true }));
      if (table === 'scheduled_services') throw new Error('schema drift');
      return countQuery(0);
    });

    await expect(serviceLibrary.deactivateService('service-1'))
      .rejects.toThrow('schema drift');

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('rejects creating a fixed-price service without a positive base price', async () => {
    mockServiceDb();

    await expect(serviceLibrary.createService({
      name: 'Fixed No Price',
      pricing_type: 'fixed',
    })).rejects.toMatchObject({
      status: 400,
      message: 'Fixed pricing requires a base price greater than zero',
    });

    await expect(serviceLibrary.createService({
      name: 'Fixed Zero Price',
      pricing_type: 'fixed',
      base_price: 0,
    })).rejects.toMatchObject({ status: 400 });

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('rejects an inverted price range on create', async () => {
    mockServiceDb();

    await expect(serviceLibrary.createService({
      name: 'Inverted Range',
      pricing_type: 'variable',
      price_range_min: 200,
      price_range_max: 100,
    })).rejects.toMatchObject({
      status: 400,
      message: 'price_range_min cannot exceed price_range_max',
    });
  });

  test('rejects switching a priceless service to fixed pricing', async () => {
    mockServiceDb({ before: serviceRow({ pricing_type: 'variable', base_price: null }) });

    await expect(serviceLibrary.updateService('service-1', { pricing_type: 'fixed' }))
      .rejects.toMatchObject({
        status: 400,
        message: 'Fixed pricing requires a base price greater than zero',
      });

    expect(auditServiceCatalogChange).not.toHaveBeenCalled();
  });

  test('rejects clearing the base price of a fixed-price service', async () => {
    mockServiceDb({ before: serviceRow({ pricing_type: 'fixed', base_price: '150' }) });

    await expect(serviceLibrary.updateService('service-1', { base_price: '' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('rejects a partial update that inverts the stored price range', async () => {
    mockServiceDb({ before: serviceRow({ pricing_type: 'variable', price_range_max: '100' }) });

    await expect(serviceLibrary.updateService('service-1', { price_range_min: 200 }))
      .rejects.toMatchObject({
        status: 400,
        message: 'price_range_min cannot exceed price_range_max',
      });
  });

  test('accepts the seasonal_feb_oct frequency on a catalog edit (mosquito seasonal, 20260805000010)', async () => {
    // The admin ServiceForm submits the complete row, so after the
    // activation migration stamps frequency='seasonal_feb_oct', ANY edit to
    // the seasonal service replays that value — the validator rejecting it
    // would brick every catalog edit on the row (codex #3225 P2).
    const before = serviceRow({ service_key: 'mosquito_seasonal', frequency: 'seasonal_feb_oct' });
    const after = serviceRow({ service_key: 'mosquito_seasonal', frequency: 'seasonal_feb_oct', name: 'Renamed' });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.updateService('service-1', { name: 'Renamed', frequency: 'seasonal_feb_oct' }))
      .resolves.toEqual(after);
  });

  test('rejects an unknown service frequency', async () => {
    mockServiceDb();

    await expect(serviceLibrary.updateService('service-1', { frequency: 'fortnightly' }))
      .rejects.toMatchObject({ status: 400, message: 'Invalid service frequency' });
  });

  test('allows non-pricing edits to a legacy row with inconsistent pricing', async () => {
    const before = serviceRow({ pricing_type: 'fixed', base_price: null });
    const after = serviceRow({ pricing_type: 'fixed', base_price: null, name: 'Renamed' });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.updateService('service-1', { name: 'Renamed' }))
      .resolves.toEqual(after);
  });

  test('allows a full-form save that does not change pricing values on a legacy row', async () => {
    // The admin forms submit every field on save, including unchanged
    // pricing (empty inputs arrive as ''), so the guard must compare
    // values, not payload presence.
    const before = serviceRow({ pricing_type: 'fixed', base_price: null, price_range_min: null });
    const after = serviceRow({ pricing_type: 'fixed', base_price: null, name: 'Renamed' });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.updateService('service-1', {
      name: 'Renamed',
      pricing_type: 'fixed',
      base_price: '',
      price_range_min: '',
      price_range_max: '',
    })).resolves.toEqual(after);
  });

  test('still rejects when a full-form save changes pricing on an inconsistent row', async () => {
    const before = serviceRow({ pricing_type: 'variable', base_price: null });
    mockServiceDb({ before });

    await expect(serviceLibrary.updateService('service-1', {
      name: 'Renamed',
      pricing_type: 'fixed',
      base_price: '',
    })).rejects.toMatchObject({
      status: 400,
      message: 'Fixed pricing requires a base price greater than zero',
    });
  });

  test('archives and audits services with no blocking references', async () => {
    const before = serviceRow();
    const after = serviceRow({ is_active: false, is_archived: true });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.deactivateService('service-1', {
      audit: { actorId: 'tech-1' },
    })).resolves.toEqual(after);

    expect(auditServiceCatalogChange).toHaveBeenCalledWith(expect.objectContaining({
      tech_user_id: 'tech-1',
      service_id: 'service-1',
      change_type: 'archive',
      references: expect.objectContaining({ blocking_total: 0 }),
    }));
  });

  test('validates package replacement items before any write', () => {
    expect(() => validatePackagePayload({
      name: 'Gold',
      items: [{ service_id: 'not-a-uuid' }],
    })).toThrow(/valid service_id/);

    expect(() => validatePackagePayload({ discount_pct: 101 }))
      .toThrow(/cannot exceed 100/);
  });

  test('normalizes valid package metadata and items', () => {
    expect(validatePackagePayload({
      name: ' Gold ',
      discount_pct: '15',
      is_active: 'true',
      ignored: 'nope',
      items: [{
        service_id: '11111111-1111-1111-1111-111111111111',
        included_visits: '4',
        addon_discount_pct: '10',
      }],
    })).toEqual({
      packageData: { name: 'Gold', discount_pct: 15, is_active: true },
      items: [{
        service_id: '11111111-1111-1111-1111-111111111111',
        is_included: true,
        included_visits: 4,
        addon_discount_pct: 10,
        sort_order: 0,
      }],
    });
  });

  test('rejects a partial package price edit that inverts the stored range', () => {
    expect(() => assertPackagePriceRange({
      monthly_price_min: 250,
      monthly_price_max: 200,
    })).toThrow(/monthly_price_min cannot exceed monthly_price_max/);
  });

  test('rejects fractional operational integers and invalid duration bounds', () => {
    expect(() => serviceLibrary.__private.validateServicePayload({
      name: 'Bad Photos',
      required_photo_count: 1.5,
    })).toThrow(/required_photo_count must be a whole number/);
  });

  test('rejects malformed service-library JSON instead of erasing it', async () => {
    mockServiceDb({ before: serviceRow() });
    await expect(serviceLibrary.updateService('service-1', {
      default_products: '[not json',
    })).rejects.toMatchObject({ status: 400, message: 'default_products must be valid JSON' });
  });
});
