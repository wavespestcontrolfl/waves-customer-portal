/**
 * GATE_ROUTE_WARNING_DETAIL, the pin half. The night run's address-pin notices cover only a recurring child
 * visit auto-dispatch loads. A one-time / rodent / project visit with no map pin (the Oct 30 case) got no
 * notice, so its route read "could not verify" with nobody told. With the gate on the SAME notice lane also
 * covers every pending or confirmed visit in the next 7 days with no usable pin (same key, dedupe, ring
 * budget and close rules; no new card). Gate off: the lane is exactly as it was. Synthetic ids only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

let mockRows = [];
const mockCalls = [];
const mockBuilder = () => {
  const b = {};
  for (const method of ['leftJoin', 'whereIn', 'whereBetween', 'whereNull', 'where', 'select']) {
    b[method] = jest.fn((...args) => { mockCalls.push([method, ...args]); return b; });
  }
  b.then = (resolve, reject) => Promise.resolve(mockRows).then(resolve, reject);
  return b;
};
const mockDb = jest.fn(() => mockBuilder());
mockDb.fn = { now: () => 'NOW()' };
jest.mock('../models/db', () => mockDb);

const audit = require('../services/auto-dispatch/audit');

const NOW = new Date('2026-10-29T15:00:00Z'); // 11:00 AM Eastern, Thu Oct 29
const base = (id, extra = {}) => ({
  id, customer_id: `cust-${id}`, scheduled_date: '2026-10-30', status: 'confirmed', is_recurring: false, recurring_parent_id: null,
  lat: null, lng: null, customer_latitude: null, customer_longitude: null, customer_address_line1: '1 Test Way',
  customer_city: 'Testville', customer_zip: '34202', service_address_line1: null, service_address_zip: null, service_address_city: null,
  ...extra,
});

beforeEach(() => { mockRows = []; mockCalls.length = 0; delete process.env.GATE_ROUTE_WARNING_DETAIL; });
afterEach(() => { delete process.env.GATE_ROUTE_WARNING_DETAIL; });

describe('which visits the pin notice reads (coverage decision)', () => {
  test('a one-time visit with no pin is covered: same notice key as the recurring lane, routeOnly wording', async () => {
    mockRows = [base('rodent-1')];
    const rows = await audit.nearTermPinlessVisits(NOW, new Set());
    expect(rows).toEqual([{ id: 'rodent-1', customer_id: 'cust-rodent-1', recurring_parent_id: null, scheduled_date: '2026-10-30', date: '2026-10-30', routeOnly: true }]);
    expect(audit.missingGeoKey(rows[0])).toBe('auto-dispatch-missing-geo:rodent-1:2026-10-30');
  });

  test('reads pending and confirmed visits from today through 7 days ahead (Eastern), live customers only', async () => {
    await audit.nearTermPinlessVisits(NOW, new Set());
    expect(audit.NEAR_TERM_PIN_DAYS).toBe(7);
    expect(mockCalls).toContainEqual(['whereIn', 'scheduled_services.status', ['pending', 'confirmed']]);
    expect(mockCalls).toContainEqual(['whereBetween', 'scheduled_services.scheduled_date', ['2026-10-29', '2026-11-05']]);
    expect(mockCalls).toContainEqual(['whereNull', 'customers.deleted_at']);
  });

  test('a visit with a pin is not covered: its own stamp, or the customer pin when the address matches', async () => {
    mockRows = [base('a', { lat: 27.3, lng: -82.5 }), base('b', { customer_latitude: 27.3, customer_longitude: -82.5 }), base('c')];
    const rows = await audit.nearTermPinlessVisits(NOW, new Set());
    expect(rows.map((row) => row.id)).toEqual(['c']);
  });

  test('a visit the run already collected or found pinned is not read twice', async () => {
    mockRows = [base('r1'), base('r2'), base('r3')];
    const rows = await audit.nearTermPinlessVisits(NOW, new Set(['r1', 'r3']));
    expect(rows.map((row) => row.id)).toEqual(['r2']);
  });

  test('a recurring child inside the lock window (never loaded by the run) is covered too', async () => {
    mockRows = [base('rc', { is_recurring: true, recurring_parent_id: 'parent-1' })];
    expect((await audit.nearTermPinlessVisits(NOW, new Set())).map((row) => row.id)).toEqual(['rc']);
  });
});

describe('a held-out visit keeps its pin notice only when the run never moves it', () => {
  const locked = (extra) => base('x', { auto_dispatch_locked: true, ...extra });

  test('gate off: every locked, excluded or confirmed visit is held out, as before', () => {
    expect(audit.pinNoticeHeldOut(locked({}))).toMatchObject({ reason_code: 'MANUALLY_LOCKED' });
    expect(audit.pinNoticeHeldOut(base('y', { customer_confirmed: true }))).toMatchObject({ reason_code: 'CUSTOMER_CONFIRMED' });
  });

  test('gate on: a visit that is not a recurring child is never held out (its pin serves the route check)', () => {
    process.env.GATE_ROUTE_WARNING_DETAIL = 'true';
    expect(audit.pinNoticeHeldOut(locked({}))).toBeNull();
    expect(audit.pinNoticeHeldOut(base('y', { customer_confirmed: true }))).toBeNull();
  });

  test('gate on: a recurring child that is locked or confirmed is still held out (old rule)', () => {
    process.env.GATE_ROUTE_WARNING_DETAIL = 'true';
    const child = { is_recurring: true, recurring_parent_id: 'parent-1' };
    expect(audit.pinNoticeHeldOut(locked(child))).toMatchObject({ reason_code: 'MANUALLY_LOCKED' });
    expect(audit.pinNoticeHeldOut(base('y', { ...child, customer_confirmed: true }))).toMatchObject({ reason_code: 'CUSTOMER_CONFIRMED' });
    expect(audit.pinNoticeHeldOut(base('z', child))).toBeNull();
  });
});
