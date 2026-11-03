/** persistServicePin's audit label: the county pass names its property pin; the backstop and a staff point keep theirs. */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => {}) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/customer-geocode-review', () => ({ reviewedServiceLocation: jest.fn(async () => null) }));

const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const { recordAuditEvent } = require('../services/audit-log');
const { reviewedServiceLocation } = require('../services/customer-geocode-review');
const { persistServicePin, SNAPSHOT_COLUMNS } = require('../services/geocoder-service-locations');

const SNAPSHOT = Object.fromEntries(SNAPSHOT_COLUMNS.map(column => [column, null]));
Object.assign(SNAPSHOT, { id: 'v1', customer_id: 'c1', property_id: 'p1', technician_id: 't1', scheduled_date: '2026-11-05',
  status: 'pending', service_address_line1: '104 Sample Way' });
const PIN = { lat: 27.58, lng: -82.42 };

let updates;
const conn = {
  transaction: async fn => fn(Object.assign(() => {
    const chain = { where: () => chain, whereNull: () => chain, update: async (patch) => { updates.push(patch); return 1; } };
    return chain;
  }, { fn: { now: () => 'now' } })),
};

beforeEach(() => {
  process.env.GATE_ROUTE_REORDER = 'true';
  process.env.GATE_ROUTE_REORDER_REPAIR = 'true';
  updates = [];
  recordAuditEvent.mockClear();
  lockTechDays.mockClear();
  reviewedServiceLocation.mockReset().mockResolvedValue(null);
});
afterAll(() => { delete process.env.GATE_ROUTE_REORDER; delete process.env.GATE_ROUTE_REORDER_REPAIR; });

const auditSource = () => recordAuditEvent.mock.calls[0][0].metadata.source;

test('a caller-named source labels the audit row, under the technician-day lock', async () => {
  await expect(persistServicePin(conn, SNAPSHOT, PIN, { source: 'property_pin' })).resolves.toBe(true);
  expect(lockTechDays).toHaveBeenCalledWith(expect.anything(), [{ techId: 't1', date: '2026-11-05' }]);
  expect(updates[0]).toMatchObject({ lat: 27.58, lng: -82.42 });
  expect(auditSource()).toBe('property_pin');
});

test('with no source the backstop\'s geocode label is unchanged', async () => {
  await persistServicePin(conn, SNAPSHOT, PIN);
  expect(auditSource()).toBe('verified_service_address_geocode');
});

test('a staff-verified point wins over the caller\'s pin and its label', async () => {
  reviewedServiceLocation.mockResolvedValue({ location: { lat: 27.5, lng: -82.5 }, permanent: false });
  await persistServicePin(conn, SNAPSHOT, PIN, { source: 'property_pin' });
  expect(updates[0]).toMatchObject({ lat: 27.5, lng: -82.5 });
  expect(auditSource()).toBe('staff_verified_pin');
});

test('a pin the review withholds writes nothing', async () => {
  reviewedServiceLocation.mockResolvedValue({ location: null, permanent: true, reason: 'address_review_required' });
  await expect(persistServicePin(conn, SNAPSHOT, PIN, { source: 'property_pin' })).resolves.toBe(false);
  expect(updates).toHaveLength(0);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});
