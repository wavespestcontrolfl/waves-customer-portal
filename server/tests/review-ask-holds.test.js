'use strict';

const mockLastReminder = jest.fn(async () => null);
const mockOpenBalance = jest.fn(async () => []);
const mockTables = {};
const mockQueries = [];

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
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
  mockLastReminder.mockReset().mockResolvedValue(null);
  mockOpenBalance.mockReset().mockResolvedValue([]);
  Object.keys(mockTables).forEach((k) => delete mockTables[k]);
  mockQueries.length = 0;
  db.mockImplementation(builder);
});

const now = new Date('2026-10-02T14:00:00Z');

describe('askHold', () => {
  const seq = (over = {}) => ({ id: 's-1', customer_id: 'c-1', current_step: 1, payment_hold_step: null, payment_hold_since: null, ...over });
  let pay;
  beforeEach(() => {
    pay = jest.spyOn(Holds, 'paymentHold').mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  test('a payment hold waits (shifted onto the step\'s days, never past its window), then drops; a step held past its window drops even once cleared', async () => {
    pay.mockResolvedValueOnce({ reason: 'overdue_invoice', invoiceId: 'inv-1' });
    const waited = await Holds.askHold(seq(), { now, shiftRetry: (d) => new Date(d.getTime() + 3600000) });
    expect(waited).toMatchObject({ kind: 'wait', heldSince: now, detail: { step: 1, hold: 'overdue_invoice', invoiceId: 'inv-1' } });
    expect(waited.retryAt).toEqual(new Date(now.getTime() + 86400000 + 3600000));
    pay.mockResolvedValueOnce({ reason: 'payment_reminder_recent', until: new Date(now.getTime() + 5 * 86400000) });
    const capped = await Holds.askHold(seq({ payment_hold_step: 1, payment_hold_since: new Date(now.getTime() - 86400000) }), { now });
    expect(capped.retryAt).toEqual(new Date(now.getTime() + 2 * 86400000));
    expect(await Holds.askHold(seq({ payment_hold_step: 1, payment_hold_since: new Date(now.getTime() - 4 * 86400000) }), { now }))
      .toMatchObject({ kind: 'drop', detail: { hold: 'cleared_after_window' } });
    // a hold recorded for another step is not this one's
    expect(await Holds.askHold(seq({ payment_hold_step: 0, payment_hold_since: new Date(now.getTime() - 4 * 86400000) }), { now })).toBeNull();
  });
});

describe('paymentHold', () => {

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

  test('an incomplete read holds: a bill dropped because its payer could not be resolved, or a read cut at its cap', async () => {
    mockOpenBalance.mockImplementationOnce(async (_id, { onResolveFailure }) => { onResolveFailure(new Error('payer down')); return []; });
    expect(await Holds.paymentHold('c-1', { now })).toEqual({ reason: 'payment_lookup_unavailable' });
    mockOpenBalance.mockImplementationOnce(async (_id, { onTruncation }) => { onTruncation(200); return [{ id: 'inv-ok', status: 'sent', due_date: '2026-10-10', created_at: now }]; });
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
    // only reminders a provider accepted, never the shadow rule's ambiguous rows
    expect(mockLastReminder.mock.calls[0][1]).toMatchObject({ requireDelivered: true });
  });

  test('a failed read holds (no evidence is never a clear)', async () => {
    mockOpenBalance.mockRejectedValueOnce(new Error('db down'));
    expect(await Holds.paymentHold('c-1', { now })).toEqual({ reason: 'payment_lookup_unavailable' });
  });
});
