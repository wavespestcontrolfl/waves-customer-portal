/**
 * Codex round-42 (PR #5331):
 *   1. the aggregator's recent-payments window AND failed-payment total judge ownership through the LIVE payer linkage
 *      (loadLivePayerLinkage — alias / PaymentIntent / charge / description of an invoice that resolves to a payer today),
 *      and drop live-owned rows in SQL before the over-fetch cap; an unverifiable linkage makes billing unavailable.
 *   2. every card brand a payments row can store (services/card-brands.js) is part of the claimed tender identity.
 *   3. a year the customer named is kept when the reply repeats only month and day.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-history', () => ({
  ...jest.requireActual('../services/payment-history'),
  hasInFlightMoney: jest.fn(async () => false),
}));
jest.mock('../services/payer-linkage', () => ({
  ...jest.requireActual('../services/payer-linkage'),
  loadLivePayerLinkage: jest.fn(),
}));
jest.mock('../services/payer', () => ({ ...jest.requireActual('../services/payer'), resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
jest.mock('../models/db', () => {
  const mk = (table) => {
    const q = {};
    q.table = table;
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotNull', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'leftJoin', 'join', 'count', 'andWhere', 'whereNotIn', 'modify', 'groupBy', 'distinct', 'select']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => undefined);
    const rows = () => (db.__rows[table] || []);
    q.catch = jest.fn(() => Promise.resolve(rows()));
    q.then = (res, rej) => Promise.resolve(rows()).then(res, rej);
    return q;
  };
  const queries = [];
  const db = jest.fn((table) => { const q = mk(String(table).split(' ')[0]); queries.push(q); return q; });
  db.__queries = queries;
  db.__rows = {};
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.fn = { now: jest.fn() };
  return db;
});

const db = require('../models/db');
const { buildPayerLinkage, loadLivePayerLinkage } = require('../services/payer-linkage');
const aggregator = require('../services/context-aggregator');
const { replyQuotesUngroundedAmount, paymentTenderLabel } = require('../services/sms-shadow-drafter');

const LIVE_INV = { id: '22222222-2222-4222-8222-222222222222', stripe_payment_intent_id: 'pi_live', stripe_charge_id: 'ch_live', invoice_number: 'WPC-2026-0777' };
const pay = (id, over = {}) => ({ id, amount: 50, status: 'paid', payment_date: '2026-09-1' + id.slice(-1), payer_id: null, metadata: null, description: null, ...over });
const liveLinkage = () => ({ ...buildPayerLinkage([LIVE_INV]), liveOwnedIds: new Set([LIVE_INV.id]), liveOwnedRows: [LIVE_INV] });
const build = async () => (await aggregator.getContextForCustomer({ id: 'c1', first_name: 'T', last_name: 'C', phone: '+15555550100' })).billing;
beforeEach(() => { db.__rows = {}; db.__queries.length = 0; loadLivePayerLinkage.mockResolvedValue(liveLinkage()); });

describe('round-42 #1: the aggregator reads payments through the LIVE payer linkage', () => {
  const aliasRow = pay('p1', { metadata: { waves_invoice_id: LIVE_INV.id } });
  const piRow = pay('p2', { stripe_payment_intent_id: 'pi_live' });
  const chargeRow = pay('p3', { stripe_charge_id: 'ch_live' });
  const descRow = pay('p4', { description: 'Invoice WPC-2026-0777 — zelle' });
  const own = pay('p5');

  test('live-owned rows (alias / PaymentIntent / charge / description) never reach recentPayments', async () => {
    db.__rows = { payments: [aliasRow, piRow, chargeRow, descRow, own], invoices: [] };
    const billing = await build();
    expect(loadLivePayerLinkage).toHaveBeenCalledWith('c1');
    expect(billing.recentPayments.map((p) => p.id)).toEqual(['p5']);
  });

  test('the failed-payment total skips a live-owned failure (alias linkage) and counts the homeowner\'s own', async () => {
    const failed = (id, amount, over) => ({ id, amount, status: 'failed', metadata: null, stripe_payment_intent_id: null, retry_count: 1, next_retry_at: null, ...over });
    db.__rows = { payments: [], invoices: [], failed: [] };
    // the failed ledger is the only payments read selecting retry_count; route it by whereIn(status, [...])
    const realDb = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = realDb(table);
      q.whereIn = jest.fn((col, vals) => {
        if (col === 'status' && vals.includes('failed')) { q.then = (res, rej) => Promise.resolve([failed('f1', 40, { metadata: { dispute_invoice_id: LIVE_INV.id } }), failed('f2', 25)]).then(res, rej); q.catch = jest.fn(() => Promise.resolve([])); }
        return q;
      });
      return q;
    });
    const billing = await build();
    expect(billing.outstandingBalance).toBe(25);
    db.mockImplementation(realDb);
  });

  test('live-owned payments are also excluded IN SQL (before the over-fetch cap)', async () => {
    db.__rows = { payments: [own], invoices: [] };
    await build();
    const q = db.__queries.find((x) => x.table === 'payments');
    const raws = q.whereRaw.mock.calls.map((c) => c[0]).join(' ');
    expect(raws).toMatch(/stripe_payment_intent_id NOT IN/);
    expect(raws).toMatch(/stripe_charge_id NOT IN/);
    expect(q.whereRaw.mock.calls.some((c) => (c[1] || []).includes(LIVE_INV.id))).toBe(true);
  });

  test('an unverifiable live linkage fails closed: billing is unavailable', async () => {
    loadLivePayerLinkage.mockResolvedValue({ ...buildPayerLinkage([], { failed: true }), liveOwnedIds: new Set(), liveOwnedRows: [] });
    db.__rows = { payments: [own], invoices: [] };
    const billing = await build();
    expect(billing.unavailable).toBe(true);
  });
});

describe('round-42 #2: every stored card brand is a branded tender identity', () => {
  const rowFor = (brand, id = 'r') => ({ id, amount: 100, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', card_brand: brand });
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const ungrounded = (reply, c, inbound = '') => replyQuotesUngroundedAmount(reply, c, { byMeaning: true, inboundMessage: inbound });
  const { CARD_BRANDS } = require('../services/card-brands');
  const spokenFor = (b) => b.spoken[0];

  test('every brand in the shared table: its own row grounds the claim, a Mastercard / Visa row of another brand does not', () => {
    for (const b of CARD_BRANDS) {
      const reply = `We received your $100 ${spokenFor(b)} payment from Sep 12.`;
      const other = b.id === 'visa' ? 'mastercard' : 'visa';
      expect({ brand: b.id, ownRowHeld: ungrounded(reply, ctx([rowFor(b.id)])) }).toEqual({ brand: b.id, ownRowHeld: false });
      expect({ brand: b.id, otherRowHeld: ungrounded(reply, ctx([rowFor(other)])) }).toEqual({ brand: b.id, otherRowHeld: true });
    }
  });

  test('stored spellings (upper case, spelled out, underscored) canonicalize to the same brand', () => {
    for (const [stored, spoken] of [['DISCOVER', 'Discover'], ['Diners Club', 'Diners Club'], ['DINERS', 'Diners'], ['JCB', 'JCB'], ['UnionPay', 'UnionPay'], ['AMEX', 'Amex'], ['American Express', 'American Express'], ['MASTERCARD', 'Mastercard']]) {
      const reply = `We received your $100 ${spoken} payment from Sep 12.`;
      expect({ stored, held: ungrounded(reply, ctx([rowFor(stored)])) }).toEqual({ stored, held: false });
    }
  });

  test('the Discover case from the review: a paid Mastercard row cannot ground "Your Discover card payment cleared"', () => {
    expect(ungrounded('Your $100 Discover card payment from Sep 12 cleared.', ctx([rowFor('mastercard')]))).toBe(true);
    expect(ungrounded('Your $100 Discover card payment from Sep 12 cleared.', ctx([rowFor('discover')]))).toBe(false);
  });

  test('billing-email names and the commitment tender text come from the same table', () => {
    const { cardBrandName } = require('../services/billing-email-details');
    for (const b of CARD_BRANDS) expect(cardBrandName(b.id)).toBe(b.name);
    expect(cardBrandName('diners_club')).toBe('Diners Club');
    expect(cardBrandName('american_express')).toBe('American Express');
  });

  test('the row label stays "card" for a branded card (unchanged)', () => {
    expect(paymentTenderLabel(rowFor('jcb'))).toBe('card');
  });
});

describe('round-42 #3: the inbound year survives a yearless reply date', () => {
  const row = (id, date, extra = {}) => ({ id, amount: 100, status: 'paid', payment_date: date, payment_method_type: 'card', ...extra });
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const ungrounded = (reply, c, inbound = '') => replyQuotesUngroundedAmount(reply, c, { byMeaning: true, inboundMessage: inbound });
  const reply = 'We received your $100 payment from Sep 12.';

  test('"Sep 12, 2025" asked, "Sep 12" answered: a Sep 12, 2026 row does NOT bind; the 2025 row does', () => {
    const q = 'Did my $100 payment from Sep 12, 2025 clear?';
    expect(ungrounded(reply, ctx([row('a', '2026-09-12')]), q)).toBe(true);
    expect(ungrounded(reply, ctx([row('b', '2025-09-12')]), q)).toBe(false);
    expect(ungrounded(reply, ctx([row('a', '2026-09-12'), row('b', '2025-09-12')]), q)).toBe(false);
  });
  test('a year-less inbound keeps the existing rule (any year binds); a conflicting reply year fails closed', () => {
    expect(ungrounded(reply, ctx([row('a', '2026-09-12')]), 'Did my $100 payment from Sep 12 clear?')).toBe(false);
    expect(ungrounded('We received your $100 payment from Sep 12, 2026.', ctx([row('a', '2026-09-12')]), 'Did my $100 payment from Sep 12, 2025 clear?')).toBe(true);
    expect(ungrounded('We received your $100 payment from Sep 12, 2025.', ctx([row('b', '2025-09-12')]), 'Did my $100 payment from Sep 12, 2025 clear?')).toBe(false);
  });
  test('an inbound naming Sep 12 in two different years leaves a yearless reply ambiguous (fail closed)', () => {
    const q = 'Is my $100 payment from Sep 12, 2025 or Sep 12, 2026 showing?';
    expect(ungrounded(reply, ctx([row('a', '2026-09-12')]), q)).toBe(true);
    expect(ungrounded('We received your $100 payment from Sep 12, 2026.', ctx([row('a', '2026-09-12')]), q)).toBe(false);
  });
  test('the same year rule holds at the send-time recheck (fresh context, same binder)', async () => {
    jest.resetModules();
    jest.doMock('../services/context-aggregator', () => ({ getContextForCustomer: jest.fn(), authorizedDuesCents: jest.fn(() => []) }));
    jest.doMock('../routes/pay-v2', () => ({ payPageZelleVisibility: jest.fn() }));
    jest.doMock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));
    const CA = require('../services/context-aggregator');
    const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
    const customerDb = () => () => ({ where: () => ({ first: async () => ({ id: 'c1' }) }) });
    const stale = async (rows) => {
      CA.getContextForCustomer.mockResolvedValue(ctx(rows));
      return (await amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your $100 payment from Sep 12 cleared.', strict: true, dbh: customerDb(), inboundMessage: 'Did my $100 payment from Sep 12, 2025 clear?' })).stale;
    };
    expect(await stale([row('a', '2026-09-12')])).toBe(true);
    expect(await stale([row('b', '2025-09-12')])).toBe(false);
  });
});
