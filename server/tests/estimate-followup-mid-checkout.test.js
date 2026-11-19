/**
 * Follow-up emails hold while the customer is signing up.
 *
 * 8 of 176 estimate follow-up emails since Aug 28 went out 1-3 minutes before
 * the customer accepted (the engaged-moment rules fire ~1 minute after a page
 * view). estimateMidCheckout is the shared answer: a live visit-time hold for
 * the estimate, or a card step touched in the last 20 minutes. safetyGate (the
 * legacy stages, the payment-step stage and the deferred-text replay) skips on
 * it; the engagement engine defers on it (its own suite).
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((key) => key !== 'sendRequiresServerPricing'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: (s) => String(s || ''),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => null),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => null),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { _private } = require('../services/estimate-follow-up');

// A knex-builder stub per table: every chain method returns the builder, and
// first() resolves the row the test set for that table (or rejects with an error).
function tableStub(result) {
  const calls = { where: [], whereRaw: [] };
  const b = {};
  b.where = jest.fn((arg) => { calls.where.push(arg); return b; });
  b.whereRaw = jest.fn((sql, bindings) => { calls.whereRaw.push([sql, bindings]); return b; });
  b.first = jest.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
  b.calls = calls;
  return b;
}

function arrange({ hold = undefined, card = undefined } = {}) {
  const stubs = { scheduled_services: tableStub(hold), estimate_checkout_events: tableStub(card) };
  db.mockImplementation((table) => stubs[table] || tableStub(undefined));
  return stubs;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('estimateMidCheckout', () => {
  test('a live visit-time hold for the estimate means the customer is booking', async () => {
    const stubs = arrange({ hold: { id: 'hold-1' } });

    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(true);

    // The hold row is found by the estimate it was made for, still unexpired.
    expect(stubs.scheduled_services.calls.where).toEqual([{ source_estimate_id: 'est-1' }]);
    expect(stubs.scheduled_services.calls.whereRaw[0][0]).toMatch(/reservation_expires_at > NOW\(\)/);
  });

  test('a card step touched in the last 20 minutes means the customer is booking', async () => {
    const stubs = arrange({ hold: undefined, card: { id: 'evt-1' } });

    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(true);

    expect(_private.CHECKOUT_ACTIVE_MINUTES).toBe(20);
    expect(stubs.estimate_checkout_events.calls.where).toEqual([{ estimate_id: 'est-1' }]);
    expect(stubs.estimate_checkout_events.calls.whereRaw[0]).toEqual([
      'updated_at > NOW() - make_interval(mins => ?)',
      [20],
    ]);
  });

  test('no hold and no recent card step: the customer is not booking', async () => {
    arrange();
    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(false);
  });

  test('a lookup error fails open (a held email only delays) and logs the code alone', async () => {
    arrange({ hold: Object.assign(new Error('select * from x where phone = 5551234'), { code: '42P01' }) });

    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(false);

    const logged = logger.warn.mock.calls.map((c) => c[0]).join(' ');
    expect(logged).toContain('42P01');
    expect(logged).not.toContain('5551234');
  });
});

describe('safetyGate', () => {
  const est = { id: 'est-1', status: 'viewed', customer_id: null, customer_phone: null, customer_email: 'pat@example.com' };

  test('skips a send while the customer is mid-checkout, and says why', async () => {
    arrange({ hold: { id: 'hold-1' } });
    const gate = await _private.safetyGate(est, new Date('2026-11-19T15:00:00Z'));
    expect(gate).toEqual({ skip: true, reason: 'customer-mid-checkout' });
  });

  test('lets the send through when the customer is not booking', async () => {
    arrange();
    const gate = await _private.safetyGate(est, new Date('2026-11-19T15:00:00Z'));
    expect(gate).toEqual({ skip: false });
  });
});
