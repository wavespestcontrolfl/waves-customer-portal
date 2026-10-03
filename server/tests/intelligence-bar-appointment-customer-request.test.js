/**
 * IB create_appointment — why the customer booked a re-service.
 *
 * A re-service booked through the Intelligence Bar saved no reason, so the
 * job card's "Why they booked" stayed empty (the operator's words went into
 * the visit note, or nowhere). These pin:
 *   - customer_request on a pest/lawn re-service is stamped on the insert,
 *     trimmed and capped, with source 'office' (relayed words, never a quote)
 *   - the same gate as the Schedule screen's "Customer's words" box
 *     (GATE_RESERVICE_OFFICE_REQUEST) and the same two catalog rows
 *   - a reason on any other visit, or with the gate off, is REFUSED before
 *     any write — never dropped after the card showed it
 *   - no reason = the insert carries neither column (unchanged behaviour)
 *   - ibBookingProposal answers the same verdict, so the card and the commit
 *     agree
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue({ id: 'rem-1' }),
  sendConfirmation: jest.fn().mockResolvedValue(true),
}));
const mockGateState = { reserviceOfficeRequest: true };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: jest.fn((name) => (name === 'reserviceOfficeRequest' ? mockGateState.reserviceOfficeRequest : actual.isEnabled(name))),
  };
});

const db = require('../models/db');
const { executeTool, ibBookingProposal } = require('../services/intelligence-bar/tools');

const PEST_RE_SERVICE = {
  id: 'svc-prs', name: 'Pest Control Re-Service', short_name: null,
  service_key: 'pest_re_service', base_price: null, category: 'pest',
};
const LAWN_RE_SERVICE = {
  id: 'svc-lrs', name: 'Lawn Care Re-Service', short_name: null,
  service_key: 'lawn_re_service', base_price: null, category: 'lawn',
};
const QUARTERLY_PEST = {
  id: 'svc-qp', name: 'Quarterly Pest Control Service', short_name: null,
  service_key: 'pest_quarterly', base_price: null, category: 'pest',
};
const MEMBER = { id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', billing_mode: 'monthly_membership', monthly_rate: 89 };

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    forShare: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'appt-1' }]),
    ...overrides,
  });
  return builder;
}

const catalog = (rows) => chain({ select: jest.fn().mockResolvedValue(rows) });

function wireDb(queues) {
  db.mockImplementation((table) => {
    if (table === 'discounts' && !queues.discounts) {
      return { where() { return this; }, whereIn() { return this; }, orderBy() { return this; }, select: () => Promise.resolve([]) };
    }
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
  });
}

// Preflight + locked reads of the customer and the catalog, then the insert.
function wireBooking(rows) {
  const insertChain = chain();
  wireDb({
    customers: [chain({ first: jest.fn().mockResolvedValue(MEMBER) }), chain({ first: jest.fn().mockResolvedValue(MEMBER) })],
    // retired-for-sale lookup, preflight catalog, locked catalog
    services: [catalog(rows), catalog(rows), catalog(rows)],
    scheduled_services: [chain(), insertChain],
  });
  return insertChain;
}

const book = (serviceRow, extra = {}) => executeTool('create_appointment', {
  customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: serviceRow.name, time_window: '9:00 AM',
  _booking_price: null, _booking_service_id: serviceRow.id, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGateState.reserviceOfficeRequest = true;
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
});
afterEach(async () => { await new Promise((resolve) => setImmediate(resolve)); });

describe('create_appointment — why the customer booked a re-service', () => {
  test.each([
    ['pest', PEST_RE_SERVICE],
    ['lawn', LAWN_RE_SERVICE],
  ])('a %s re-service saves the reason, trimmed, with source office', async (_lane, row) => {
    const insertChain = wireBooking([row, QUARTERLY_PEST]);
    const result = await book(row, { customer_request: '  ants back in the kitchen since the weekend \r\n' });
    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1' });
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({
      service_id: row.id,
      customer_request: 'ants back in the kitchen since the weekend',
      customer_request_source: 'office',
    });
  });

  test('the reason is capped at the column contract (400 characters)', async () => {
    const insertChain = wireBooking([PEST_RE_SERVICE]);
    const result = await book(PEST_RE_SERVICE, { customer_request: 'a'.repeat(900) });
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0].customer_request).toHaveLength(400);
  });

  test('a re-service with no reason writes neither column', async () => {
    const insertChain = wireBooking([PEST_RE_SERVICE]);
    const result = await book(PEST_RE_SERVICE, { customer_request: '   ' });
    expect(result.success).toBe(true);
    const payload = insertChain.insert.mock.calls[0][0];
    expect(payload).not.toHaveProperty('customer_request');
    expect(payload).not.toHaveProperty('customer_request_source');
  });

  test('a reason on a visit that is not a re-service is refused before any write', async () => {
    const insertChain = wireBooking([PEST_RE_SERVICE, QUARTERLY_PEST]);
    const result = await book(QUARTERLY_PEST, { customer_request: 'ants in the kitchen' });
    expect(result.error).toMatch(/saved only on a Pest Control Re-Service or Lawn Care Re-Service/);
    expect(insertChain.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('gate off: a reason is refused, and a booking without one is unchanged', async () => {
    mockGateState.reserviceOfficeRequest = false;
    const refusedInsert = wireBooking([PEST_RE_SERVICE]);
    const refused = await book(PEST_RE_SERVICE, { customer_request: 'ants in the kitchen' });
    expect(refused.error).toMatch(/nothing was booked/);
    expect(refusedInsert.insert).not.toHaveBeenCalled();

    const insertChain = wireBooking([PEST_RE_SERVICE]);
    const result = await book(PEST_RE_SERVICE);
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).not.toHaveProperty('customer_request');
  });
});

describe('ibBookingProposal — the card and the commit agree on the reason', () => {
  const wireProposal = (rows) => wireDb({
    customers: [chain({ first: jest.fn().mockResolvedValue(MEMBER) })],
    services: [catalog(rows)],
  });

  test('a re-service proposal carries the reason as it will be saved', async () => {
    wireProposal([PEST_RE_SERVICE]);
    const result = await ibBookingProposal('cust-1', PEST_RE_SERVICE.name, undefined, '  ants back in the kitchen ');
    expect(result).toMatchObject({ serviceId: 'svc-prs', customerRequest: 'ants back in the kitchen' });
  });

  test('no reason answers null', async () => {
    wireProposal([PEST_RE_SERVICE]);
    const result = await ibBookingProposal('cust-1', PEST_RE_SERVICE.name, undefined, undefined);
    expect(result.customerRequest).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test('a reason on another service gets no card', async () => {
    wireProposal([QUARTERLY_PEST]);
    const result = await ibBookingProposal('cust-1', QUARTERLY_PEST.name, undefined, 'ants in the kitchen');
    expect(result.error).toMatch(/saved only on a Pest Control Re-Service or Lawn Care Re-Service/);
  });
});
