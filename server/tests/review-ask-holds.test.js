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

const now = new Date('2026-10-02T14:00:00Z');
const said = (quote) => ({ ok: true, json: { says_reviewed: true, quote } });
const notSaid = { ok: true, json: { says_reviewed: false, quote: '' } };

describe('customerSaysReviewed', () => {
  test('no texts in the window: no model call', async () => {
    expect(await Holds.customerSaysReviewed('c-1', { now })).toEqual({ claim: null });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a text saying the review is posted is a claim when the model\'s quote is really in it; the window is the ask cap\'s 180 days', async () => {
    mockTables.sms_log = [{ message_body: 'Thanks Adam! Just posted it on Google', created_at: new Date('2026-10-02T15:00:00Z') }];
    mockDispatch.mockResolvedValueOnce(said('Just posted it on Google'));
    expect(await Holds.customerSaysReviewed('c-1', { now })).toEqual({ claim: { quote: 'Just posted it on Google', at: new Date('2026-10-02T15:00:00Z') } });
    const [policy, req] = mockDispatch.mock.calls[0];
    expect(policy).toBe(require('../config/models').TEXT_POLICIES.fastStructured);
    expect(req.laneId).toBe('review_ask_reviewed_claim');
    const sms = mockQueries.find((x) => x.table === 'sms_log').calls;
    expect(sms).toContainEqual(['where', 'direction', 'inbound']);
    expect(sms).toContainEqual(['where', 'created_at', '>', new Date(now.getTime() - Holds.CLAIM_WINDOW_MS)]);
  });

  test('texts are read in pages: a claim behind 40 newer texts is still found', async () => {
    mockTables.sms_log = [
      ...Array.from({ length: 45 }, (_, i) => ({ message_body: `ok thanks ${i}`, created_at: new Date(now.getTime() - i * 60000) })),
      { message_body: 'left you a review earlier', created_at: new Date(now.getTime() - 86400000) },
    ];
    mockDispatch.mockResolvedValueOnce(notSaid).mockResolvedValueOnce(said('left you a review'));
    expect(await Holds.customerSaysReviewed('c-1', { now })).toMatchObject({ claim: { quote: 'left you a review' } });
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  test('a window with more texts than are read, a quote not in the texts, or an unavailable model never stops the asks', async () => {
    mockTables.sms_log = Array.from({ length: 201 }, (_, i) => ({ message_body: `msg ${i}`, created_at: now }));
    expect(await Holds.customerSaysReviewed('c-1', { now })).toEqual({ claim: null, unavailable: true });
    expect(mockDispatch).not.toHaveBeenCalled();
    mockTables.sms_log = [{ message_body: 'The link did not work, is there another?', created_at: now }];
    mockDispatch.mockResolvedValueOnce(said('left you five stars'));
    expect(await Holds.customerSaysReviewed('c-1', { now })).toEqual({ claim: null, unavailable: true });
    mockDispatch.mockResolvedValueOnce(notSaid);
    expect(await Holds.customerSaysReviewed('c-1', { now })).toEqual({ claim: null });
    mockDispatch.mockResolvedValueOnce({ ok: false });
    expect(await Holds.customerSaysReviewed('c-1', { now })).toEqual({ claim: null, unavailable: true });
  });
});

describe('askHold', () => {
  const seq = (over = {}) => ({ id: 's-1', customer_id: 'c-1', current_step: 1, reviewed_claim: null, payment_hold_step: null, payment_hold_since: null, ...over });
  let says;
  let pay;
  beforeEach(() => {
    says = jest.spyOn(Holds, 'customerSaysReviewed').mockResolvedValue({ claim: null });
    pay = jest.spyOn(Holds, 'paymentHold').mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  test('a claim stored on the row wins without reading the texts again, while its text is inside the window', async () => {
    const at = new Date(now.getTime() - 86400000).toISOString();
    expect(await Holds.askHold(seq({ reviewed_claim: { quote: 'posted', at } }), { now })).toEqual({ kind: 'reviewed', claim: { quote: 'posted', at }, fresh: false });
    expect(says).not.toHaveBeenCalled();
    // a claim whose text is older than the window no longer counts (however recently the row changed)
    const old = new Date(now.getTime() - Holds.CLAIM_WINDOW_MS - 86400000).toISOString();
    expect(await Holds.askHold(seq({ reviewed_claim: { quote: 'posted', at: old }, updated_at: now }), { now })).toBeNull();
    expect(says).toHaveBeenCalledTimes(1);
    says.mockResolvedValueOnce({ claim: { quote: 'just posted', at: now } });
    expect(await Holds.askHold(seq(), { now })).toEqual({ kind: 'reviewed', claim: { quote: 'just posted', at: now }, fresh: true });
  });

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

describe('customerSaidReviewed (the send-time guard\'s evidence)', () => {
  const gates = require('../config/feature-gates');
  afterEach(() => jest.restoreAllMocks());

  test('expires from the customer\'s own text time, never from when the row last changed; switch off reads nothing', async () => {
    jest.spyOn(gates, 'isEnabled').mockImplementation((g) => g === 'reviewAskTechVoice');
    const raws = [];
    const q = { where: () => q, whereNotNull: () => q, whereRaw: (sql, b) => { raws.push([sql, b]); return q; }, first: async () => null };
    expect(await Holds.customerSaidReviewed('c-1', { database: () => q, now })).toBe(false);
    expect(raws).toEqual([["(reviewed_claim->>'at')::timestamptz > ?", [new Date(now.getTime() - Holds.CLAIM_WINDOW_MS)]]]);
    gates.isEnabled.mockReturnValue(false);
    const untouched = jest.fn();
    expect(await Holds.customerSaidReviewed('c-1', { database: untouched, now })).toBe(false);
    expect(untouched).not.toHaveBeenCalled();
  });
});
