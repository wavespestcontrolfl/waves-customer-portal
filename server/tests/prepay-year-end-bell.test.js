// The office bell before a prepaid year ends: copy rules, the consequence text and the dark gate.
// The SQL runs against Postgres in prepay-year-end-bell-postgres.test.js.
jest.mock('../models/db', () => jest.fn(() => { throw new Error('the gate is off: no query may run'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-schedule', () => ({
  seriesNextOccurrencesUnbillable: jest.fn(),
  seriesNextOccurrencesPrice: jest.fn(),
}));

const admin = require('../routes/admin-schedule');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { runPrepayYearEndBell, _private } = require('../services/prepay-year-end-bell');

const { alertKey, alertSpec, alertDetail, consequenceFor, settledReason, STOPS, CHECK_PRICE } = _private;

// A connection that answers each query with the next canned result, in order.
function fakeConn(...results) {
  const queue = [...results];
  const conn = jest.fn(() => {
    const builder = {};
    for (const method of ['where', 'whereIn', 'whereNotIn', 'select']) builder[method] = jest.fn(() => builder);
    builder.then = (resolve, reject) => Promise.resolve(queue.shift()).then(resolve, reject);
    return builder;
  });
  conn.raw = jest.fn((sql) => sql);
  return conn;
}

const row = (overrides = {}) => ({
  id: 'term-1', customer_id: 'cust-1', first_name: 'Pat', last_name: 'Owner', company_name: null,
  term_start: '2025-11-24', term_end: '2026-11-24', prepay_amount: '444.60', status: 'active', renewal_decision: null,
  billing_mode: 'annual_prepay', customer_deleted_at: null,
  ...overrides,
});

describe('prepay year end bell copy', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the alert key is one per term per year end', () => {
    expect(alertKey('term-1', '2026-11-24')).toBe('prepay-year-end:term-1:2026-11-24');
  });

  test('the bell is rule-clean and short, even for a very long customer name', () => {
    const long = row({ first_name: 'Alexandria Bartholomew', last_name: 'Featherstonehaugh-Montgomery the Third' });
    for (const consequence of [STOPS, CHECK_PRICE, 'visits bill up to $1,234.56']) {
      const composed = composeAdminAlert(alertSpec(long, consequence));
      expect(composed.headline.length).toBeLessThanOrEqual(60);
      expect(composed.why.length).toBeLessThanOrEqual(110);
      expect(composed.why).toBe(`Prepaid year ends Nov 24; if nobody acts, ${consequence}.`);
      expect(composed.metadata).toMatchObject({ area: 'Billing', severity: 'needs-you', doneWhen: 'prepay_year_settled', who: 'person', subject: { type: 'customer', id: 'cust-1' } });
      expect(composed.link).toBe('/admin/customers?customerId=cust-1');
    }
  });

  test('a short name gets the first headline wording', () => {
    expect(composeAdminAlert(alertSpec(row(), STOPS)).headline).toBe("Billing — send Pat Owner next year's prepay");
  });

  test('a business with no first or last name still gets a name', () => {
    expect(composeAdminAlert(alertSpec(row({ first_name: null, last_name: null, company_name: 'Harbor Dental' }), STOPS)).headline)
      .toBe("Billing — send Harbor Dental next year's prepay");
  });

  test('the word "renewal" appears in no bell text', () => {
    const composed = composeAdminAlert(alertSpec(row(), STOPS));
    const detail = alertDetail(row());
    for (const text of [composed.headline, composed.why, detail, ...[STOPS, CHECK_PRICE]]) {
      expect(text).not.toMatch(/renew/i);
    }
  });

  test('the detail states the price rule and this year, and computes no amount for next year', () => {
    const detail = alertDetail(row());
    expect(detail).toContain("Next year's prepay = visits x visit price - 5% (e.g. $117 x 4 = $468 - 5% = $444.60).");
    expect(detail).toContain('Send it from Customer 360 > Send annual prepay invoice.');
    expect(detail).toContain('If the customer declines, set billing to per application and check the plan\'s visit price.');
    expect(detail).toContain('This year: $444.60, Nov 24, 2025 to Nov 24, 2026.');
    expect(alertDetail(row({ prepay_amount: null }))).toContain('This year: Nov 24, 2025 to Nov 24, 2026.');
  });
});

describe('prepay year end bell consequence', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no ongoing plan on the term: the plan stops booking, and the price helpers are never asked', async () => {
    expect(await consequenceFor(fakeConn([], []), 'term-1')).toBe(STOPS);
    expect(await consequenceFor(fakeConn([{ root_id: 'r1' }], []), 'term-1')).toBe(STOPS);
    expect(admin.seriesNextOccurrencesUnbillable).not.toHaveBeenCalled();
  });

  test('every ongoing plan fails the billing check: the plan stops booking', async () => {
    admin.seriesNextOccurrencesUnbillable.mockResolvedValue({ error: 'will not bill' });
    expect(await consequenceFor(fakeConn([{ root_id: 'r1' }, { root_id: 'r2' }], [{ id: 'r1' }, { id: 'r2' }]), 'term-1')).toBe(STOPS);
    expect(admin.seriesNextOccurrencesPrice).not.toHaveBeenCalled();
  });

  test('a plan that keeps booking bills its next visit price; the highest price among plans wins', async () => {
    admin.seriesNextOccurrencesUnbillable.mockImplementation(async (_conn, id) => (id === 'r3' ? { error: 'will not bill' } : null));
    admin.seriesNextOccurrencesPrice.mockImplementation(async (_conn, id) => ({ unverified: false, price: id === 'r1' ? 117 : 140.5 }));
    const conn = fakeConn([{ root_id: 'r1' }], [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    expect(await consequenceFor(conn, 'term-1')).toBe('visits bill up to $140.50');
    expect(admin.seriesNextOccurrencesPrice).toHaveBeenCalledTimes(2);
  });

  test('a price that cannot be verified, a missing price, or a zero price reads as check the visit price', async () => {
    admin.seriesNextOccurrencesUnbillable.mockResolvedValue(null);
    for (const priced of [{ unverified: true, price: 0 }, null, { unverified: false, price: 0 }]) {
      admin.seriesNextOccurrencesPrice.mockResolvedValueOnce(priced);
      expect(await consequenceFor(fakeConn([{ root_id: 'r1' }], [{ id: 'r1' }]), 'term-1')).toBe(CHECK_PRICE);
    }
  });

  test('a billing check that could not finish is unknown, not "stops booking"', async () => {
    admin.seriesNextOccurrencesUnbillable.mockResolvedValue({ code: 'RECURRING_BILLING_UNVERIFIED', error: 'too long to check' });
    expect(await consequenceFor(fakeConn([{ root_id: 'r1' }], [{ id: 'r1' }]), 'term-1')).toBe(CHECK_PRICE);
  });

  test('a helper that throws is the caller\'s to catch', async () => {
    admin.seriesNextOccurrencesUnbillable.mockRejectedValue(new Error('boom'));
    await expect(consequenceFor(fakeConn([{ root_id: 'r1' }], [{ id: 'r1' }]), 'term-1')).rejects.toThrow('boom');
  });
});

describe('prepay year end bell settled years', () => {
  test.each([
    ['an open year with a pending next-year term', {}, false, null],
    ['a renew decision alone', { status: 'renewed', renewal_decision: 'renew' }, false, null],
    ['a later paid term', {}, true, 'next_year_paid'],
    ['a cancel decision', { renewal_decision: 'cancel' }, false, 'declined'],
    ['a switch plan decision', { renewal_decision: 'switch_plan' }, false, 'declined'],
    ['a cancelled status', { status: 'cancelled' }, false, 'declined'],
    ['a switch plan status', { status: 'switch_plan' }, false, 'declined'],
    ['a customer moved to per application', { billing_mode: 'per_application' }, false, 'billing_mode_changed'],
    ['a deleted customer', { customer_deleted_at: new Date() }, false, 'customer_deleted'],
  ])('%s', (_name, overrides, later, expected) => {
    expect(settledReason(row(overrides), later)).toBe(expected);
  });
});

describe('prepay year end bell next year', () => {
  const { isNextYearOf } = _private;
  const year = row({ term_start: '2025-11-24', term_end: '2026-11-24', coverage_service_type: 'Quarterly Pest Control' });
  test.each([
    ['the Customer 360 default (the day after this year ends)', { term_start: '2026-11-25' }, true],
    ['a start a month before this year ends', { term_start: '2026-10-24' }, true],
    ['a second plan that began mid-year', { term_start: '2026-05-01' }, false],
    ['the same year itself', { id: 'term-1', term_start: '2026-11-25' }, false],
    ['the same service named with other spacing and case', { term_start: '2026-11-25', coverage_service_type: ' quarterly  pest control ' }, true],
    ['another named service', { term_start: '2026-11-25', coverage_service_type: 'Monthly Lawn Care' }, false],
    ['an unnamed coverage', { term_start: '2026-11-25', coverage_service_type: null }, true],
  ])('%s', (_name, laterFields, expected) => {
    expect(isNextYearOf({ id: 'term-2', coverage_service_type: 'Quarterly Pest Control', ...laterFields }, year)).toBe(expected);
  });
});

describe('prepay year end bell gate', () => {
  const db = require('../models/db');
  afterEach(() => { delete process.env.GATE_PREPAY_YEAR_END_BELL; });

  test('gate off: no query runs and nothing is raised or closed', async () => {
    delete process.env.GATE_PREPAY_YEAR_END_BELL;
    await expect(runPrepayYearEndBell({ today: '2026-11-01' })).resolves.toEqual({ raised: 0, closed: 0 });
    await expect(runPrepayYearEndBell({ conn: db, today: '2026-11-01' })).resolves.toEqual({ raised: 0, closed: 0 });
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on with no candidate terms and no open bell: one term query, nothing raised or closed', async () => {
    process.env.GATE_PREPAY_YEAR_END_BELL = 'true';
    const episodes = require('../services/admin-alert-episodes');
    const openKeys = jest.spyOn(episodes, 'openAdminAlertKeys').mockResolvedValue([]);
    const close = jest.spyOn(episodes, 'closeAdminAlertKeys').mockResolvedValue(0);
    const conn = fakeConn([]);
    conn.mockImplementation(() => {
      const builder = {};
      for (const method of ['join', 'whereNull', 'where', 'whereRaw', 'select']) builder[method] = jest.fn(() => builder);
      builder.then = (resolve) => Promise.resolve([]).then(resolve);
      return builder;
    });
    await expect(runPrepayYearEndBell({ conn, today: '2026-11-01' })).resolves.toEqual({ raised: 0, closed: 0 });
    expect(openKeys).toHaveBeenCalledWith(conn, 'prepay-year-end:');
    expect(conn).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    openKeys.mockRestore();
    close.mockRestore();
  });

  test('only our own keys with a real term id are read back from open bells', () => {
    const { termIdOfKey } = _private;
    const id = '0b7c4a8e-1f2d-4c3b-9a5e-6d7f8a9b0c1d';
    expect(termIdOfKey(`prepay-year-end:${id}:2026-11-24`)).toBe(id);
    expect(termIdOfKey(`prepay-year-end:not-a-uuid:2026-11-24`)).toBeNull();
    expect(termIdOfKey(`agreement-renewal:${id}:2026-11-24`)).toBeNull();
    expect(termIdOfKey(null)).toBeNull();
  });
});
