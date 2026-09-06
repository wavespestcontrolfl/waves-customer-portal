/**
 * /api/public/prep/:token — scheduled-service token resolution
 * (20260714100000: booking-triggered and manual pest prep sends mint their
 * token on the visit row, since they have no project attached).
 */
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const prepPublicRouter = require('../routes/prep-public');

const { resolvePrepSource } = prepPublicRouter._test;

const TOKEN = 'ab'.repeat(16);

function projectsQuery(row) {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => row) };
  return q;
}

// The service read is read-only; the page handler stamps the view via
// source.stampView() after render (fenced on the rendered key). Unknown,
// expired or keyless tokens match nothing.
let lastServicesQuery = null;
function servicesQuery(row) {
  const usable = row && row.prep_template_key && !(row.prep_expires_at && new Date(row.prep_expires_at) < new Date());
  const q = {
    where: jest.fn(() => q),
    whereNotNull: jest.fn(() => q),
    first: jest.fn(async () => (usable ? row : undefined)),
    update: jest.fn(async () => 1),
  };
  lastServicesQuery = q;
  return q;
}

function techniciansQuery(row) {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => (row?.tech_name ? { name: row.tech_name } : null)) };
  return q;
}

function customersQuery(row) {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => row) };
  return q;
}

const CUSTOMER = {
  id: 'cust-1', first_name: 'Megan', last_name: 'Example',
  address_line1: '5022 Sunnyside Ln', city: 'Bradenton', state: 'FL', zip: '34211',
};

function installDb({ project = null, service = null, customer = CUSTOMER } = {}) {
  mockDb.raw = jest.fn((sql) => sql);
  mockDb.mockImplementation((table) => {
    if (table === 'projects') return projectsQuery(project);
    if (table === 'scheduled_services') return servicesQuery(service);
    if (table === 'technicians') return techniciansQuery(service);
    if (table === 'customers') return customersQuery(customer);
    return customersQuery(null);
  });
}

function serviceRow(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    service_type: 'Flea Control Service',
    scheduled_date: '2026-08-01',
    prep_template_key: 'prep.flea',
    prep_expires_at: null,
    technician_id: 'tech-1',
    service_address_line1: null,
    service_address_city: null,
    service_address_state: null,
    service_address_zip: null,
    tech_name: 'Adam Benetti',
    ...overrides,
  };
}

describe('resolvePrepSource — scheduled-service tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockReset();
  });

  test('resolves a service-owned token when no project owns it', async () => {
    installDb({ service: serviceRow() });

    const source = await resolvePrepSource(TOKEN);

    expect(source).not.toBeNull();
    expect(source.templateKey).toBe('prep.flea');
    expect(source.typeLabel).toBe('Flea Control Service');
    expect(source.familyType).toBe('flea');
    expect(source.techName).toBe('Adam Benetti');
    expect(source.viewRow).toEqual({ scheduled_service_id: 'svc-1' });
  });

  test('the read writes nothing; stampView() stamps the view fenced on the rendered key', async () => {
    installDb({ service: serviceRow() });
    const source = await resolvePrepSource(TOKEN);
    expect(source).not.toBeNull();
    expect(lastServicesQuery.update).not.toHaveBeenCalled();
    expect(await source.stampView()).toBe(1);
    expect(lastServicesQuery.where).toHaveBeenCalledWith({ id: 'svc-1', prep_template_key: 'prep.flea' });
    expect(lastServicesQuery.update).toHaveBeenCalledWith(expect.objectContaining({ prep_view_count: expect.anything(), prep_first_viewed_at: expect.anything() }));
    expect(source.countView).toBeUndefined();
  });

  test('projects win the token lookup over scheduled_services', async () => {
    installDb({
      project: {
        id: 'proj-1', customer_id: 'cust-1', project_type: 'flea',
        prep_template_key: 'prep.flea', prep_expires_at: null,
        project_date: '2026-08-02', created_at: '2026-07-01',
      },
      service: serviceRow(),
    });

    const source = await resolvePrepSource(TOKEN);

    expect(source).not.toBeNull();
    expect(source.viewRow).toEqual({ project_id: 'proj-1' });
  });

  test('stamped service address wins over the customer address', async () => {
    installDb({
      service: serviceRow({
        service_address_line1: '99 Rental Unit Rd',
        service_address_city: 'Sarasota',
        service_address_state: 'FL',
        service_address_zip: '34236',
      }),
    });

    const source = await resolvePrepSource(TOKEN);

    expect(source.serviceAddress).toBe('99 Rental Unit Rd Sarasota, FL 34236');
  });

  test('expired service token resolves to null (uniform 404)', async () => {
    installDb({ service: serviceRow({ prep_expires_at: '2020-01-01T00:00:00.000Z' }) });

    expect(await resolvePrepSource(TOKEN)).toBeNull();
  });

  test('service row without a template key resolves to null', async () => {
    installDb({ service: serviceRow({ prep_template_key: null }) });

    expect(await resolvePrepSource(TOKEN)).toBeNull();
  });

  test('unknown token resolves to null', async () => {
    installDb({});

    expect(await resolvePrepSource(TOKEN)).toBeNull();
  });
});
