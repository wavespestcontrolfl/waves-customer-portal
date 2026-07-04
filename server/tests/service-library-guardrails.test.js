jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({
  auditServiceCatalogChange: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const { auditServiceCatalogChange } = require('../services/audit-log');
const serviceLibrary = require('../services/service-library');

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
  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction = jest.fn(async (callback) => callback(db));
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

  test('allows non-pricing edits to a legacy row with inconsistent pricing', async () => {
    const before = serviceRow({ pricing_type: 'fixed', base_price: null });
    const after = serviceRow({ pricing_type: 'fixed', base_price: null, name: 'Renamed' });
    mockServiceDb({ before, after });

    await expect(serviceLibrary.updateService('service-1', { name: 'Renamed' }))
      .resolves.toEqual(after);
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
});
