/**
 * GATE_IB_TARGET_RULES_V2: the assign_technician preview names each stop's customer by id, so
 * owner-direct can tell the customer the owner named from a same-name customer. Gate off, the
 * preview is byte-identical to today's (no customer_id on a stop).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/stamped-address', () => ({ stampedDivergesSql: () => 'FALSE', stampedLine2Sql: () => 'NULL' }));
jest.mock('../services/technician-eligibility', () => ({
  assertAssignableTechnician: jest.fn(async (id) => ({ id, name: 'Luis' })),
  applyAssignable: q => q,
}));

const db = require('../models/db');
const OwnerDirect = require('../services/intelligence-bar/owner-direct');

const CUSTOMER = '10000000-0000-4000-8000-000000000001';
const TWIN = '10000000-0000-4000-8000-000000000002';
const ROW = { id: 'svc-1', customer_id: CUSTOMER, first_name: 'Pat', last_name: 'Example', service_type: 'Quarterly Pest', scheduled_date: '2026-11-03',
  window_start: '09:00', window_end: '11:00', current_tech_id: 'tech-adam', visit_id: null, scheduled_date_str: '2026-11-03', current_tech_name: 'Adam', status: 'confirmed' };

function chain(overrides = {}) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereILike', 'leftJoin', 'whereNull']) b[m] = jest.fn(() => b);
  return Object.assign(b, { select: jest.fn().mockResolvedValue([]), first: jest.fn().mockResolvedValue(undefined), ...overrides });
}

beforeEach(() => {
  const tech = chain({ first: jest.fn().mockResolvedValue({ id: 'tech-luis', name: 'Luis' }) });
  const services = chain({ select: jest.fn().mockResolvedValue([ROW]) });
  db.mockReset().mockImplementation(table => (table === 'technicians' ? tech : services));
  db.raw = jest.fn(sql => sql);
});
afterEach(() => { delete process.env.GATE_IB_TARGET_RULES_V2; });

const propose = () => require('../services/intelligence-bar/schedule-tools')
  .executeScheduleTool('assign_technician', { service_ids: ['svc-1'], technician_name: 'Luis' }, {});

test('gate off: the stops preview is unchanged (no customer_id)', async () => {
  const preview = await propose();
  expect(preview.proposal).toBe(true);
  expect(preview.stops[0]).not.toHaveProperty('customer_id');
});

test('gate on: the stop carries its customer id; a same-name twin is not the named customer', async () => {
  process.env.GATE_IB_TARGET_RULES_V2 = 'true';
  const preview = await propose();
  expect(preview.stops[0]).toMatchObject({ id: 'svc-1', customer: 'Pat Example', customer_id: CUSTOMER });
  const input = { service_ids: ['svc-1'], technician_name: 'Luis' };
  const grounding = ids => OwnerDirect.targetGrounding({ targets: ids.map(customer_id => ({ customer_id, label: 'Pat Example' })), page: { ids: {} } });
  // Same display name on both accounts: only the customer the task resolved runs direct.
  expect(OwnerDirect.executesWithoutCard('assign_technician', input, preview, null, grounding([CUSTOMER]))).toBe(true);
  expect(OwnerDirect.executesWithoutCard('assign_technician', input, preview, null, grounding([TWIN]))).toBe(false);
});
