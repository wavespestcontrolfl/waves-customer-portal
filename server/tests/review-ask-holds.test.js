'use strict';

const mockDispatch = jest.fn();
const mockLastReminder = jest.fn(async () => null);
const mockOpenBalance = jest.fn(async () => []);
const mockTables = {};
const mockQueries = [];

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
jest.mock('../services/messaging/review-ask-reservation', () => ({ excludeUnresolvedSendReservations: (q) => q }));
jest.mock('../services/collections/dunning-spacing', () => ({ lastOverdueReminderWithin7d: (...a) => mockLastReminder(...a) }));
jest.mock('../services/open-balance', () => ({ openBalanceInvoices: (...a) => mockOpenBalance(...a) }));

const db = require('../models/db');
const Holds = require('../services/review-ask-holds');

function builder(table) {
  const calls = [];
  mockQueries.push({ table, calls });
  const q = {};
  for (const m of ['where', 'whereNotIn', 'orWhere', 'orderBy', 'limit']) {
    q[m] = (...args) => {
      calls.push([m, ...args]);
      if (typeof args[0] === 'function') args[0](q);
      return q;
    };
  }
  q.select = async () => { if (mockTables[table] instanceof Error) throw mockTables[table]; return mockTables[table] || []; };
  q.first = async () => { if (mockTables[table] instanceof Error) throw mockTables[table]; return (mockTables[table] || [])[0]; };
  return q;
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockLastReminder.mockReset().mockResolvedValue(null);
  mockOpenBalance.mockReset().mockResolvedValue([]);
  Object.keys(mockTables).forEach((k) => delete mockTables[k]);
  mockQueries.length = 0;
  db.mockImplementation(builder);
});

const since = new Date('2026-10-01T12:00:00Z');

describe('customerSaysReviewed', () => {
  test('no texts since the cadence started: no model call', async () => {
    expect(await Holds.customerSaysReviewed('c-1', { since })).toEqual({ claim: null });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a text saying the review is posted stops the asks when the model\'s quote is really in it', async () => {
    mockTables.sms_log = [{ message_body: 'Thanks Adam! Just posted it on Google', created_at: new Date('2026-10-02T15:00:00Z') }];
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { says_reviewed: true, quote: 'Just posted it on Google' } });
    const out = await Holds.customerSaysReviewed('c-1', { since });
    expect(out).toEqual({ claim: { quote: 'Just posted it on Google', at: new Date('2026-10-02T15:00:00Z') } });
    const [policy, req] = mockDispatch.mock.calls[0];
    expect(policy).toBe(require('../config/models').TEXT_POLICIES.fastStructured);
    expect(req.laneId).toBe('review_ask_reviewed_claim');
    expect(req.text).toContain('Just posted it on Google');
    // only the customer's own texts since the cadence started
    const sms = mockQueries.find((x) => x.table === 'sms_log').calls;
    expect(sms).toContainEqual(['where', 'direction', 'inbound']);
    expect(sms).toContainEqual(['where', 'created_at', '>', since]);
  });

  test('a quote that is not in their texts, a "no", or an unavailable model never stops the asks', async () => {
    mockTables.sms_log = [{ message_body: 'The link did not work, is there another?', created_at: new Date() }];
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { says_reviewed: true, quote: 'left you five stars' } });
    expect(await Holds.customerSaysReviewed('c-1', { since })).toEqual({ claim: null, unavailable: true });
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { says_reviewed: false, quote: '' } });
    expect(await Holds.customerSaysReviewed('c-1', { since })).toEqual({ claim: null });
    mockDispatch.mockResolvedValueOnce({ ok: false });
    expect(await Holds.customerSaysReviewed('c-1', { since })).toEqual({ claim: null, unavailable: true });
  });
});

describe('paymentHold', () => {
  const now = new Date('2026-10-02T14:00:00Z');

  test('the customer\'s own open bills come from the pay page\'s authority; overdue is dunning\'s rule (legacy no-due-date bills by their created day)', async () => {
    mockOpenBalance.mockResolvedValueOnce([
      { id: 'inv-due-later', status: 'sent', due_date: '2026-10-10', created_at: new Date('2026-09-30T12:00:00Z') },
      { id: 'inv-legacy', status: 'sent', due_date: null, created_at: new Date('2026-09-20T12:00:00Z') },
    ]);
    expect(await Holds.paymentHold('c-1', { now })).toEqual({ reason: 'overdue_invoice', invoiceId: 'inv-legacy' });
    expect(mockOpenBalance.mock.calls[0][0]).toBe('c-1');
    mockOpenBalance.mockResolvedValueOnce([{ id: 'inv-flag', status: 'overdue', due_date: '2026-10-10', created_at: now }]);
    expect(await Holds.paymentHold('c-1', { now })).toEqual({ reason: 'overdue_invoice', invoiceId: 'inv-flag' });
    // nothing the authority returns is overdue: no hold
    mockOpenBalance.mockResolvedValueOnce([{ id: 'inv-due-later', status: 'sent', due_date: '2026-10-10', created_at: now }]);
    expect(await Holds.paymentHold('c-1', { now })).toBeNull();
  });

  test('a bill dropped because its payer could not be resolved holds (it may be theirs)', async () => {
    mockOpenBalance.mockImplementationOnce(async (_id, { onResolveFailure }) => { onResolveFailure(new Error('payer down')); return []; });
    expect(await Holds.paymentHold('c-1', { now })).toEqual({ reason: 'payment_lookup_unavailable' });
  });

  test('an overdue-payment reminder holds for three days after it went out, then clears', async () => {
    mockLastReminder.mockResolvedValueOnce({ occurred_at: new Date(now.getTime() - 2 * 86400000) });
    expect(await Holds.paymentHold('c-1', { now })).toEqual({
      reason: 'payment_reminder_recent', at: new Date(now.getTime() - 2 * 86400000), until: new Date(now.getTime() + 86400000),
    });
    mockLastReminder.mockResolvedValueOnce({ occurred_at: new Date(now.getTime() - 4 * 86400000) });
    expect(await Holds.paymentHold('c-1', { now })).toBeNull();
    expect(mockLastReminder.mock.calls[0][0]).toBe('c-1');
  });

  test('a failed read holds (no evidence is never a clear)', async () => {
    mockOpenBalance.mockRejectedValueOnce(new Error('db down'));
    expect(await Holds.paymentHold('c-1', { now })).toEqual({ reason: 'payment_lookup_unavailable' });
  });
});
